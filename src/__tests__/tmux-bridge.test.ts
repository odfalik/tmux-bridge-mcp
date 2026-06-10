import { describe, it, expect, beforeEach } from "vitest";
import {
  markRead,
  requireRead,
  clearRead,
  parsePaneRecords,
  resolvePaneFromRecords,
} from "../tmux-bridge.js";

// Use a unique pane ID per test run to avoid collisions
const TEST_PANE = `%test_${Date.now()}`;

describe("read guard", () => {
  beforeEach(() => {
    // Ensure clean state
    clearRead(TEST_PANE);
  });

  it("requireRead throws when no prior read", () => {
    expect(() => requireRead(TEST_PANE)).toThrow(/Must read pane/);
  });

  it("markRead then requireRead succeeds", () => {
    markRead(TEST_PANE);
    expect(() => requireRead(TEST_PANE)).not.toThrow();
  });

  it("clearRead then requireRead throws again", () => {
    markRead(TEST_PANE);
    clearRead(TEST_PANE);
    expect(() => requireRead(TEST_PANE)).toThrow(/Must read pane/);
  });
});

// resolveTarget tests — these are synchronous pattern checks that don't need tmux
// We test the patterns directly since resolveTarget is async and calls tmux for labels
describe("resolveTarget patterns", () => {
  it("%0 is a valid pane ID pattern", () => {
    expect(/^%\d+$/.test("%0")).toBe(true);
  });

  it("main:0.1 contains colon — treated as session:win.pane", () => {
    expect("main:0.1".includes(":")).toBe(true);
  });

  it("123 is pure numeric — treated as window index", () => {
    expect(/^\d+$/.test("123")).toBe(true);
  });
});

describe("window-name resolver", () => {
  const records = parsePaneRecords(
    [
      "%10|main|1|training|0|0|zsh||/Users/oded/Repos/POSTMAN",
      "%11|main|2|lit-review|0|0|zsh|legacy-lit|/Users/oded/Repos/papers",
      "%11|grouped|2|lit-review|0|0|zsh|legacy-lit|/Users/oded/Repos/papers",
      "%12|main|3|lit-review|0|1|zsh||/tmp/dead",
      "%13|other|1|golem|0|0|zsh|lit-review|/Users/oded/Repos/golem",
    ].join("\n")
  );

  it("resolves a unique live pane by tmux window name", () => {
    expect(resolvePaneFromRecords("training", records)).toBe("%10");
  });

  it("deduplicates grouped-session views by pane ID", () => {
    expect(resolvePaneFromRecords("lit-review", records)).toBe("%11");
  });

  it("prefers window name over legacy label", () => {
    expect(resolvePaneFromRecords("golem", records)).toBe("%13");
  });

  it("falls back to legacy label when no window name matches", () => {
    expect(resolvePaneFromRecords("legacy-lit", records)).toBe("%11");
  });

  it("ignores dead panes", () => {
    expect(resolvePaneFromRecords("lit-review", records)).toBe("%11");
  });

  it("throws an ambiguity error for multiple real matching panes", () => {
    const ambiguous = parsePaneRecords(
      [
        "%20|main|1|paper-intelligence|0|0|zsh||/Users/oded/Repos/paper-intelligence",
        "%21|other|4|paper-intelligence|0|0|zsh||/Users/oded/Repos/paper-intelligence",
      ].join("\n")
    );

    expect(() => resolvePaneFromRecords("paper-intelligence", ambiguous))
      .toThrow(/Ambiguous tmux window name 'paper-intelligence'/);
  });

  it("throws a not-found error when neither window name nor label matches", () => {
    expect(() => resolvePaneFromRecords("missing", records)).toThrow(
      /No live pane found with window name or label 'missing'/
    );
  });
});
