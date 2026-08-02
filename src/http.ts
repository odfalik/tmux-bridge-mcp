/**
 * HTTP transport — a 1:1 mirror of the MCP tool surface, for remote callers (e.g. a QM
 * agent sandbox reaching in over Tailscale).
 *
 *   GET  /list                        tmux_list
 *   GET  /read?target=&lines=         tmux_read
 *   POST /message  {target, text}     tmux_message
 *   GET  /resolve?target=             tmux_resolve
 *   GET  /id                          tmux_id
 *   GET  /doctor                      tmux_doctor
 *
 * Plus GET /health, which is *not* a mirrored verb: it is infrastructural liveness for
 * monitoring and for checking the tag configuration, has no MCP counterpart, and claims
 * none. It is the only route exempt from the tag check, so a monitor can reach it.
 *
 * Every verb delegates to src/tools.ts, the same functions the stdio server calls, so
 * the two transports cannot drift. This file adds only HTTP framing: parameter parsing,
 * JSON bodies, and status codes for the failures that stdio reports as text.
 *
 * The read guard is the one thing HTTP has to implement itself. tmux_message requires a
 * prior tmux_read of the same pane — a safety property, not a formality: it forces a
 * caller to look at what it is about to type into. Over stdio that state is a file the
 * server process owns. HTTP has no session, so we keep it here, keyed by
 * (caller address, pane ID) with a TTL, and consume it on a successful send exactly as
 * the stdio guard is cleared after each message. Unsatisfied is 409, never a silent skip.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as bridge from "./tmux-bridge.js";
import * as tools from "./tools.js";

const execFileAsync = promisify(execFile);

export interface HttpOptions {
  /** Interface to bind. Default 127.0.0.1 — set to the Tailscale IP in production. */
  host: string;
  port: number;
  /**
   * Tailscale tag required of callers, e.g. "tag:qm-personal". When set, every request
   * except /health is checked with `tailscale whois`; a caller without the tag is
   * refused. Layered under the tailnet ACL so an ACL mistake fails closed instead of open.
   */
  requireTag?: string;
  /**
   * Sender shown to the receiving agent. An HTTP caller has no pane of its own, so
   * without this the message header would name the bridge process instead of whoever
   * actually sent it.
   */
  senderLabel: string;
  /** How long a GET /read keeps POST /message unlocked for that caller and pane. */
  readGuardTtlMs: number;
}

export const DEFAULT_OPTIONS: HttpOptions = {
  host: process.env.TMUX_BRIDGE_HTTP_HOST || "127.0.0.1",
  port: Number(process.env.TMUX_BRIDGE_HTTP_PORT || 8787),
  requireTag: process.env.TMUX_BRIDGE_REQUIRE_TAG || undefined,
  senderLabel: process.env.TMUX_BRIDGE_SENDER_LABEL || "qm-personal (cloud)",
  readGuardTtlMs: Number(process.env.TMUX_BRIDGE_READ_GUARD_TTL_MS || 5 * 60_000),
};

/**
 * Per-caller read guard.
 *
 * Keyed on the pane ID rather than the target string, so reading a pane by window name
 * and then messaging it by ID (or the reverse) is one grant, and so a name that has
 * since moved to another pane does not carry the grant with it. Keyed on the caller too:
 * one client's read must not unlock a send for everybody else on the tailnet.
 *
 * `now` is injectable purely so the TTL is testable without sleeping.
 */
export class ReadGuard {
  private grants = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  private static key(client: string, paneId: string): string {
    return `${client} ${paneId}`;
  }

  /** Record that `client` has read `paneId`. */
  mark(client: string, paneId: string, now: number = Date.now()): void {
    this.prune(now);
    this.grants.set(ReadGuard.key(client, paneId), now + this.ttlMs);
  }

  isSatisfied(client: string, paneId: string, now: number = Date.now()): boolean {
    const expiresAt = this.grants.get(ReadGuard.key(client, paneId));
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.grants.delete(ReadGuard.key(client, paneId));
      return false;
    }
    return true;
  }

  /** Spend the grant. Each message needs its own read, as it does over stdio. */
  consume(client: string, paneId: string): void {
    this.grants.delete(ReadGuard.key(client, paneId));
  }

  /** Drop expired grants. Cheap, and it runs on write, so the map cannot grow unbounded. */
  prune(now: number = Date.now()): void {
    for (const [key, expiresAt] of this.grants) {
      if (expiresAt <= now) this.grants.delete(key);
    }
  }

  get size(): number {
    return this.grants.size;
  }
}

/** Normalised caller address — the identity the read guard is keyed on. */
export function clientIdentity(req: IncomingMessage): string {
  const addr = req.socket.remoteAddress || "unknown";
  return addr.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
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

/** The caller sent something malformed — 400, not a server fault. */
class BadRequestError extends Error {}

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
    if (size > limitBytes) throw new BadRequestError("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Map a bridge failure onto a status code.
 *
 * The bridge throws typed errors for exactly the cases a remote caller has to tell
 * apart, so this stays a lookup rather than string sniffing. Ambiguity carries the
 * candidate pane IDs out with it: the caller has to pick, and it cannot pick blind.
 */
export function failure(e: unknown): { status: number; body: Record<string, unknown> } {
  const error = e instanceof Error ? e.message : String(e);

  // Malformed query parameter, oversized body, or unparseable JSON.
  if (e instanceof BadRequestError || e instanceof SyntaxError) {
    return { status: 400, body: { error } };
  }
  if (e instanceof bridge.AmbiguousTargetError) {
    return {
      status: 409,
      body: {
        error,
        candidates: e.candidates,
        hint: "retry with a pane ID (%N) — the bridge will not guess between panes",
      },
    };
  }
  if (e instanceof bridge.TargetNotFoundError) return { status: 404, body: { error } };
  if (e instanceof bridge.LoopPreventionError) return { status: 403, body: { error } };
  // Only reachable if the process-wide guard was cleared under us; the per-caller guard
  // below answers first in the normal case.
  if (e instanceof bridge.ReadGuardError) {
    return { status: 409, body: { error, hint: "GET /read?target=... first" } };
  }
  return { status: 500, body: { error } };
}

/** Positive-integer query parameter, or undefined when absent. Throws on garbage. */
function intParam(raw: string | null, name: string): number | undefined {
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new BadRequestError(`${name} must be a positive integer`);
  }
  return value;
}

export function createHttpServer(options: Partial<HttpOptions> = {}) {
  const opts: HttpOptions = { ...DEFAULT_OPTIONS, ...options };
  const guard = new ReadGuard(opts.readGuardTtlMs);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const client = clientIdentity(req);

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

      // Not an MCP verb — liveness only. See the file header.
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

      if (req.method === "GET" && path === "/list") {
        const { panes, text } = await tools.list();
        return json(res, 200, { panes, text });
      }

      if (req.method === "GET" && path === "/read") {
        const target = url.searchParams.get("target");
        if (!target) return json(res, 400, { error: "target is required" });
        const lines = intParam(url.searchParams.get("lines"), "lines") ?? tools.DEFAULT_READ_LINES;

        const { paneId, text } = await tools.read(target, lines);
        // The read that unlocks POST /message for this caller and this pane.
        guard.mark(client, paneId);
        return json(res, 200, { target, paneId, lines, text });
      }

      if (req.method === "POST" && path === "/message") {
        const body = (await readBody(req)) as { target?: unknown; text?: unknown };
        if (typeof body.target !== "string" || !body.target) {
          return json(res, 400, { error: "target is required" });
        }
        if (typeof body.text !== "string" || !body.text) {
          return json(res, 400, { error: "text is required" });
        }

        // Resolve before the guard check so a window name and a pane ID are the same key.
        const paneId = await bridge.paneIdFor(body.target);
        if (!guard.isSatisfied(client, paneId)) {
          return json(res, 409, {
            error: `read guard: ${paneId} has not been read by this caller`,
            hint: `GET /read?target=${encodeURIComponent(body.target)} first, then retry`,
            ttlMs: opts.readGuardTtlMs,
          });
        }
        // The bridge keeps its own process-wide guard file, which any caller's send
        // clears. This caller's grant has just been checked — per caller and with a
        // TTL, which is stricter — so re-arm the shared one rather than fail on it.
        bridge.markRead(paneId);

        const result = await tools.message(body.target, body.text, {
          from: opts.senderLabel,
        });
        // Spent: the next message needs its own read, as over stdio.
        guard.consume(client, result.paneId);
        return json(res, 200, {
          target: body.target,
          paneId: result.paneId,
          correlationId: result.correlationId,
          text: result.text,
        });
      }

      if (req.method === "GET" && path === "/resolve") {
        const target = url.searchParams.get("target");
        if (!target) return json(res, 400, { error: "target is required" });
        const resolved = await tools.resolve(target);
        return json(res, 200, { target, resolved, text: resolved });
      }

      if (req.method === "GET" && path === "/id") {
        const paneId = await tools.id();
        return json(res, 200, { paneId, text: paneId });
      }

      if (req.method === "GET" && path === "/doctor") {
        const text = await tools.doctor();
        return json(res, 200, { text });
      }

      return json(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (e) {
      const { status, body } = failure(e);
      return json(res, status, body);
    }
  });

  return {
    server,
    options: opts,
    guard,
    listen: () =>
      new Promise<void>((resolve) => {
        server.listen(opts.port, opts.host, () => {
          const address = server.address();
          const port = typeof address === "object" && address ? address.port : opts.port;
          const tag = opts.requireTag ? ` requiring ${opts.requireTag}` : " (NO tag check)";
          console.error(`tmux-bridge http on ${opts.host}:${port}${tag}`);
          resolve();
        });
      }),
  };
}

export async function startHttpServer(options: Partial<HttpOptions> = {}): Promise<void> {
  const { listen } = createHttpServer(options);
  await listen();
}
