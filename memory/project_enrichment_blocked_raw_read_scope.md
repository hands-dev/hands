---
name: project_enrichment_blocked_raw_read_scope
description: RESOLVED — staging runtimes now carry signals:raw_read cohort-wide (ENG-1133 self-heal converged); enrichment scope precondition satisfied
metadata: 
  node_type: memory
  type: project
  originSessionId: 00214d03-412c-4636-92e5-443f638447cf
---

**RESOLVED as of 2026-07-30 (empirically verified).** The staging `signals:raw_read` gap that blocked the per-andee openclaw photo-enrichment agent is fixed and fully converged. Do NOT treat this as an active blocker.

Verification (wt3, live staging DB `and-dev-89990` via :5433 proxy, 2026-07-30): whole `hosted-runtime-mcp` cohort = **11/11 active sessions carry `signals:raw_read`, 0 missing**. &michael.phillipszz's runtime (`andee_1772749836721_20j256u`) scope = `signals:ask signals:write connections:read connections:write loops:read loops:write signals:raw_read`, `refresh_version=2`. Nothing to grant; **no reprovision needed** (the self-heal is non-destructive; forced session refresh is the lever if a stale session ever appears, not `cohort/reprovision`).

Fix that landed (ENG-1133): `HOSTED_RUNTIME_CAPABILITY_SCOPE` includes `signals:raw_read` (+ `loops:read/write`) at `packages/db/src/queries/agent-runtimes.ts`, and — the key change — the device-flow refresh now **re-applies the canonical scope on every ~10-min `hosted-runtime-mcp` refresh** (`device-flow.ts`, atomic with handle rotation via `rotateHostedRuntimeMcpSessionRefreshVersion`). So any session minted before the widening self-converges within one refresh TTL. Boot guard `REQUIRED_HOSTED_RUNTIME_CAPABILITY_SCOPES` stays the base 3 → raw_read is granted-but-not-required, no re-bootstrap breakage. The old blast radius (9/10 missing) is gone.

Consequence: the photo-GPS enrichment lane's scope precondition is satisfied. The `photo_location_enrichment` heavy-work order already declares `credentialScopes:['signals:raw_read','signals:write']`; claiming runtimes hold raw_read. Enrichment remains dark behind `HEAVY_WORK_ENRICHMENT_ENABLED` (a flag, not a scope issue). Historical detail: runtime credential is a `host_sessions` row (client `hosted-runtime-mcp`), NOT the consent OAuth lane. Observability gaps that originally hid this: [[project_staging_observability_gaps]] (ENG-1132).
