---
name: feedback_mixpanel_get_business_context
description: Mixpanel Get-Business-Context needs an org/project id first — call List-Organizations (or Get-Projects) before it
metadata: 
  node_type: memory
  type: feedback
  sourceDream: 2026-07-29
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

The Mixpanel MCP instructions say to call `Get-Business-Context` first, but the **first call fails**:

> organization_id is required when project_id is not provided. Call List-Organizations first to obtain it.

Call **`List-Organizations`** (or `Get-Projects`) to get an org/project id, then call `Get-Business-Context` with it.

**Why:** following the server's own "call it first" instruction verbatim wastes a failing round-trip every session.
**How to apply:** call `List-Organizations` → then `Get-Business-Context` with the returned id. See [[project_mixpanel_telemetry_architecture]].
