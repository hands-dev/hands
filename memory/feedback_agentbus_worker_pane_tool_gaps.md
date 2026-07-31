---
name: feedback_agentbus_worker_pane_tool_gaps
description: "Worker panes often expose only agent-bus send/receive/board/peers/history — foreman/task tools missing until /mcp reconnect; and workers can't read a delegated task's BODY, only its title"
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-31
  sourceBranch: feature/eng-1064
  written: 2026-07-31
  originSessionId: 006d5cd8-7dee-4ec2-9aaf-1cd74e636d71
---

The agent-bus MCP surface a pane sees depends on the build the pane connected to. Recurring gaps:

- **Tool subset only.** Many panes expose just `send`/`receive`/`board`/`peers`/`history`; the task/foreman tools (`delegate`, `tasks`, `task_update`, `ask`, `priorities`, `questions`, `escalate`) are absent because the connected server predates the build that added them. `ToolSearch` won't conjure them. Fix: Michael runs `/mcp` to **reconnect to the freshly-built server**. Until then, a worker can't move task state — read the delegation from `agent_bus_history`/`receive` and report back via `agent_bus_send`.
- **Workers can't read a delegated task's BODY** — only the **title** arrives in the pane. So an `agent_bus_delegate` with the full spec in the body is undeliverable content; the foreman must **re-send the spec as a plain `agent_bus_send` message** for the worker to act on it.

Corollary: a `delegate` call is not delivery.

**Why:** a foreman that delegates into a pane missing the task tools (or with only the title reaching the worker) thinks work is dispatched when nothing actionable landed.
**How to apply:** if the task/foreman tools are missing, ask Michael to `/mcp` reconnect; always accompany a `delegate` with the spec re-sent as a plain message. See the worker/foreman model in [[reference_agent_bus_cross_worktree_mcp]].
