---
name: project_eng1014_cpu_quota_alert_gated_off
description: ENG-1014 cpu_quota_high prod alert is gated OFF pending a validated re-enable
metadata: 
  node_type: memory
  type: project
  originSessionId: a7a60f22-870b-4237-9900-0bf6240d2ff0
---

The `google_monitoring_alert_policy.cpu_quota_high` in
`apps/infra/environments/production/monitoring.tf` (ENG-1014, the us-central1
CPUS-quota early-warning for the always-on runtime fleet) is **gated OFF**
(`local.cpu_quota_alert_enabled = false`, `count = 0`) on both main and staging
as of 2026-06-24.

**Why:** it had never applied successfully — a chain of GCP AlertPolicy
validation errors surfaced one-at-a-time while shipping v1.38.0: (1) the prod
TF SA lacked monitoring perms (fixed: granted `roles/monitoring.editor` to
`ci-deploy-production`), (2) `0s` duration is invalid with
`evaluation_missing_data` set (fixed → `60s`), (3) `COMPARISON_GE` is
unsupported, only LT/GT (fixed → `COMPARISON_GT` with `threshold-1` to preserve
≥160). After 3 errors it was gated off to stop blocking the prod deploy —
net-neutral since it was never live.

**Follow-up (ENG-1014):** validate the full policy in isolation (e.g. `gcloud
monitoring policies create` on a scratch policy in `grounded-access-142814`),
confirm no remaining field errors, then flip `cpu_quota_alert_enabled = true`.
Until then the runtime fleet has **no CPUS-quota alert** — watch
`runtime.provision_failed` (Sentry) + Mixpanel 3993101 manually. Related:
[[project_provision_on_login_prod]], [[feedback_prod_deploy_tf_gates_images]].
