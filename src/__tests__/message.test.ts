import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("node:util", () => ({
  promisify:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        });
      }),
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "12345678-1234-1234-1234-123456789abc",
}));

import { clearRead, markRead, message } from "../tmux-bridge.js";

describe("message", () => {
  beforeEach(() => {
    delete process.env.TMUX_PANE;
    delete process.env.TMUX;
    delete process.env.TMUX_BRIDGE_SOCKET;
    process.env.TMUX_BRIDGE_SUBMIT_DELAY_MS = "0";
    clearRead("%99");
    mocks.execFile.mockReset();
    mocks.execFile.mockImplementation(
      (
        file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (file === "ps") {
          callback(null, "1\n", "");
          return;
        }

        expect(file).toBe("tmux");

        if (args[0] === "display-message") {
          callback(null, "%99\n", "");
          return;
        }

        if (args[0] === "list-panes") {
          callback(null, "", "");
          return;
        }

        callback(null, "", "");
      }
    );
  });

  afterEach(() => {
    delete process.env.TMUX_BRIDGE_SUBMIT_DELAY_MS;
  });

  it("pastes the message and submits it with Enter", async () => {
    markRead("%99");

    await message("%99", "hello teammate");

    const tmuxCalls = mocks.execFile.mock.calls
      .filter((call) => call[0] === "tmux")
      .map((call) => call[1] as string[]);
    expect(tmuxCalls.some((call) =>
      call[0] === "load-buffer" &&
      call[1] === "-b" &&
      call[2] === "tmux-bridge-12345678" &&
      typeof call[3] === "string" &&
      call[3].includes("tmux-bridge-message-")
    )).toBe(true);
    expect(tmuxCalls.some((call) => call.join("\0").endsWith([
      "paste-buffer",
      "-d",
      "-b",
      "tmux-bridge-12345678",
      "-t",
      "%99",
    ].join("\0")))).toBe(true);
    expect(tmuxCalls.some((call) => call.join("\0").endsWith([
      "send-keys",
      "-t",
      "%99",
      "Enter",
    ].join("\0")))).toBe(true);
  });
});
