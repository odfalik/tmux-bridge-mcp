/**
 * HTTP transport for remote callers (e.g. a QM agent sandbox reaching in over Tailscale).
 *
 * This is deliberately NOT a REST mirror of the MCP tool surface. The MCP tools are a
 * local, pane-to-pane bus for agents that share a tmux server; a remote caller wants
 * intent ("ask this thing and give me the answer"), not transport primitives. So the six
 * low-level verbs collapse to three endpoints, and the pane-level operations stay
 * unreachable from the network:
 *
 *   GET  /health   liveness + tmux reachability
 *   GET  /targets  what can be asked, and what cannot
 *   POST /ask      ask a live agent pane, or run one headless
 *
 * Two safety properties fall out of that shape rather than from configuration:
 *
 *   1. /ask only accepts targets that /targets marked askable, and a pane is only
 *      askable when it is running a known agent binary. Sending text to a shell would
 *      execute it — here there is no endpoint that can reach a shell pane at all.
 *   2. The read-guard that tmux_message requires is enforced server-side, so a remote
 *      caller cannot skip it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as bridge from "./tmux-bridge.js";

const execFileAsync = promisify(execFile);

export interface HttpOptions {
  /** Interface to bind. Default 127.0.0.1 — set to the Tailscale IP in production. */
  host: string;
  port: number;
  /**
   * Tailscale tag required of callers, e.g. "tag:qm-personal". When set, every request
   * is checked with `tailscale whois`; a caller without the tag is refused. Layered
   * under the tailnet ACL so an ACL mistake fails closed instead of open.
   */
  requireTag?: string;
  /** pane_current_command values considered agents, and therefore askable. */
  agentProcesses: string[];
  /** Sender shown to the receiving agent, so it can see the request came from off-machine. */
  senderLabel: string;
  /**
   * Prepended to pane asks. Without it agents try to tmux_message a reply back and
   * find no sender pane, because the caller is off-machine — wasted turns and a
   * confused answer. The bridge reads their pane, so they should just answer there.
   */
  askPreamble: string;
  /** Command used for headless asks (no target). */
  headlessCommand: string;
  defaultTimeoutMs: number;
}

export const DEFAULT_OPTIONS: HttpOptions = {
  host: process.env.TMUX_BRIDGE_HTTP_HOST || "127.0.0.1",
  port: Number(process.env.TMUX_BRIDGE_HTTP_PORT || 8787),
  requireTag: process.env.TMUX_BRIDGE_REQUIRE_TAG || undefined,
  agentProcesses: (process.env.TMUX_BRIDGE_AGENT_PROCESSES || "claude,codex")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  senderLabel: process.env.TMUX_BRIDGE_SENDER_LABEL || "qm-personal (cloud)",
  askPreamble:
    process.env.TMUX_BRIDGE_ASK_PREAMBLE ??
    "[Answer in this pane — the bridge reads your output. There is no sender pane to " +
      "message back, so do not try to route a reply. Be brief and do not start new work " +
      "unless asked.]",
  headlessCommand: process.env.TMUX_BRIDGE_HEADLESS_CMD || "claude",
  defaultTimeoutMs: Number(process.env.TMUX_BRIDGE_TIMEOUT_MS || 120_000),
};

export interface Target {
  name: string;
  target: string;
  kind: "tmux";
  agent: string;
  cwd: string;
  askable: boolean;
  /** Present when askable is false, so the caller learns why rather than guessing. */
  reason?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** TUI furniture that is not part of an answer. */
const CHROME = [
  /^[\s─-╿]+$/, // box-drawing rules
  /^\s*[❯>]\s/, // the input prompt
  /\d+%\s*context/i,
  /bypass permissions|shift\+tab|for agents|esc to interrupt/i,
  /^\s*[✳✴✻✹✵·*]\s*\w+(?:ed|ing)?\s+for\s+\d+/i, // "Cogitated for 1s"
  /^\s*⏺?\s*$/,
];

/**
 * Pull the agent's answer out of a pane capture.
 *
 * The capture is a live TUI, so it carries rules, the prompt, spinner lines and a status
 * bar alongside the actual reply. We take everything after the correlated header and drop
 * anything that is recognisably furniture; what remains is what the agent said.
 */
export function cleanReply(afterMarker: string): string {
  const lines = afterMarker.split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      if (out.length) out.push("");
      continue;
    }
    if (CHROME.some((re) => re.test(line))) {
      // Chrome after we already have content means the answer has ended.
      if (out.length) break;
      continue;
    }
    out.push(line.replace(/^\s*⏺\s*/, "").trimEnd());
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** One row of the process table, as `ps -axo pid=,ppid=,comm=` gives it. */
export interface ProcRow {
  pid: string;
  ppid: string;
  /** Basename, for display. */
  comm: string;
  /** Full command as ps reported it — agent matching uses this. */
  raw: string;
}

export function parseProcTable(psOutput: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const raw = m[3].trim();
    const comm = (raw.split("/").pop() || raw).replace(/^-/, "");
    rows.push({ pid: m[1], ppid: m[2], comm, raw });
  }
  return rows;
}

/**
 * Find the agent a pane is running, given the pane's own pid.
 *
 * Two things make the obvious lookups wrong:
 *   - `pane_current_command` reports Claude Code's *version* ("2.1.220"), because it
 *     sets its process title.
 *   - `pane_pid` is usually the pane's shell, with the agent running as a child of it.
 *     It is only the agent itself when the pane was launched with the agent as its
 *     command.
 * So we walk the pane pid's descendants and return the first process whose comm looks
 * like a known agent; failing that, the pane's own comm.
 */
export function findAgentForPane(
  panePid: string,
  rows: ProcRow[],
  agentProcesses: string[],
  maxDepth = 4
): string | undefined {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const children = new Map<string, ProcRow[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r);
    else children.set(r.ppid, [r]);
  }
  const isAgent = (row: ProcRow) =>
    agentProcesses.some((a) => `${row.raw} ${row.comm}`.toLowerCase().includes(a.toLowerCase()));

  let frontier = [panePid];
  for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const pid of frontier) {
      const row = byPid.get(pid);
      // Report the matched agent name rather than the versioned basename.
      if (row && isAgent(row))
        return agentProcesses.find((a) =>
          `${row.raw} ${row.comm}`.toLowerCase().includes(a.toLowerCase())
        ) ?? row.comm;
      for (const child of children.get(pid) ?? []) next.push(child.pid);
    }
    frontier = next;
  }
  return byPid.get(panePid)?.comm;
}

/** Map pane id -> the command actually running in it (agent if one is found). */
async function paneCommands(agentProcesses: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const [{ stdout: panesOut }, { stdout: psOut }] = await Promise.all([
      execFileAsync("tmux", ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"], {
        timeout: 5000,
      }),
      execFileAsync("ps", ["-axo", "pid=,ppid=,comm="], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }),
    ]);
    const rows = parseProcTable(psOut);
    for (const line of panesOut.trim().split("\n").filter(Boolean)) {
      const [paneId, panePid] = line.split("\t");
      const comm = findAgentForPane(panePid, rows, agentProcesses);
      if (comm) out.set(paneId, comm);
    }
  } catch {
    // fall back to pane_current_command
  }
  return out;
}

/**
 * A pane is askable only when it runs a known agent. Everything else — shells above
 * all — is listed but refused, because messaging a shell submits the text to it.
 */
export function classifyPanes(
  panes: bridge.PaneInfo[],
  agentProcesses: string[],
  commands: Map<string, string> = new Map()
): Target[] {
  return panes.map((p) => {
    const resolved = commands.get(p.target) || p.process || "";
    const agent = resolved.toLowerCase();
    const isAgent = agentProcesses.some((a) => agent.includes(a.toLowerCase()));
    return {
      name: p.windowName || p.sessionWindow,
      target: p.target,
      kind: "tmux" as const,
      agent: resolved || "?",
      cwd: p.cwd,
      askable: isAgent,
      ...(isAgent ? {} : { reason: `process "${resolved}" is not a known agent` }),
    };
  });
}

async function currentTargets(opts: HttpOptions): Promise<Target[]> {
  const [panes, commands] = await Promise.all([
    bridge.list(),
    paneCommands(opts.agentProcesses),
  ]);
  return classifyPanes(panes, opts.agentProcesses, commands);
}

/** Caller identity, via Tailscale. Returns null when it cannot be established. */
async function whoisTags(remoteAddr: string): Promise<string[] | null> {
  const ip = remoteAddr.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
  try {
    const { stdout } = await execFileAsync("tailscale", ["whois", "--json", ip], {
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout) as { Node?: { Tags?: string[] } };
    return parsed.Node?.Tags ?? [];
  } catch {
    return null;
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limitBytes = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Send to a live agent pane and wait for its answer.
 *
 * The correlation id that `message` stamps into the header is what delimits the reply:
 * everything the pane prints after that marker is the response. Polling stops once the
 * pane has been quiet for a beat, so we return a settled answer rather than a partial one.
 */
async function askPane(
  target: string,
  text: string,
  opts: HttpOptions,
  timeoutMs: number
): Promise<{ correlationId: string; reply: string; timedOut: boolean }> {
  await bridge.read(target, 5); // satisfies the read guard, server-side
  const payload = opts.askPreamble ? `${opts.askPreamble}\n\n${text}` : text;
  const correlationId = await bridge.message(target, payload, { from: opts.senderLabel });

  const deadline = Date.now() + timeoutMs;
  const marker = `id:${correlationId}`;
  let lastReply = "";
  let stableFor = 0;

  while (Date.now() < deadline) {
    await sleep(1500);
    const pane = await bridge.read(target, 400);
    const idx = pane.lastIndexOf(marker);
    if (idx === -1) continue;

    // Everything after the header line that carries our id, minus the TUI furniture.
    // The echoed prompt can wrap onto following lines, so skip until a blank line.
    const after = pane.slice(idx);
    const firstBlank = after.search(/\n\s*\n/);
    const body = firstBlank === -1 ? "" : after.slice(firstBlank);
    const reply = cleanReply(body);
    if (!reply) continue;

    if (reply === lastReply) {
      stableFor += 1500;
      if (stableFor >= 3000) return { correlationId, reply, timedOut: false };
    } else {
      lastReply = reply;
      stableFor = 0;
    }
  }
  return { correlationId, reply: lastReply, timedOut: true };
}

/** Run a fresh headless agent. No pane, no polling, no correlation matching. */
async function askHeadless(
  text: string,
  opts: HttpOptions,
  timeoutMs: number
): Promise<{ reply: string; timedOut: boolean }> {
  try {
    const { stdout } = await execFileAsync(opts.headlessCommand, ["-p", text], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { reply: stdout.trim(), timedOut: false };
  } catch (e) {
    const err = e as { killed?: boolean; stdout?: string; message?: string };
    if (err.killed) return { reply: (err.stdout || "").trim(), timedOut: true };
    throw new Error(err.message || String(e));
  }
}

export function createHttpServer(options: Partial<HttpOptions> = {}) {
  const opts: HttpOptions = { ...DEFAULT_OPTIONS, ...options };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (opts.requireTag && path !== "/health") {
        const tags = await whoisTags(req.socket.remoteAddress || "");
        if (tags === null) {
          return json(res, 403, { error: "caller identity could not be established" });
        }
        if (!tags.includes(opts.requireTag)) {
          return json(res, 403, { error: `caller lacks required tag ${opts.requireTag}` });
        }
      }

      if (req.method === "GET" && path === "/health") {
        let tmuxOk = true;
        try {
          await bridge.list();
        } catch {
          tmuxOk = false;
        }
        return json(res, tmuxOk ? 200 : 503, {
          ok: tmuxOk,
          tmux: tmuxOk ? "reachable" : "unreachable",
          requireTag: opts.requireTag ?? null,
        });
      }

      if (req.method === "GET" && path === "/targets") {
        const targets = await currentTargets(opts);
        return json(res, 200, {
          targets,
          headless: { kind: "headless", available: true, command: opts.headlessCommand },
        });
      }

      if (req.method === "POST" && path === "/ask") {
        const body = (await readBody(req)) as {
          target?: string;
          text?: string;
          timeoutMs?: number;
        };
        if (!body.text || typeof body.text !== "string") {
          return json(res, 400, { error: "text is required" });
        }
        const timeoutMs = Math.min(Math.max(body.timeoutMs ?? opts.defaultTimeoutMs, 1000), 600_000);

        if (!body.target) {
          const out = await askHeadless(body.text, opts, timeoutMs);
          return json(res, 200, { kind: "headless", ...out });
        }

        const targets = await currentTargets(opts);
        // A pane id is unambiguous; a window name may not be. Refuse rather than guess,
        // since guessing means delivering an instruction to the wrong agent.
        const byId = targets.find((t) => t.target === body.target);
        const byName = targets.filter((t) => t.name === body.target);
        if (!byId && byName.length > 1) {
          return json(res, 409, {
            error: `target "${body.target}" is ambiguous — ${byName.length} panes share that window name`,
            candidates: byName.map((t) => ({ target: t.target, cwd: t.cwd, askable: t.askable })),
            hint: "ask by pane id instead",
          });
        }
        const match = byId ?? byName[0];
        if (!match) {
          return json(res, 404, {
            error: `no such target "${body.target}"`,
            askable: targets.filter((t) => t.askable).map((t) => t.name),
          });
        }
        if (!match.askable) {
          return json(res, 403, { error: `target "${body.target}" is not askable`, reason: match.reason });
        }

        const out = await askPane(match.target, body.text, opts, timeoutMs);
        return json(res, 200, { kind: "tmux", target: match.name, ...out });
      }

      return json(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  return {
    server,
    options: opts,
    listen: () =>
      new Promise<void>((resolve) => {
        server.listen(opts.port, opts.host, () => {
          const tag = opts.requireTag ? ` requiring ${opts.requireTag}` : " (NO tag check)";
          console.error(`tmux-bridge http on ${opts.host}:${opts.port}${tag}`);
          resolve();
        });
      }),
  };
}

export async function startHttpServer(options: Partial<HttpOptions> = {}): Promise<void> {
  const { listen } = createHttpServer(options);
  await listen();
}
