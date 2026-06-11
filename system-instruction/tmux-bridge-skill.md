# tmux-bridge -- Cross-Pane Agent Communication

You have access to tmux-bridge MCP tools for communicating with other AI agents and processes running in tmux panes. These are MCP tool calls, not bash commands.

## Core Rules

1. **Read before act**: Always call `tmux_read` before `tmux_message`. This is enforced by the read guard -- calls will fail without a prior read.
2. **Read-Act-Read cycle**: Use `tmux_message` to send agent messages; it submits automatically.
3. **Never poll for replies**: Other agents reply directly into YOUR pane via tmux-bridge. Do not loop or sleep waiting for responses.
4. **Use window names**: Address agents by canonical tmux window names such as `training`, `lit-review`, or `paper-intelligence`.

## Workflow: Send a message to another agent

```
1. tmux_list()                          -> discover panes
2. tmux_read(target, 20)                -> satisfy read guard, see current state
3. tmux_message(target, "your message") -> send message with sender info and submit
4. tmux_read(target, 5)                 -> verify message was submitted
   STOP -- do not read target for reply. Reply comes to YOUR pane.
```

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `tmux_list` | List all panes with process, window name, cwd |
| `tmux_read` | Read last N lines from a pane (satisfies read guard) |
| `tmux_message` | Send and submit message with auto sender info (requires prior read) |
| `tmux_resolve` | Look up pane ID by tmux window name |
| `tmux_id` | Print current pane's tmux ID |
| `tmux_doctor` | Diagnose tmux connection issues |

Targets can be explicit tmux targets (`%pane_id`, `session:window.pane`, or window index) or names. Resolve names globally by canonical tmux `#{window_name}` first. If the same pane appears through multiple grouped sessions, treat it as one candidate by `#{pane_id}`; if multiple real panes match, stop and report the ambiguity.

## Target Resolution

Targets can be:
- **Pane ID**: `%0`, `%3` (from tmux_list)
- **Session:window.pane**: `main:0.1`
- **Window name**: `training`, `lit-review`, `paper-intelligence`
