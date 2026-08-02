/**
 * The six verbs, once.
 *
 * Both transports — MCP over stdio (src/index.ts) and HTTP (src/http.ts) — expose the
 * same tools, so what a verb *does* (and the exact text it produces) lives here. Each
 * transport is left with nothing but its own framing: MCP content blocks there, JSON
 * and status codes here. Anything that renders output in only one of them is a place
 * the two surfaces can drift, so it belongs in this file instead.
 */
import * as bridge from "./tmux-bridge.js";

/** tmux_read's default when the caller omits `lines`. */
export const DEFAULT_READ_LINES = 50;

export interface ListResult {
  panes: bridge.PaneInfo[];
  /** One line per pane, as tmux_list renders it. */
  text: string;
}

export async function list(): Promise<ListResult> {
  const panes = await bridge.list();
  const text = panes
    .map(
      (p) =>
        `${p.target} | ${p.sessionWindow} | window:${p.windowName || "(none)"} | ${p.process} | ${p.cwd}`
    )
    .join("\n");
  return { panes, text: text || "No panes found" };
}

export interface ReadResult {
  /** Canonical pane ID the target resolved to. */
  paneId: string;
  /** Raw pane capture. */
  text: string;
}

export async function read(
  target: string,
  lines: number = DEFAULT_READ_LINES
): Promise<ReadResult> {
  // Resolve first so callers learn which pane they actually read — the HTTP read guard
  // keys on it, and a window name can resolve to a different pane between calls.
  const paneId = await bridge.paneIdFor(target);
  const text = await bridge.read(paneId, lines);
  return { paneId, text };
}

export interface MessageResult {
  paneId: string;
  /** ID stamped into the message header, for correlating the reply. */
  correlationId: string;
  /** Confirmation, as tmux_message renders it. */
  text: string;
}

export async function message(
  target: string,
  text: string,
  opts: bridge.MessageOptions = {}
): Promise<MessageResult> {
  const paneId = await bridge.paneIdFor(target);
  const correlationId = await bridge.message(paneId, text, opts);
  return {
    paneId,
    correlationId,
    text: `Message sent and submitted to ${target}`,
  };
}

/** Target ID for a canonical tmux window name. Explicit targets pass through unchanged. */
export async function resolve(target: string): Promise<string> {
  return bridge.resolve(target);
}

/** This server's own tmux pane ID. */
export async function id(): Promise<string> {
  return bridge.id();
}

/** tmux connectivity diagnosis, as a text report. */
export async function doctor(): Promise<string> {
  return bridge.doctor();
}
