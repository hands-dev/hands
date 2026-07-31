---
name: project_incident_bootstrap_andcli_token_skew
description: "Prod incident 2026-06-24 — hosted-runtime bootstrap wedged by AND CLI runtime token contract skew; agents stuck \"Preparing agent\""
metadata: 
  node_type: memory
  type: project
  originSessionId: eb1555db-8207-449a-bdd3-1f23c144f5cd
---

**Prod incident, 2026-06-24 (started ~12:32 UTC).** Mobile users who provision/reset a hosted agent get stuck on "Preparing agent" forever. Reported by &aaron (TestFlight, prod build). Affected ≥3 real users same day: tags **coco.claiss** (rt__1vkfjPTcNI0U3A, 12:32), **aaron** (rt_kU4snBQ13skqjcc, 14:30), **amanda** (rt_fIskGrBhK8CD_ZI, 16:10). Only pre-incident runtime `waira` (online since Jun 9) survived.

**Root cause — bootstrap-response contract skew.** The runtime **image** (GCE instance template rebuilt today 06:50 UTC, name `openclaw-rt-production-template-20260624065048…`) requires an **"AND CLI runtime token"** in the `/v1/runtimes/bootstrap` response, but the deployed **API does not emit one**. The API's `andCli` bootstrap fields last changed Jun 12 (`aee4fe14 retire hosted-runtime cli lane`, inn-135) — nothing Jun 23–24 — so the **image is the regressing side**. Warm-pool + provision-on-login is new in prod (eng-1013: shipped `3f48a2b0` Jun 22, enabled `0c53610c` Jun 23), so today's first real claims were the first to hit it.

**Mechanism (confirmed via SSH into stuck VM `openclaw-rt-production-pool-gmaprgi1ek`):** claimed pool VM redeems its one-time bootstrap grant OK, then loops every ~35s:
```
Completing runtime bootstrap from cached one-time response
Bootstrap response did not include an AND CLI runtime token
Bootstrap response AND CLI runtime token could not be stored
ampersand-runtime-bootstrap.service: exited status=75/TEMPFAIL
```
`.bootstrapped` marker never written → tenant heartbeat service skips → runtime stuck `status=provisioning` with `last_heartbeat_at`/`last_channel_poll_at`/`channel_verified_at`/`ready_at` all NULL → app polls `/v1/runtimes` forever. One-time grant already consumed → can't recover → the fleet-wide `/v1/runtimes/bootstrap` **401 storm** + `/v1/runtimes/pool/heartbeat` **410** churn.

**Ruled out:** CPUS quota (30/200), warm-pool capacity (~29 free slots), GCP identity config (API `RUNTIME_BOOTSTRAP_GCP_*` project/zone/SA/audience all match the VMs), grant integrity (secret_hash present, gcp identity pinned).

**Detection gap:** no alert fired for ~7h — nothing watches "0 `runtime.ready` in N min while provisions attempted" / "runtimes stuck in `provisioning`" / bootstrap-401 rate. Relates to [[project_provision_on_login_prod]] and [[project_eng1014_cpu_quota_alert_gated_off]] (that alert is CPUS-only; wouldn't catch this).

**Diagnosis access used:** prod project `grounded-access-142814`; gcloud `CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.12`; Cloud SQL `grounded-access-142814:us-central1:ampersand-production` via `cloud-sql-proxy` + `database-url-production` secret (read-only); api-server Cloud Run logs (httpRequest URLs surface bootstrap 401 / pool-heartbeat 410); `gcloud compute ssh --tunnel-through-iap` into a stuck pool VM for `/var/log/ampersand-openclaw-bootstrap.log` + `journalctl -u ampersand-runtime-bootstrap`.

**Refined root cause (confirmed via live template inspection):** NOT an API/image rollback issue. The post-INN-135 API + today's 06:50 instance template are already correct (AND-CLI-free, use `runtimeAuthToken`). The prod **warm pool was just never recycled** after the template changed — it was full of stale VMs baked from pre-INN-135 templates (Jun 10/12/22) that still require `andCliRuntimeToken`. Systemic gap: `reserveRuntimePoolSlotsForReconcile` counts ready slots by env+region only, NOT by `instance_template`, so stale `ready` slots count toward target and are never replaced on a template change.

**RESOLVED 2026-06-24 (forward-only, no rollback):**
1. Marked 18 stale `ready` pool slots `failed` (raw SQL mirroring `failRuntimePoolSlot`) + deleted their 18 GCE VMs → stopped new claims hitting stale VMs.
2. `POST /v1/runtimes/pool/reconcile` (×3, authToken=`api-auth-token` secret) → 23 ready slots on the correct template.
3. `POST /v1/runtimes/cohort/reprovision` for the 3 stuck runtimes (full ids: aaron `rt_kU4snBQ13skqjcc24ipBaHjt`, amanda `rt_fIskGrBhK8CD_ZIkScoxUXN7`, coco.claiss `rt__1vkfjPTcNI0U3AkJKC8k_ap`) → all 3 `online`. Bootstrap flipped from ~100% 401 to mostly 200.

**Gotchas hit during remediation (reuse next time):**
- The operator-control endpoints use a custom `authToken:` header, NOT `Authorization: Bearer` (see `apps/api/src/middleware/auth.ts` / `runtime-operator-auth.ts`).
- `RUNTIME_REPROVISION_OPERATOR_TOKEN` was **not configured in prod** (cohort/reprovision lane dead). I created secret `runtime-reprovision-operator-token` + added it to the api-server Cloud Run env (revision 00111) to run the recovery. The manual env change would have been reverted by the next `terraform apply` — **now codified in TF (ENG-1044, PR #1833 merged)** across staging/preview/prod, so the lane persists.
- `openssl rand -hex 32` appends a newline; Secret Manager stored it (65 bytes) → token-length mismatch → 401. Use `| tr -d '\n'`.
- cohort/reprovision `runtimeIds` need FULL ids (don't pass `left(id,18)` truncations → `resolved:0` no-op). Its delete-first step reports `runtime_backing_instance_delete_failed` if the VM delete op exceeds the 30s wait even though the VM does get deleted; a retry succeeds (delete treats not-found as success).

**Durable fixes — ALL SHIPPED 2026-06-24 (merged to staging):**
- **ENG-1045** (PR #1835): template-aware warm-pool reconcile — `reserveRuntimePoolSlotsForReconcile` now counts ready/active by `instance_template`, drains stale slots (→`draining`→VM delete→`retired`), and `claimReadyRuntimePoolSlot` is template-filtered. A template change now self-heals over a few reconcile ticks instead of stranding the pool.
- **ENG-1046** (PR #1836): bootstrap-failure alert — `google_logging_metric` on `POST /v1/runtimes/bootstrap` 401s + a paging `google_monitoring_alert_policy` (>30/min for 10m → #dev-team-actual), gated behind `runtime_bootstrap_alert_enabled` (default on). Closes the "nothing fired ~7h" gap.
- **ENG-1048** (PR #1839): admin runtime observability + controls — `/runtimes` list (health + status filter), `/runtimes/fleet` (assigned vs prewarmed + stale-template badges), per-andee `RuntimeHealthCard`, and reprovision/reconcile controls (admin routes proxying the operator endpoints, typed-confirm + `setAppConfig` audit). Reads are env-scoped via the admin's DB connection (staging admin shows `and-dev-89990` VMs automatically); **controls + authoritative stale-template env were wired into the PROD admin only** — staging `admin_app` would need the same `API_BASE_URL`/`RUNTIME_GCP_INSTANCE_TEMPLATE`/`RUNTIME_REPROVISION_OPERATOR_TOKEN` wiring for its controls to work (deferred).
- **Dropped:** the CI bootstrap-contract guard (template required fields ⊆ API response) — the skew was deploy-time (old template vs new API), which a same-repo guard can't catch; ENG-1045 addresses the recurrence mechanism instead.
