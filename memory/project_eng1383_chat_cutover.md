---
name: project_eng1383_chat_cutover
description: ENG-1383 — cut over &michael.phillipszz staging chat to fungible fleet hosts (per-andee canary). Gate + enable + probe fixes shipped; hosts chat-ready; cohort drift + parity guard pending.
metadata: 
  node_type: memory
  type: project
  originSessionId: 8e7786aa-592f-4964-a827-1623c161c3b2
---

**ENG-1383** (Engineering, cycle 26, → INN-219): route ONLY `&michael.phillipszz` (`andee_1772749836721_20j256u`, dedicated runtime `rt_2lm1DgS9mrp127bfE`) chat to the fleet hosts; everyone else stays on dedicated runtimes.

**Shipped to staging (all merged):** PR #2308 per-andee `chat_bridge` matchmaker gate + `FLEET_CHAT_ANDEE_ALLOWLIST` (fail-closed; `apps/api/src/services/task-matchmaker.ts` `chatCutoverBlocksAssignment`, `apps/api/src/lib/fleet-config.ts`); #2309 `fleet_chat_enabled=true` + idle 300, `fleet_chat_mcp_base_url` derived from `mcp_url`; #2310 cohort tfvars; #2311 probe `--probe-max-tokens 1→16`; #2312 probe subprocess-timeout decouple (`CHAT_MODEL_PREFLIGHT_SUBPROCESS_TIMEOUT_S=30`). Three destructive `APPLY_DESTRUCTIVE_STAGING_PLAN` recycles.

**STATE (2026-07-29):** the two chat-probe bugs were the real blockers — once fixed, hosts on image `flh-2026.6.5-b4c9…` advertised `["chat"]` and the cutover machinery is PROVEN end-to-end (matchmaker assigned only michael's task → fleet host claimed → `rt_2lm1` checkout-fenced). Full mechanics playbook + all gotchas: [[reference_fleet_host_capability_provisioning]].

**OPEN / cleanup:**
- **Cohort DRIFT**: `FLEET_CHECKOUT_CONSUMER_HOST_IDS` was set via direct `gcloud run services update` (fast), NOT tfvars — a TF apply reverts it. `terraform.tfvars` still lists long-dead host ids. Must re-point at the CURRENT stable host ids and codify in tfvars. Host ids churn on every recycle (Gotcha 3).
- **Traffic promotion**: every env apply needs a manual `update-traffic` to the new `api-server` revision (Gotcha 1).
- **Parity guard** (user-requested): add a CI drift test that `checkout_executor.py` `TASK_TYPE_CAPABILITY` matches `task-registry.ts` `TASK_REQUIRED_CAPABILITY` (chat_bridge↔chat etc.), + codegen later. Not started.
- **Stale-task poison-loop learned**: enabling chat with a stale queued `chat_bridge` in the queue → it claim-loops + fences the andee runtime. Flushed staging queue manually (Gotcha 5). Verify a FRESH message completes on a fleet host (`chat_bridge_complete`).
- **BIG design gap found → ENG-1384** (Backlog, "attach fleet chat host on chat-open + non-blocking composer"): the fleet path only works on message-SEND, but clicking & shows a blocking "Preparing agent" gated on the DEDICATED runtime being `online` — and a fleet checkout fences the runtime to `provisioning`, so BOTH the client gate (`hosted-agent-experience.tsx:150,562-635` `isRuntimeWorkCapable`) AND the server send fence (`agent-runtimes.ts:4425-4442` `isRuntimeReadyForChannel`, rejects non-online) hard-block. Fix (3 layers, canary-scoped): (1) enqueue chat_bridge at conversation-OPEN via `resolveConversationForAndee` (`conversations.ts:558-626`) → INN-196 fast path attaches a host in the bg; (2) mobile opens instantly + always-mounted composer + soft "connecting→connected" indicator (not runtime.status); (3) generalize `allowedOfflineCheckoutReopen` (`agent-runtimes.ts:4435-4441`) to queue sends into runtime_channel_messages while a checkout is in-flight (type-ahead) — highest risk, touches core send fence. Mobile currently uses the legacy `GET/POST /v1/runtimes/{id}/messages` shim (doesn't call `/v1/conversations/resolve`). Full design: local plan `let-s-pick-up-the-tender-pizza.md`.
- **michael's dedicated runtime rt_2lm1 is BROKEN** (stuck `provisioning`, has a credential but not heartbeating online) from the cutover fence+flush — his staging app hangs on "Preparing agent". Needs restore (revoke→reprovision-on-login, or recover) before the fleet path is testable. User chose to design ENG-1384 rather than restore first.
- Follow-ups: subprocess-timeout budget is heavy (30s per heartbeat) because of the blocked-codex-plugin startup — fixing plugin ownership would let it tighten; tenant runtime template still has `--probe-max-tokens 1`.
