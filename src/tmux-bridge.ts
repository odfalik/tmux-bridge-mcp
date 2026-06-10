/**
 * tmux-bridge core — direct tmux interaction via child_process.
 * No external CLI dependencies (no smux, no tmux-bridge CLI).
 * Only requires `tmux` to be installed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// --- Read Guard ---
// Enforces read-before-act: agents must read a pane before typing/keys.

const readGuardDir = join(tmpdir(), "tmux-bridge-guards");

function guardPath(paneId: string): string {
  return join(readGuardDir, paneId.replace(/%/g, "_"));
}

export function markRead(paneId: string): void {
  try {
    if (!existsSync(readGuardDir)) {
      mkdirSync(readGuardDir, { recursive: true });
    }
    writeFileSync(guardPath(paneId), "", { flag: "w" });
  } catch {
    // Best-effort
  }
}

export function requireRead(paneId: string): void {
  if (!existsSync(guardPath(paneId))) {
    throw new Error(
      `Must read pane ${paneId} before interacting. Call tmux_read first.`
    );
  }
}

export function clearRead(paneId: string): void {
  try {
    unlinkSync(guardPath(paneId));
  } catch {
    // Already cleared
  }
}

// --- tmux socket detection ---

function detectSocketArgs(): string[] {
  const override = process.env.TMUX_BRIDGE_SOCKET;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`TMUX_BRIDGE_SOCKET=${override} is not a valid socket`);
    }
    return ["-S", override];
  }

  const tmuxEnv = process.env.TMUX;
  if (tmuxEnv) {
    const socket = tmuxEnv.split(",")[0];
    if (socket && existsSync(socket)) {
      return ["-S", socket];
    }
  }

  // Default tmux server
  return [];
}

async function tmux(...args: string[]): Promise<string> {
  const socketArgs = detectSocketArgs();
  const { stdout } = await execFileAsync("tmux", [...socketArgs, ...args], {
    timeout: 10_000,
    env: { ...process.env },
  });
  return stdout;
}

async function tmuxNoFail(...args: string[]): Promise<string> {
  try {
    return await tmux(...args);
  } catch {
    return "";
  }
}

// --- Target Resolution ---
// Supports explicit tmux targets (pane ID, session:win.pane, window index).
// Non-explicit targets resolve globally by tmux window name first, then legacy
// @name labels. Grouped sessions can list the same pane more than once, so
// candidate matching deduplicates by pane ID before deciding uniqueness.

export interface TmuxPaneRecord {
  paneId: string;
  sessionName: string;
  windowIndex: string;
  windowName: string;
  paneIndex: string;
  paneDead: string;
  command: string;
  label: string;
  cwd: string;
}

const LIST_PANES_FORMAT =
  "#{pane_id}|#{session_name}|#{window_index}|#{window_name}|#{pane_index}|#{pane_dead}|#{pane_current_command}|#{@name}|#{pane_current_path}";

function isExplicitTmuxTarget(target: string): boolean {
  if (/^%\d+$/.test(target)) return true;
  if (target.includes(":") || target.includes(".")) return true;
  return /^\d+$/.test(target);
}

export function parsePaneRecords(output: string): TmuxPaneRecord[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [
        paneId,
        sessionName,
        windowIndex,
        windowName,
        paneIndex,
        paneDead,
        command,
        label,
        cwd,
      ] = line.split("|");

      return {
        paneId,
        sessionName,
        windowIndex,
        windowName,
        paneIndex,
        paneDead,
        command,
        label,
        cwd,
      };
    });
}

function dedupeLivePanes(panes: TmuxPaneRecord[]): TmuxPaneRecord[] {
  const byPaneId = new Map<string, TmuxPaneRecord>();
  for (const pane of panes) {
    if (!pane.paneId || pane.paneDead === "1") continue;
    if (!byPaneId.has(pane.paneId)) {
      byPaneId.set(pane.paneId, pane);
    }
  }
  return [...byPaneId.values()];
}

function candidateLine(pane: TmuxPaneRecord): string {
  const sessionTarget = `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`;
  return [
    pane.paneId,
    sessionTarget,
    `window:${pane.windowName || "(none)"}`,
    `process:${pane.command || "?"}`,
    `label:${pane.label || "(none)"}`,
  ].join(" | ");
}

export function resolvePaneFromRecords(
  target: string,
  records: TmuxPaneRecord[]
): string {
  const panes = dedupeLivePanes(records);

  for (const [field, name] of [
    ["windowName", "window name"],
    ["label", "label"],
  ] as const) {
    const matches = panes.filter((pane) => pane[field] === target);
    if (matches.length === 1) return matches[0].paneId;
    if (matches.length > 1) {
      const candidates = matches.map(candidateLine).join("\n");
      throw new Error(
        `Ambiguous tmux ${name} '${target}' matched multiple live panes:\n${candidates}`
      );
    }
  }

  throw new Error(`No live pane found with window name or label '${target}'`);
}

async function listPaneRecords(): Promise<TmuxPaneRecord[]> {
  const output = await tmux("list-panes", "-a", "-F", LIST_PANES_FORMAT);
  return parsePaneRecords(output);
}

async function resolveTarget(target: string): Promise<string> {
  if (isExplicitTmuxTarget(target)) return target;
  return resolvePaneFromRecords(target, await listPaneRecords());
}

async function validateTarget(target: string): Promise<void> {
  try {
    await tmux("display-message", "-t", target, "-p", "#{pane_id}");
  } catch {
    throw new Error(`Invalid target: ${target}`);
  }
}

async function getPaneId(target: string): Promise<string> {
  const output = await tmux(
    "display-message",
    "-t",
    target,
    "-p",
    "#{pane_id}"
  );
  return output.trim();
}

// --- Loop Prevention ---

function assertNotSelf(paneId: string, action: string): void {
  const self = process.env.TMUX_PANE;
  if (self && paneId === self) {
    if (action === "message") {
      throw new Error("Cannot send message to your own pane (loop prevention)");
    }
    throw new Error("Cannot interact with your own pane");
  }
}

// --- Public API ---

export interface PaneInfo {
  target: string;
  sessionWindow: string;
  size: string;
  process: string;
  label: string;
  cwd: string;
}

export async function list(): Promise<PaneInfo[]> {
  const output = await tmux(
    "list-panes",
    "-a",
    "-F",
    `${LIST_PANES_FORMAT}|#{pane_width}x#{pane_height}`
  );

  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [
        target,
        sessionName,
        windowIndex,
        _windowName,
        _paneIndex,
        _paneDead,
        cmd,
        label,
        cwd,
        size,
      ] =
        line.split("|");
      const home = process.env.HOME || "";
      return {
        target,
        sessionWindow: `${sessionName}:${windowIndex}`,
        size,
        process: cmd || "?",
        label: label || "",
        cwd: home && cwd ? cwd.replace(home, "~") : (cwd || ""),
      };
    });
}

export async function read(target: string, lines: number = 50): Promise<string> {
  const resolved = await resolveTarget(target);
  await validateTarget(resolved);
  const paneId = await getPaneId(resolved);

  const output = await tmux(
    "capture-pane",
    "-t",
    resolved,
    "-p",
    "-J",
    "-S",
    `-${lines}`
  );

  markRead(paneId);
  return output;
}

export async function type(target: string, text: string): Promise<void> {
  const resolved = await resolveTarget(target);
  await validateTarget(resolved);
  const paneId = await getPaneId(resolved);
  assertNotSelf(paneId, "type");
  requireRead(paneId);

  await tmux("send-keys", "-t", resolved, "-l", "--", text);
  clearRead(paneId);
}

export async function message(
  target: string,
  text: string
): Promise<void> {
  const resolved = await resolveTarget(target);
  await validateTarget(resolved);
  const paneId = await getPaneId(resolved);
  assertNotSelf(paneId, "message");
  requireRead(paneId);

  // Detect sender identity
  const senderPane = process.env.TMUX_PANE || "unknown";
  const senderLabel = await tmuxNoFail(
    "display-message",
    "-t",
    senderPane,
    "-p",
    "#{@name}"
  );
  const from = senderLabel.trim() || senderPane;

  const correlationId = randomUUID().slice(0, 8);
  const header = `[tmux-bridge from:${from} pane:${senderPane} id:${correlationId}]`;
  await tmux("send-keys", "-t", resolved, "-l", "--", `${header} ${text}`);
  clearRead(paneId);
}

export async function keys(
  target: string,
  ...keyList: string[]
): Promise<void> {
  const resolved = await resolveTarget(target);
  await validateTarget(resolved);
  const paneId = await getPaneId(resolved);
  assertNotSelf(paneId, "keys");
  requireRead(paneId);

  for (const key of keyList) {
    await tmux("send-keys", "-t", resolved, key);
  }
  clearRead(paneId);
}

export async function name(target: string, label: string): Promise<void> {
  const resolved = await resolveTarget(target);
  await validateTarget(resolved);
  await tmux("set-option", "-p", "-t", resolved, "@name", label);
}

export async function resolve(label: string): Promise<string> {
  return resolveTarget(label);
}

export async function id(): Promise<string> {
  const pane = process.env.TMUX_PANE;
  if (!pane) throw new Error("Not running inside a tmux pane ($TMUX_PANE is unset)");
  return pane;
}

// --- Sensible Defaults ---
// Applied at startup so tmux feels like a normal terminal out of the box.
// Uses runtime set-option (no file writes), safe to call multiple times.

export async function applyDefaults(): Promise<string[]> {
  const applied: string[] = [];

  const defaults: Array<[string[], string]> = [
    // Mouse scroll, click, and drag — feels like a normal terminal
    [["set-option", "-g", "mouse", "on"], "mouse on"],
    // Long scrollback so conversation history isn't lost
    [["set-option", "-g", "history-limit", "100000"], "history-limit 100000"],
    // Vi keys in copy mode for efficient scrolling (k/j, Ctrl-u/d, g/G)
    [["set-option", "-g", "mode-keys", "vi"], "mode-keys vi"],
  ];

  for (const [args, label] of defaults) {
    try {
      await tmux(...args);
      applied.push(label);
    } catch {
      // Non-fatal — keep going
    }
  }

  return applied;
}

export async function doctor(): Promise<string> {
  const lines: string[] = ["tmux-bridge doctor", "---"];
  let hasErrors = false;

  lines.push(`TMUX_PANE:          ${process.env.TMUX_PANE || "<unset>"}`);
  lines.push(`TMUX:               ${process.env.TMUX || "<unset>"}`);
  lines.push(
    `TMUX_BRIDGE_SOCKET: ${process.env.TMUX_BRIDGE_SOCKET || "<unset>"}`
  );

  // Check tmux binary
  try {
    const ver = await tmux("-V");
    lines.push(`tmux version:       ${ver.trim()}`);
  } catch {
    lines.push(`tmux:               NOT FOUND`);
    lines.push("---");
    lines.push("Status: FAILED — tmux is not installed");
    return lines.join("\n");
  }

  // Socket detection
  lines.push("---");
  try {
    const socketArgs = detectSocketArgs();
    lines.push(
      `Socket:             ${socketArgs.length ? socketArgs[1] : "(default)"}`
    );
  } catch (e) {
    hasErrors = true;
    lines.push(`Socket:             FAILED — ${(e as Error).message}`);
  }

  // Pane count
  try {
    const output = await tmux("list-panes", "-a", "-F", "#{pane_id}");
    const count = output.trim().split("\n").filter(Boolean).length;
    lines.push(`Total panes:        ${count}`);

    const labeled = await tmux("list-panes", "-a", "-F", "#{@name}");
    const labeledCount = labeled
      .trim()
      .split("\n")
      .filter((l) => l.trim()).length;
    lines.push(`Labeled panes:      ${labeledCount}`);
  } catch {
    hasErrors = true;
    lines.push(`Panes:              unable to list`);
  }

  // Current pane visibility
  const pane = process.env.TMUX_PANE;
  if (pane) {
    try {
      await tmux("display-message", "-t", pane, "-p", "#{pane_id}");
      lines.push(`This pane (${pane}):  visible to server`);
    } catch {
      hasErrors = true;
      lines.push(`This pane (${pane}):  NOT visible to server`);
    }
  }

  // Show applied defaults
  lines.push("---");
  try {
    const mouse = (await tmuxNoFail("show-option", "-gv", "mouse")).trim();
    const histLimit = (await tmuxNoFail("show-option", "-gv", "history-limit")).trim();
    const modeKeys = (await tmuxNoFail("show-option", "-gv", "mode-keys")).trim();
    lines.push(`mouse:              ${mouse || "?"}`);
    lines.push(`history-limit:      ${histLimit || "?"}`);
    lines.push(`mode-keys:          ${modeKeys || "?"}`);
  } catch {
    lines.push(`Defaults:           unable to query`);
  }

  lines.push("---");
  lines.push(hasErrors ? "Status: DEGRADED — some checks failed" : "Status: OK");
  return lines.join("\n");
}
