---
name: feedback_autonomous_pane_cloud_mcp_oauth_gated
description: "Cloud MCP servers (Linear, Sentry, Mixpanel, Notion) are OAuth-gated in autonomous /loop worker/foreman panes — flag the blocker and hand the task back, don't attempt OAuth"
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-31
  sourceBranch: feature/eng-1064
  written: 2026-07-31
  originSessionId: be3fb886-aa9a-4343-9802-c2e557add6b7
---

In non-interactive `/loop /worker` and `/loop /foreman` panes, the cloud MCP connectors (Linear, Sentry, Mixpanel, Notion, and the claude.ai connectors) are **OAuth-gated** and commonly expose only an `authenticate` stub — no read/write tools. The OAuth flow can only be completed by Michael interactively (`/mcp`, or claude.ai connector settings).

So: ticket create/read/reconcile, Sentry issue lookups, Mixpanel queries, etc. **cannot be done autonomously**. When you hit this, **flag the blocker and return the task to the foreman/Michael immediately** — do NOT attempt an OAuth flow yourself, and don't burn turns re-discovering the same wall. Once Michael auths a connector mid-session, the tools appear and the work unblocks.

**Why:** an autonomous pane that keeps probing an OAuth-gated connector wastes turns and never makes progress; the only unblock is a human auth.
**How to apply:** on seeing only an `authenticate` stub, surface the specific blocked action to Michael and hand the task back. Related: Linear write field-name strictness once authed is [[feedback_linear_mcp_strict_field_names]].
