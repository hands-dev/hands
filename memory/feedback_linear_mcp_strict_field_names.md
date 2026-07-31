---
name: feedback_linear_mcp_strict_field_names
description: "Linear MCP tools reject guessed field names with a zod -32602 error — save_issue wants blockedBy (not addBlockedBy); list_issues field values must be from the allowed enum"
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-31
  sourceBranch: feature/eng-1064
  written: 2026-07-31
  originSessionId: a45d0fa5-735b-455c-bf0f-295134fdd2b5
---

Linear MCP tools use strict zod schemas and reject invented field names with `MCP error -32602: Input validation error`. Two confirmed:

- `save_issue` uses **`blockedBy`**, not `addBlockedBy`, to add a blocker relation.
- `list_issues` field/select values must come from the tool's **allowed enum** — passing arbitrary field names fails `invalid_value`.

**Why:** guessing field names costs a round-trip per wrong guess against a strict schema.
**How to apply:** don't guess field names; inspect the tool schema (or start from a known-good call) before a Linear MCP write. Note: in autonomous panes Linear MCP may also be OAuth-gated with no write tools at all — [[feedback_autonomous_pane_cloud_mcp_oauth_gated]].
