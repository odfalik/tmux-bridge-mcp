#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as bridge from "./tmux-bridge.js";

const server = new McpServer({
  name: "tmux-bridge",
  version: "0.1.0",
});

export function err(e: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

// --- Tools ---

server.tool(
  "tmux_list",
  "List all tmux panes with target ID, window name, process, and working directory",
  {},
  async () => {
    try {
      const panes = await bridge.list();
      const text = panes
        .map(
          (p) =>
            `${p.target} | ${p.sessionWindow} | window:${p.windowName || "(none)"} | ${p.process} | ${p.cwd}`
        )
        .join("\n");
      return { content: [{ type: "text", text: text || "No panes found" }] };
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "tmux_read",
  "Read the last N lines from a tmux pane. Must be called before tmux_message (read guard). Target can be a pane ID (%N), session:window.pane, or window name. Names resolve globally by tmux window name.",
  {
    target: z.string().describe("Pane target: ID (%0), session:win.pane, or window name"),
    lines: z
      .number()
      .optional()
      .default(50)
      .describe("Number of lines to read (default 50)"),
  },
  async ({ target, lines }) => {
    try {
      const output = await bridge.read(target, lines);
      return { content: [{ type: "text", text: output }] };
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "tmux_message",
  "Send and submit a message to another agent's pane with auto-prepended sender info, reply target, and correlation ID. Presses Enter automatically. Cannot message your own pane (loop prevention). Must tmux_read first.",
  {
    target: z.string().describe("Pane target: ID (%0), session:win.pane, or window name"),
    text: z.string().describe("Message to send"),
  },
  async ({ target, text }) => {
    try {
      await bridge.message(target, text);
      return {
        content: [{ type: "text", text: `Message sent and submitted to ${target}` }],
      };
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "tmux_resolve",
  "Look up a pane's target ID by canonical tmux window name",
  {
    target: z.string().describe("Window name to resolve"),
  },
  async ({ target }) => {
    try {
      const paneId = await bridge.resolve(target);
      return { content: [{ type: "text", text: paneId }] };
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "tmux_id",
  "Print the MCP server's current tmux pane ID. Uses $TMUX_PANE when available, otherwise resolves by process ancestry against tmux pane PIDs.",
  {},
  async () => {
    try {
      const paneId = await bridge.id();
      return { content: [{ type: "text", text: paneId }] };
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "tmux_doctor",
  "Diagnose tmux connectivity issues — checks socket, env vars, and pane visibility",
  {},
  async () => {
    try {
      const output = await bridge.doctor();
      return { content: [{ type: "text", text: output }] };
    } catch (e) {
      return err(e);
    }
  }
);

// --- Start ---

export async function startServer() {
  // Apply sensible tmux defaults (mouse scroll, long history, vi keys)
  // so users don't need to configure ~/.tmux.conf manually.
  bridge.applyDefaults().catch(() => {});

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run when executed directly (not when imported for testing)
const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectRun) {
  startServer().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
