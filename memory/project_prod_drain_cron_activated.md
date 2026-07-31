---
name: project_prod_drain_cron_activated
description: Raw-signal drain cron activated in production (ENG-1089); alert follow-up still pending
metadata: 
  node_type: memory
  type: project
  originSessionId: d4ee228e-b896-4ed1-8a16-ae8762766330
---

The raw-signal drain cron is **live in production** as of 2026-06-26 (ENG-1089, tag `v1.42.1`).

- Flipped `raw_signal_drain_cron_enabled = true` in `apps/infra/environments/production/terraform.tfvars`. Hotfixed straight to main (PR #1885, cherry-pick of staging #1884) to avoid dragging the in-flight staging→main loops release (3 DB migrations incl. `0090_loops_skills_v1_7_0`). Cron change is also on staging, so no regression on the next promotion.
- Verified: Cloud Scheduler `raw-signal-drain-production` (us-central1, `*/5`, ENABLED) fires; `raw_signal.drain_swept` structured logs appear (that log is inside the handler, so its presence proves the OIDC auth passed and the api-server has `RAW_SIGNAL_DRAIN_SCHEDULER_SA` — i.e. not 503). First clean ticks 17:30/17:35 UTC: extracted/failed/deadLetters all 0.

**BLOCKED follow-up (ENG-1089 step 2): the failure ALERT is reverted, NOT yet live.** Flipping `raw_signal_drain_alert_enabled = true` (#1886) failed the prod TF apply TWICE with `Error 404: Cannot find metric(s) ... cloudscheduler…/job/attempt_count label=response_code` — the label hadn't propagated even ~20 min after the cron started firing (past GCP's "up to 10 min"). That apply runs in preview-deploy on every main push and gates image builds, so I reverted it (#1887, merge b6bf5a67) to restore the green cron-only state. `raw_signal_drain_alert_enabled` is back to `false` (monitoring.tf:54).

**Before re-attempting the alert:** (1) confirm the `response_code` label is queryable (`gcloud monitoring time-series list` for the metric, or scratch-validate the AlertPolicy in isolation); (2) SUSPECTED chicken-and-egg — the alert filter is `response_code != "ok"`; if Cloud Scheduler only materializes the `response_code` label series on a NON-OK attempt, an all-green cron may never create the series → the AlertPolicy create keeps 404ing. Verify whether the label exists with only `ok` attempts before flipping again. This is the same "metric-must-exist-before-AlertPolicy" gotcha as the cpu_quota_high + runtime_bootstrap alerts.

Related: drain cron design [[project_prod_deploy_ordering_risk]]; dead-letter hygiene follow-up ENG-1090 ([[MEMORY]] — retention GC + stranded-pending alert, lands after this). Prod release mechanics: orchestrator triggers on `v*` tag/dispatch only (push to main = preview); tag the merge commit ([[feedback_tag_on_staging_merge]]).
