---
name: reference_fleet_runner_rollout_and_staging_api_build_skip
description: "How the fleet-host runner reaches hosts + verifying a fleet rollout, and the staging \"api image stale after merge\" footgun"
metadata: 
  node_type: memory
  type: reference
  originSessionId: ad684e25-6e85-49ce-840c-0a4bb2bd6996
---

Verifying that a fleet-host / server change actually reached staging runtimes (learned doing the INN-227 claim-long-poll rollout, 2026-07-29):

**Fleet-host runner (`checkout_executor.py`) delivery**
- The runner is **baked into the VM startup script** as a base64 blob, rendered by Terraform into a GCP **instance template** (`openclaw-rt-staging-template-fungible-<hash>`). The API's `FLEET_HOST_INSTANCE_TEMPLATE` env (on Cloud Run `api-server`) points the provisioner at the current template.
- Startup script lives in instance metadata key `ampersand-startup-script-gzip` (base64→gzip); `startup-script` is just a 601-char bootstrap that fetches it. To verify baked runner code: decode that key, find the base64 token that decodes to text containing `def watch_once`, grep for your signatures.
- Each host/template carries an `ampersand-release` metadata tag (e.g. `flh-2026.6.5-<sha>`) — the cheap way to tell old vs new hosts (`gcloud compute instances describe ... --format="value(metadata.items.filter('key:ampersand-release')...)"`).
- **Updating a running host = recreating it** (runner is baked at boot; no in-place update). Delete the old VM; the provisioner reconcile replenishes to `FLEET_HOST_READY_TARGET` from the current template. On staging `FLEET_HOST_READY_TARGET=2`, `FLEET_HOST_MAX_TOTAL=4`. The pool also self-reaps stale/old hosts, so old-runner hosts often disappear on their own within minutes of a deploy.
- Fungible fleet hosts are named `openclaw-rt-staging-fleet-*` in project `and-dev-89990`, zone `us-central1-a`.

**Staging "api image stale after merge" footgun (important)**
- A green PR + a green "Staging Deploy Orchestrator" run does NOT guarantee the api image was rebuilt. Runs can show `Get Build Config: skipped` / `Deploy API Server: skipped` and only do Terraform Apply + migrations — leaving `api-server` on an OLDER commit's image. A failed TF Apply on an earlier commit's run also skips that run's builds (staging analog of [[feedback_prod_deploy_tf_gates_images]]).
- The **api image tag IS the full git sha** (`api:<40-char-sha>`). Verify what's actually live: `gcloud run services describe api-server --region=us-central1 --format="value(spec.template.spec.containers[0].image)"` then `git merge-base --is-ancestor <yourcommit> <imagesha>`. Also check traffic is 100% on the new canary revision.
- Fix when builds were skipped: a **`workflow_dispatch` re-run** of the orchestrator on staging HEAD rebuilds+deploys (`Get Build Config: success`, `Deploy API Server: success`). The repo has `chore/trigger-redeploy*` branches for exactly this. Server-side db/query code (NOTIFY firing, route handlers) ships inside the api image — stale api = stale server logic even if migrations ran.

GCP access: `export CLOUDSDK_PYTHON=$(command -v python3.12)`; account `michael@and.com`, project `and-dev-89990`. See [[reference_staging_gcp_access]].
