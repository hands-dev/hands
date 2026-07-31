---
name: project_eng1162_prod_cpu_quota_incident
description: INCIDENT 2026-07-02 (ENG-1162) — prod runtime provisioning down from CPU-quota exhaustion by ~190 leaked warm-pool VMs; broke App Store review
metadata: 
  node_type: memory
  type: project
  originSessionId: 97a6205c-f22f-4cb9-8d91-087f5ab56945
---

**INCIDENT 2026-07-02 (ENG-1162): prod hosted-runtime provisioning fully blocked → Apple rejected & v0.4.0/build 65 as "incomplete app."**

The `&reviewer` App Store account (`andee_review_appstore`, phone `+18165550100`, OTP `267735`, tag `reviewer`) logs in → `provisionRuntimeOnLogin` (AWAITED, inline, `apps/api/src/routes/auth-mobile.ts`) → if the agent never comes online the app shows the failed/empty agent state. Reviewer had 6 revoked runtimes, 0 heartbeats, never once online.

**Root cause chain (all ground-truthed against prod DB + GCP, not telemetry):**
1. `us-central1` **CPUS quota was 200/200 (100%)** → every VM insert failed `QUOTA_EXCEEDED` → runtime revoked ~48s after create.
2. Leak: 200 openclaw VMs RUNNING but only ~10 backed anything real. `failRuntimePoolSlot` marks a slot failed but LEAVES the backing VM running (cleanup deferred to a manual "warm-pool cleanup runbook") → ~190 orphaned VMs ate the quota. Warm pool: 218 failed / ~100 retired / 78 creating / 24 claimed / ~1 ready.
3. Separately, the reviewer had a wedged per-tag VM on a stale image (`ocr-2026.6.5-43d4f903`) that caused an instant-409 create→revoke loop (`last_error` was NULL because `revokeAgentRuntime` never writes it — reason lives only in Sentry `area:hosted_runtime`).
4. Warm-pool DB deeply out of sync: **83 of 101 "claimable" slots were phantoms** (claimed/creating in DB, VM gone). `claimReadyRuntimePoolSlot` handed the reviewer a phantom → stuck `pending_bootstrap` on a non-existent VM.

**Remediation done (2026-07-02):**
- Reaped 190 orphaned VMs (DB-cross-check: running openclaw VM whose name ∉ {non-revoked runtime VMs} ∪ {claimed/creating slot VMs}). **CPUS 200 → 10.**
- Forced the reviewer down the COLD path via the operator reprovision endpoint (below); it reached `online` on a real pool VM. Cleaned the stray cold VM afterward.
- Filed [[project_reset_andee_signals_tool]]-adjacent tickets: **ENG-1162** (incident), **ENG-1163** (warm-pool VM leak + phantom-slot cleanup + `cleanRevokedRuntimeBackingConflict` gap), **ENG-1164** (App-Review reviewer guardrail + persist provision failure reason to `agent_runtimes.last_error`); related to existing **ENG-1014** (CPUS quota alert, still gated off — see [[project_eng1014_cpu_quota_alert_gated_off]]).

**Reusable recipes:**
- **Reviewer login trigger (prod):** `POST https://api.and.com/v1/public/auth/mobile-bootstrap` with `{andeeId:"andee_review_appstore", phoneNumber:"+18165550100", verificationCode:"267735", verificationAttemptId:"test-verification-attempt", device:{platform:"ios",...}}` — `REVIEW_PHONE` bypasses the OTP env gate in ALL envs; runs `provisionRuntimeOnLogin`.
- **Force-cold reprovision (operator):** `POST https://api.and.com/v1/runtimes/cohort/reprovision` header `authToken: <secret runtime-reprovision-operator-token>` (NOT API_AUTH_TOKEN), body `{tagIds:["reviewer"], reason, idempotencyKey}`. Adopt-pending on a `pending_bootstrap` row → `forceCold` → dedicated per-tag VM. DESTRUCTIVE, capped 50/call, breaker after 5 fails, idempotencyKey is audit-only (NOT retry-safe — a replay re-runs teardown).
- **Pipeline flake:** VM-create `waitForComputeZoneOperation` ceiling is ~90s (30s×3); under zone load (e.g. right after a bulk delete) a slow VM create times out → runtime revoked while the VM keeps booting → NEW orphan. Wait for the zone to settle, then retry; the retry that lands `reprovisioned` goes provisioning→channel_verified→online in ~2-3 min.

Prod DB read-only recipe + GCP access: see [[project_raw_signal_zero_prod_throughput]] and [[reference_staging_gcp_access]]. Prod project `grounded-access-142814`.
