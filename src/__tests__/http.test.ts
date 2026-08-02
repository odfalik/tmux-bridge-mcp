/**
 * HTTP transport tests.
 *
 * The transport's whole job is to be a faithful mirror of the MCP tools, so the tests
 * are about framing rather than tmux: each route reaches the shared verb with the right
 * arguments, and the failures stdio reports as text come back as the right status code.
 * The read guard gets the most attention — over stdio it is a file the server owns, and
 * here it is the only piece of state this transport invents.
 *
 * tmux itself is mocked; the bridge's own behaviour is covered in tmux-bridge.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import * as bridge from "../tmux-bridge.js";
import { ReadGuard, createHttpServer } from "../http.js";
import type { PaneInfo } from "../tmux-bridge.js";

vi.mock("../tmux-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tmux-bridge.js")>();
  // Error classes stay real — the transport maps failures with instanceof.
  return {
    ...actual,
    list: vi.fn(),
    read: vi.fn(),
    message: vi.fn(),
    paneIdFor: vi.fn(),
    resolve: vi.fn(),
    id: vi.fn(),
    doctor: vi.fn(),
    markRead: vi.fn(),
  };
});

const pane = (over: Partial<PaneInfo> = {}): PaneInfo => ({
  target: "%1",
  sessionWindow: "main:1",
  windowName: "training",
  size: "80x24",
  process: "zsh",
  label: "",
  cwd: "~/Repos/POSTMAN",
  ...over,
});

type Call = (
  path: string,
  init?: RequestInit
) => Promise<{ status: number; body: any }>;

let teardown: Array<() => Promise<void>> = [];

/** Start the transport on an ephemeral port and return a fetch helper bound to it. */
async function start(options: Parameters<typeof createHttpServer>[0] = {}): Promise<Call> {
  const { server } = createHttpServer({
    host: "127.0.0.1",
    port: 0,
    requireTag: undefined,
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  teardown.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );

  return async (path, init) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: res.status, body: await res.json() };
  };
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.mocked(bridge.list).mockResolvedValue([pane()]);
  vi.mocked(bridge.read).mockResolvedValue("pane contents");
  vi.mocked(bridge.message).mockResolvedValue("abc12345");
  vi.mocked(bridge.paneIdFor).mockResolvedValue("%1");
  vi.mocked(bridge.resolve).mockResolvedValue("%1");
  vi.mocked(bridge.id).mockResolvedValue("%7");
  vi.mocked(bridge.doctor).mockResolvedValue("tmux-bridge doctor\n---\nStatus: OK");
});

afterEach(async () => {
  for (const close of teardown) await close();
  teardown = [];
  vi.clearAllMocks();
});

describe("mirrored verbs", () => {
  it("GET /list returns the panes and the tmux_list rendering", async () => {
    const call = await start();
    const { status, body } = await call("/list");
    expect(status).toBe(200);
    expect(body.panes).toHaveLength(1);
    expect(body.panes[0].target).toBe("%1");
    expect(body.text).toBe("%1 | main:1 | window:training | zsh | ~/Repos/POSTMAN");
  });

  it("GET /read captures the pane and reports which pane it resolved to", async () => {
    const call = await start();
    const { status, body } = await call("/read?target=training&lines=10");
    expect(status).toBe(200);
    expect(body).toMatchObject({ target: "training", paneId: "%1", lines: 10, text: "pane contents" });
    expect(bridge.read).toHaveBeenCalledWith("%1", 10);
  });

  it("GET /read defaults to 50 lines, as tmux_read does", async () => {
    const call = await start();
    await call("/read?target=training");
    expect(bridge.read).toHaveBeenCalledWith("%1", 50);
  });

  it("GET /read rejects a missing or non-numeric parameter", async () => {
    const call = await start();
    expect((await call("/read")).status).toBe(400);
    expect((await call("/read?target=training&lines=abc")).status).toBe(400);
    expect((await call("/read?target=training&lines=0")).status).toBe(400);
    expect(bridge.read).not.toHaveBeenCalled();
  });

  it("GET /resolve returns the target ID for a window name", async () => {
    const call = await start();
    const { status, body } = await call("/resolve?target=training");
    expect(status).toBe(200);
    expect(body).toMatchObject({ target: "training", resolved: "%1", text: "%1" });
  });

  it("GET /resolve requires a target", async () => {
    const call = await start();
    expect((await call("/resolve")).status).toBe(400);
  });

  it("GET /id returns the server's own pane", async () => {
    const call = await start();
    const { status, body } = await call("/id");
    expect(status).toBe(200);
    expect(body).toMatchObject({ paneId: "%7", text: "%7" });
  });

  it("GET /doctor returns the diagnosis text", async () => {
    const call = await start();
    const { status, body } = await call("/doctor");
    expect(status).toBe(200);
    expect(body.text).toMatch(/Status: OK/);
  });

  it("GET /health reports tmux reachability without claiming to be an MCP verb", async () => {
    const call = await start();
    expect(await call("/health")).toMatchObject({ status: 200, body: { ok: true, tmux: "reachable" } });

    vi.mocked(bridge.list).mockRejectedValue(new Error("no server"));
    expect((await call("/health")).status).toBe(503);
  });

  it("404s unknown paths and wrong methods", async () => {
    const call = await start();
    expect((await call("/targets")).status).toBe(404);
    expect((await call("/ask", post({ text: "hi" }))).status).toBe(404);
    expect((await call("/list", post({}))).status).toBe(404);
  });
});

describe("read guard", () => {
  it("refuses a message from a caller that has not read the pane", async () => {
    const call = await start();
    const { status, body } = await call("/message", post({ target: "training", text: "hi" }));
    expect(status).toBe(409);
    expect(body.error).toMatch(/read guard/);
    expect(body.hint).toMatch(/GET \/read/);
    expect(bridge.message).not.toHaveBeenCalled();
  });

  it("allows the message once the caller has read that pane", async () => {
    const call = await start();
    await call("/read?target=training");

    const { status, body } = await call("/message", post({ target: "training", text: "hi" }));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      target: "training",
      paneId: "%1",
      correlationId: "abc12345",
      text: "Message sent and submitted to training",
    });
    expect(bridge.message).toHaveBeenCalledWith("%1", "hi", expect.objectContaining({ from: expect.any(String) }));
  });

  it("spends the grant — a second message needs a second read", async () => {
    const call = await start();
    await call("/read?target=training");
    expect((await call("/message", post({ target: "training", text: "one" }))).status).toBe(200);
    expect((await call("/message", post({ target: "training", text: "two" }))).status).toBe(409);

    await call("/read?target=training");
    expect((await call("/message", post({ target: "training", text: "two" }))).status).toBe(200);
  });

  it("keys on the pane, so reading by name unlocks messaging by pane ID", async () => {
    const call = await start();
    vi.mocked(bridge.paneIdFor).mockImplementation(async (t) => (t === "training" || t === "%1" ? "%1" : "%2"));

    await call("/read?target=training");
    expect((await call("/message", post({ target: "%1", text: "hi" }))).status).toBe(200);
  });

  it("does not let a read of one pane unlock another", async () => {
    const call = await start();
    vi.mocked(bridge.paneIdFor).mockImplementation(async (t) => (t === "training" ? "%1" : "%2"));

    await call("/read?target=training");
    expect((await call("/message", post({ target: "lit-review", text: "hi" }))).status).toBe(409);
  });

  it("re-arms the bridge's shared guard, which another caller's send may have cleared", async () => {
    const call = await start();
    await call("/read?target=training");
    await call("/message", post({ target: "training", text: "hi" }));
    expect(bridge.markRead).toHaveBeenCalledWith("%1");
  });

  it("rejects a message with no target or no text before touching tmux", async () => {
    const call = await start();
    expect((await call("/message", post({ text: "hi" }))).status).toBe(400);
    expect((await call("/message", post({ target: "training" }))).status).toBe(400);
    expect((await call("/message", { method: "POST", body: "not json" })).status).toBe(400);
    expect(bridge.paneIdFor).not.toHaveBeenCalled();
  });
});

describe("ReadGuard", () => {
  it("grants only to the caller that read", () => {
    const guard = new ReadGuard(60_000);
    guard.mark("100.64.0.1", "%1");
    expect(guard.isSatisfied("100.64.0.1", "%1")).toBe(true);
    expect(guard.isSatisfied("100.64.0.9", "%1")).toBe(false);
  });

  it("expires the grant after the TTL", () => {
    const guard = new ReadGuard(60_000);
    guard.mark("a", "%1", 1_000);
    expect(guard.isSatisfied("a", "%1", 60_000)).toBe(true);
    expect(guard.isSatisfied("a", "%1", 61_001)).toBe(false);
  });

  it("consume clears the grant", () => {
    const guard = new ReadGuard(60_000);
    guard.mark("a", "%1");
    guard.consume("a", "%1");
    expect(guard.isSatisfied("a", "%1")).toBe(false);
  });

  it("prunes expired grants so the map cannot grow unbounded", () => {
    const guard = new ReadGuard(1_000);
    guard.mark("a", "%1", 0);
    guard.mark("b", "%2", 0);
    expect(guard.size).toBe(2);
    guard.mark("c", "%3", 10_000);
    expect(guard.size).toBe(1);
  });
});

describe("failure mapping", () => {
  it("409s an ambiguous window name with the candidate panes", async () => {
    const call = await start();
    vi.mocked(bridge.paneIdFor).mockRejectedValue(
      new bridge.AmbiguousTargetError(
        "Ambiguous tmux window name 'paper-intelligence' matched multiple live panes:\n%20\n%21",
        "paper-intelligence",
        ["%20", "%21"]
      )
    );

    const read = await call("/read?target=paper-intelligence");
    expect(read.status).toBe(409);
    expect(read.body.candidates).toEqual(["%20", "%21"]);
    expect(read.body.hint).toMatch(/pane ID/);

    const sent = await call("/message", post({ target: "paper-intelligence", text: "hi" }));
    expect(sent.status).toBe(409);
    expect(sent.body.candidates).toEqual(["%20", "%21"]);
    expect(bridge.message).not.toHaveBeenCalled();
  });

  it("404s a target that matches no live pane", async () => {
    const call = await start();
    vi.mocked(bridge.paneIdFor).mockRejectedValue(
      new bridge.TargetNotFoundError("No live pane found with window name or label 'gone'", "gone")
    );
    expect((await call("/read?target=gone")).status).toBe(404);
  });

  it("403s a message to the server's own pane (loop prevention)", async () => {
    const call = await start();
    vi.mocked(bridge.message).mockRejectedValue(
      new bridge.LoopPreventionError("Cannot send message to your own pane (loop prevention)")
    );

    await call("/read?target=training");
    const { status, body } = await call("/message", post({ target: "training", text: "hi" }));
    expect(status).toBe(403);
    expect(body.error).toMatch(/loop prevention/);
  });

  it("500s an unexpected tmux failure", async () => {
    const call = await start();
    vi.mocked(bridge.list).mockRejectedValue(new Error("tmux exploded"));
    const { status, body } = await call("/list");
    expect(status).toBe(500);
    expect(body.error).toBe("tmux exploded");
  });
});
