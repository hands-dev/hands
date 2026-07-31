---
name: feedback_prod_deploy_tf_gates_images
description: Prod/preview deploy gotchas — Terraform Apply gates image builds + deploys; gh workflow_dispatch 401 from GH_TOKEN env
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a7a60f22-870b-4237-9900-0bf6240d2ff0
---

Production release gotchas learned shipping v1.38.0 (2026-06-24).

**Terraform Apply (Production) gates the whole backend pipeline.** Both
`preview-deploy.yml` (on main push) AND `production-deploy-orchestrator.yml`
run `Terraform Apply (Production)` as an early job. If it fails, the
`api:<sha>` / `mcp:<sha>` image builds AND all Deploy jobs are **skipped** —
so a broken TF resource silently means "no images built, nothing deployed."
The orchestrator promotes `api:<sha>`/`mcp:<sha>` by SHA (built by
preview-deploy on the main-merge commit), so if preview-deploy failed at TF,
`gcloud artifacts docker tags list .../ampersand-apps/api` won't have that SHA.
Use the orchestrator's `image_sha` dispatch input to point at a SHA that has
images. **Why:** one TF failure looks like many downstream failures; fix the
TF step first.

**`gh workflow run` 401 (Bad credentials) despite working `gh pr` commands:**
a stale `GH_TOKEN`/`GITHUB_TOKEN` env var shadows the keyring token for the
dispatch API. Fix: `GH_TOKEN= GITHUB_TOKEN= gh workflow run ...`.

**Prod migrations run during BOTH preview-deploy (on main push) and the
orchestrator.** v1.38.0's additive `0081` applied during the post-merge
preview-deploy, before the orchestrator's service deploy — benign because it
was additive. The orchestrator's migration job is then a no-op.

**`ci-deploy-production@grounded-access-142814.iam.gserviceaccount.com`** is the
prod Terraform applier (the `GCP_SA_KEY` identity). See
[[reference_gcp_projects]]. Per-service admin roles; grant it new role scopes
when TF manages a new resource type. Re-run via
`gh workflow run production-deploy-orchestrator.yml --ref main` (workflow_dispatch,
no re-tag). See [[feedback_smoke_flake_prevention]] for the smoke gate.
