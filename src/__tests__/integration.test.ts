/**
 * Integration tests — real tmux session with multiple panes.
 *
 * These tests create a temporary tmux session, open multiple panes
 * (simulating Claude Code / Codex / Kimi), and test cross-pane
 * communication through the tmux-bridge module.
 *
 * Requires: tmux 3.2+ installed and runnable.
 * Skipped in CI if tmux is not available.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as bridge from "../tmux-bridge.js";

const execFileAsync = promisify(execFile);

const SESSION = "tmux-bridge-test";
const LABEL_PREFIX = `bridge-test-${Date.now()}`;
const CLAUDE_LABEL = `${LABEL_PREFIX}-claude`;
const CODEX_LABEL = `${LABEL_PREFIX}-codex`;
const KIMI_LABEL = `${LABEL_PREFIX}-kimi`;
let paneIds: string[] = [];

// Synchronous check — needed because describe.skipIf runs before beforeAll
let tmuxAvailable = false;
try {
  const { execFileSync } = await import("node:child_process");
  execFileSync("tmux", ["-V"], { timeout: 3000 });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, { timeout: 5000 });
  return stdout.trim();
}

async function isTmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-V"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeAll(async () => {
  tmuxAvailable = await isTmuxAvailable();
  if (!tmuxAvailable) return;

  // Kill any leftover test session
  try {
    await tmux("kill-session", "-t", SESSION);
  } catch {
    // OK if it doesn't exist
  }

  // Create a new session with 3 panes (simulating 3 agents).
  // Capture pane IDs directly so the test works with custom base-index values.
  const pane0 = await tmux(
    "new-session",
    "-d",
    "-s",
    SESSION,
    "-x",
    "200",
    "-y",
    "50",
    "-P",
    "-F",
    "#{pane_id}"
  );

  const pane1 = await tmux(
    "split-window",
    "-h",
    "-t",
    pane0,
    "-P",
    "-F",
    "#{pane_id}"
  );

  const pane2 = await tmux(
    "split-window",
    "-v",
    "-t",
    pane1,
    "-P",
    "-F",
    "#{pane_id}"
  );

  paneIds = [pane0, pane1, pane2];

  // Label the panes
  await tmux("set-option", "-p", "-t", pane0, "@name", CLAUDE_LABEL);
  await tmux("set-option", "-p", "-t", pane1, "@name", CODEX_LABEL);
  await tmux("set-option", "-p", "-t", pane2, "@name", KIMI_LABEL);

  // Give panes time to initialize
  await sleep(500);
});

afterAll(async () => {
  if (!tmuxAvailable) return;
  try {
    await tmux("kill-session", "-t", SESSION);
  } catch {
    // OK
  }
});

// Clear read guards between tests
beforeEach(async () => {
  if (!tmuxAvailable) return;
  for (const id of paneIds) {
    bridge.clearRead(id);
  }
});

describe.skipIf(!tmuxAvailable)("Integration: tmux cross-pane", () => {
  it("should list all 3 test panes", async () => {
    const panes = await bridge.list();
    const testPanes = panes.filter((p) =>
      paneIds.includes(p.target)
    );
    expect(testPanes.length).toBe(3);
  });

  it("should list panes with correct labels", async () => {
    const panes = await bridge.list();
    const labels = panes
      .filter((p) => paneIds.includes(p.target))
      .map((p) => p.label)
      .sort();
    expect(labels).toEqual([CLAUDE_LABEL, CODEX_LABEL, KIMI_LABEL].sort());
  });

  it("should read pane content", async () => {
    const content = await bridge.read(paneIds[0], 10);
    expect(typeof content).toBe("string");
    // Should have some content (at least shell prompt)
    expect(content.length).toBeGreaterThan(0);
  });

  it("should resolve label to pane ID", async () => {
    const resolved = await bridge.resolve(CLAUDE_LABEL);
    expect(resolved).toBe(paneIds[0]);

    const resolved2 = await bridge.resolve(CODEX_LABEL);
    expect(resolved2).toBe(paneIds[1]);

    const resolved3 = await bridge.resolve(KIMI_LABEL);
    expect(resolved3).toBe(paneIds[2]);
  });

  it("should throw for unknown label", async () => {
    await expect(bridge.resolve("nonexistent")).rejects.toThrow(
      "No live pane found with window name or label"
    );
  });

  it("should read by label (not just pane ID)", async () => {
    const content = await bridge.read(CODEX_LABEL, 5);
    expect(typeof content).toBe("string");
  });

  it("should enforce read guard — type fails without prior read", async () => {
    // clearRead was called in beforeEach, so guard is not satisfied
    await expect(
      bridge.type(paneIds[1], "hello")
    ).rejects.toThrow("Must read pane");
  });

  it("should enforce read guard — read then type succeeds", async () => {
    await bridge.read(paneIds[1], 5); // satisfies guard
    await bridge.type(paneIds[1], "echo test123");
    // If we get here without error, guard was satisfied
    await sleep(100);
    // Verify the text appeared in the pane
    await bridge.read(paneIds[1], 5); // re-read
    const content = await bridge.read(paneIds[1], 5);
    expect(content).toContain("test123");
  });

  it("should send keys (Enter) after typing", async () => {
    await bridge.read(paneIds[1], 5); // satisfy guard
    await bridge.type(paneIds[1], "echo hello_from_test");
    await bridge.read(paneIds[1], 5); // re-satisfy after type clears guard
    await bridge.keys(paneIds[1], "Enter");
    await sleep(300); // wait for command to execute
    const output = await bridge.read(paneIds[1], 10);
    expect(output).toContain("hello_from_test");
  });

  it("should type from claude pane into codex pane", async () => {
    // Simulate: Claude typing into Codex's pane
    await bridge.read(CODEX_LABEL, 5);
    await bridge.type(CODEX_LABEL, "echo cross_pane_works");
    await bridge.read(CODEX_LABEL, 5);
    await bridge.keys(CODEX_LABEL, "Enter");
    await sleep(300);
    const output = await bridge.read(CODEX_LABEL, 10);
    expect(output).toContain("cross_pane_works");
  });

  it("should type from codex pane into kimi pane", async () => {
    await bridge.read(KIMI_LABEL, 5);
    await bridge.type(KIMI_LABEL, "echo codex_to_kimi");
    await bridge.read(KIMI_LABEL, 5);
    await bridge.keys(KIMI_LABEL, "Enter");
    await sleep(300);
    const output = await bridge.read(KIMI_LABEL, 10);
    expect(output).toContain("codex_to_kimi");
  });

  it("should name a pane and resolve it", async () => {
    await bridge.name(paneIds[0], "test-agent");
    const resolved = await bridge.resolve("test-agent");
    expect(resolved).toBe(paneIds[0]);

    // Restore original label
    await bridge.name(paneIds[0], CLAUDE_LABEL);
  });

  it("should handle doctor command", async () => {
    const output = await bridge.doctor();
    expect(output).toContain("tmux-bridge doctor");
    expect(output).toContain("Status: OK");
  });

  it("should read multiple panes independently", async () => {
    // Type different content into each pane
    await bridge.read(CLAUDE_LABEL, 5);
    await bridge.type(CLAUDE_LABEL, "echo pane_claude_unique");
    await bridge.read(CLAUDE_LABEL, 5);
    await bridge.keys(CLAUDE_LABEL, "Enter");

    await bridge.read(KIMI_LABEL, 5);
    await bridge.type(KIMI_LABEL, "echo pane_kimi_unique");
    await bridge.read(KIMI_LABEL, 5);
    await bridge.keys(KIMI_LABEL, "Enter");

    await sleep(300);

    const claudeOutput = await bridge.read(CLAUDE_LABEL, 10);
    const kimiOutput = await bridge.read(KIMI_LABEL, 10);

    expect(claudeOutput).toContain("pane_claude_unique");
    expect(kimiOutput).toContain("pane_kimi_unique");
    // Each pane should NOT have the other's content
    expect(claudeOutput).not.toContain("pane_kimi_unique");
    expect(kimiOutput).not.toContain("pane_claude_unique");
  });
});
