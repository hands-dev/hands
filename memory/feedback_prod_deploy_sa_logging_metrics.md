---
name: feedback_prod_deploy_sa_logging_metrics
description: Prod deploy SA lacked logging.logMetrics.create; a new google_logging_metric in prod TF fails the apply (and gates ALL image builds + deploys)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b0498746-89b9-4979-a6bc-62a1729a8382
---

The prod Terraform deploy SA `ci-deploy-production@grounded-access-142814.iam.gserviceaccount.com` had `roles/monitoring.editor` (alert policies OK) but **no logging role**, so it could not create log-based metrics (`logging.logMetrics.create`). When v1.39.0 added the ENG-1046 `google_logging_metric.runtime_bootstrap_unauthorized` to `apps/infra/environments/production/monitoring.tf`, `Terraform Apply (Production)` 403'd — which per [[feedback_prod_deploy_tf_gates_images]] skipped api/mcp image builds + all deploys in BOTH preview-deploy and the orchestrator.

**Why:** prod deploy SA is tightly scoped; a new resource type can need an IAM role the SA doesn't have. The 2026-06-24 v1.39.0 release deploy failed twice on this before the fix.

**How to apply:** On 2026-06-24 I granted `roles/logging.configWriter` to that SA via `gcloud projects add-iam-policy-binding grounded-access-142814` (CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.12, authed as michael@and.com). This grant was **out-of-band, not in Terraform** → drift. FOLLOW-UP: codify the binding in `apps/infra` (or confirm prod SA roles aren't managed by an authoritative `google_project_iam_policy` that would revoke it on next apply), or the bootstrap-failure metric breaks again. Recovery sequence after granting: `gh run rerun <preview-deploy> --failed` (rebuild images) → `gh run rerun <orchestrator> --failed` (Deploy API/MCP find the image). ENG-1046's whole block is gated behind `runtime_bootstrap_alert_enabled` (default true) as the documented escape hatch — flip to false in prod variables.tf to ship without the alert if the perm can't be granted.
