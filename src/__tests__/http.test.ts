/**
 * HTTP transport — pure-function tests for the two pieces that decide safety and
 * output quality: which panes may be asked, and what counts as the agent's answer.
 */
import { describe, it, expect } from "vitest";
import { classifyPanes, cleanReply, findAgentForPane, parseProcTable, type Target } from "../http.js";
import type { PaneInfo } from "../tmux-bridge.js";

const pane = (over: Partial<PaneInfo>): PaneInfo => ({
  target: "%1",
  sessionWindow: "s:1",
  windowName: "w",
  size: "80x24",
  process: "zsh",
  label: "",
  cwd: "~",
  ...over,
});

const byName = (ts: Target[], name: string) => ts.find((t) => t.name === name)!;

describe("classifyPanes", () => {
  it("refuses shell panes — messaging one would execute the text", () => {
    const [t] = classifyPanes([pane({ windowName: "shell", process: "zsh" })], ["claude"]);
    expect(t.askable).toBe(false);
    expect(t.reason).toMatch(/not a known agent/);
  });

  it("accepts a pane running a known agent", () => {
    const [t] = classifyPanes([pane({ windowName: "training", process: "claude" })], ["claude"]);
    expect(t.askable).toBe(true);
    expect(t.reason).toBeUndefined();
  });

  it("prefers the resolved command over pane_current_command", () => {
    // Claude Code sets its process title to its version, so tmux reports "2.1.220".
    const panes = [pane({ target: "%9", windowName: "agent", process: "2.1.220" })];
    const resolved = new Map([["%9", "claude"]]);
    expect(classifyPanes(panes, ["claude"])[0].askable).toBe(false);
    const t = classifyPanes(panes, ["claude"], resolved)[0];
    expect(t.askable).toBe(true);
    expect(t.agent).toBe("claude");
  });

  it("classifies each pane independently", () => {
    const ts = classifyPanes(
      [
        pane({ target: "%0", windowName: "shell", process: "zsh" }),
        pane({ target: "%1", windowName: "lit-review", process: "codex" }),
      ],
      ["claude", "codex"]
    );
    expect(byName(ts, "shell").askable).toBe(false);
    expect(byName(ts, "lit-review").askable).toBe(true);
  });

  it("falls back to sessionWindow when a window has no name", () => {
    const [t] = classifyPanes([pane({ windowName: "", sessionWindow: "s:3" })], ["claude"]);
    expect(t.name).toBe("s:3");
  });
});

describe("cleanReply", () => {
  it("keeps the answer and drops the TUI furniture around it", () => {
    const captured = [
      "",
      "⏺ I'm running in /Users/odedfalik.",
      "",
      "✻ Cogitated for 1s",
      "────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────",
      "  3% context",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    ].join("\n");
    expect(cleanReply(captured)).toBe("I'm running in /Users/odedfalik.");
  });

  it("preserves multi-line answers and their internal blank lines", () => {
    const captured = ["", "⏺ First line.", "", "Second line.", "", "✻ Worked for 2s", "  9% context"].join("\n");
    expect(cleanReply(captured)).toBe("First line.\n\nSecond line.");
  });

  it("returns empty when nothing but chrome has been printed yet", () => {
    const captured = ["", "✻ Cogitated for 1s", "────────────", "  3% context"].join("\n");
    expect(cleanReply(captured)).toBe("");
  });

  it("stops at the prompt rather than swallowing later input", () => {
    const captured = ["", "⏺ Answer.", "", "❯ some text the user typed after", "  3% context"].join("\n");
    expect(cleanReply(captured)).toBe("Answer.");
  });
});

describe("findAgentForPane", () => {
  const rows = (spec: Array<[string, string, string]>) =>
    parseProcTable(spec.map(([pid, ppid, cmd]) => `${pid} ${ppid} ${cmd}`).join("\n"));

  it("finds an agent running as a child of the pane's shell", () => {
    // The normal case: pane_pid is the shell, the agent is its child.
    const t = rows([
      ["100", "1", "/bin/zsh"],
      ["200", "100", "/Users/oded/.local/bin/claude"],
    ]);
    expect(findAgentForPane("100", t, ["claude"])).toBe("claude");
  });

  it("matches the versioned binary path, whose basename is a version number", () => {
    // Claude Code lives at .../share/claude/versions/2.1.220 — basename is "2.1.220".
    const t = rows([["21071", "2735", "/Users/oded/.local/share/claude/versions/2.1.220"]]);
    expect(findAgentForPane("21071", t, ["claude"])).toBe("claude");
  });

  it("returns the shell when the pane really is just a shell", () => {
    const t = rows([
      ["100", "1", "/bin/zsh"],
      ["200", "100", "/usr/bin/vim"],
    ]);
    expect(findAgentForPane("100", t, ["claude", "codex"])).toBe("zsh");
  });

  it("ignores non-agent siblings and finds the agent", () => {
    const t = rows([
      ["1", "0", "/bin/zsh"],
      ["2", "1", "/usr/bin/caffeinate"],
      ["3", "1", "npm exec chrome-devtools-mcp@latest"],
      ["4", "1", "/Users/oded/.local/bin/codex"],
    ]);
    expect(findAgentForPane("1", t, ["claude", "codex"])).toBe("codex");
  });

  it("stops descending past maxDepth", () => {
    const t = rows([
      ["1", "0", "/bin/zsh"],
      ["2", "1", "/bin/zsh"],
      ["3", "2", "/bin/zsh"],
      ["4", "3", "/bin/claude"],
    ]);
    expect(findAgentForPane("1", t, ["claude"], 1)).toBe("zsh");
    expect(findAgentForPane("1", t, ["claude"], 3)).toBe("claude");
  });
});
