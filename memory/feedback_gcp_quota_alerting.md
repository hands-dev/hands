---
name: feedback_gcp_quota_alerting
description: How to build a GCP CPUS-quota Cloud Monitoring alert that actually fires (MQL ratio fails; use absolute threshold)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 11c37da4-885f-4b94-aee2-45fcf93e9433
---

Building a Cloud Monitoring alert on GCP Compute CPUS quota (prod
`grounded-access-142814`): use an **absolute threshold on the usage metric**,
not an MQL usage/limit ratio.

**Why:** `serviceruntime.googleapis.com/quota/allocation/usage` and
`.../quota/limit` join poorly in MQL `ratio` — `limit` carries an extra
`limit_name` identifier column so the join yields 0 series unless you
`group_by` both sides down to matching columns, and even then it was flaky to
validate via `timeSeries:query`. A ratio that silently never fires is worse
than no alert. Instead: `condition_threshold` filtered to
`metric.label.quota_metric="compute.googleapis.com/cpus"` AND
`resource.label.location="us-central1"` (the regional series; there's also a
zonal `us-central1-a` duplicate), `ALIGN_MAX` over 3600s, fire at >160 (=80% of
the 200 limit), `EVALUATION_MISSING_DATA_INACTIVE`. The limit (200) changes
only when you request a quota increase, so bump the threshold then.

**How to apply:** the usage metric is sampled **only on allocation changes**
(event-driven) — a 1h `timeSeries` window can be empty even though data exists;
query ≥26h to see points. That sparsity is fine for the alert (usage climbing
toward the ceiling IS an allocation change → fresh samples when it matters).

**gcloud for prod:** the CLI needs Python 3.10–3.14 — prefix with
`CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.12`. `michael@and.com` has prod
project read access. Implemented in `apps/infra/environments/production/monitoring.tf`
(ENG-1014, PR #1804). Native Slack notification channel → #dev-team-actual needs
a one-time "Google Cloud Monitoring" Slack app OAuth → token into GitHub secret
`TF_VAR_monitoring_slack_auth_token`; gated on that var so apply stays green
until set. See [[project_provision_on_login_prod]], [[reference_staging_gcp_access]].
