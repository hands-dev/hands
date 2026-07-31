---
name: project_provision_on_login_prod
description: "Provision-on-login is LIVE in production as of 2026-06-23 — agents spin up on mobile login, always-on"
metadata: 
  node_type: memory
  type: project
  originSessionId: 11c37da4-885f-4b94-aee2-45fcf93e9433
---

Provision-on-login (ENG-1013) is **live in production** as of 2026-06-23.
`RUNTIME_AUTOPROVISION_ON_LOGIN=true` (double-gated with
`RUNTIME_AUTOPROVISION_ENABLED=true`) confirmed on the serving api-server
revision. On successful mobile auth, the API provisions the andee's hosted
runtime (idempotent; `runtime_already_exists` no-op if one is live). Agents are
**always-on — no idle reaper** (they run background loops). Code shipped in
v1.37.0; the prod flag was flipped via tfvars (`apps/infra/environments/production/terraform.tfvars`)
→ promoted staging→main (#1803, break-glass) → activated by a
production-deploy-orchestrator `workflow_dispatch` + `force_terraform=true`
(terraform-apply rolls a new Cloud Run revision with the env; image is ignored).

Fleet grows with active logins (prod ~1 login/day, so it ramps slowly).
Watch: prod runtime Mixpanel dashboard on project **3993101** (NOT 4021923 —
that wrong project has no prod events), `runtime.provision_failed` in Sentry,
and us-central1 CPUS quota (29/200; [[feedback_gcp_quota_alerting]] adds the
80% alert). Rollback: set the tfvars flag false + apply (stops NEW
login-provisions; existing VMs persist). See [[project_cycle_16_plan]].
