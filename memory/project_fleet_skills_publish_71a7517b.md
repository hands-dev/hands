---
name: project_fleet_skills_publish_71a7517b
description: "In-progress prod fleet skills OTA rollout (release ocr-2026.6.5-71a7517b) — canary done, all-widen pending, temp env drift to revert"
metadata: 
  node_type: memory
  type: project
  originSessionId: 00214d03-412c-4636-92e5-443f638447cf
---

Prod runtime-VM skills rollout in progress (2026-07-02). Publishing the `main`-HEAD skill bundle to the OpenClaw fleet after it drifted behind (photo-location-identity ENG-1073/1055 + gtkm/loop-starter fixes were merged but never published).

**Release:** `ocr-2026.6.5-71a7517b` / skills digest `sha256:71a7517bb97e00c5705c214f5a33dad055fd75994a5bc8f7a96aa048a1b829c7` (11 skills: 9 `ampersand-*` loop starters + `loop-skill-authoring` + `photo-location-identity`). Superseded the prior desired-release `ocr-2026.6.5-381dbc63`.

**State (as of 2026-07-02 ~06:43 UTC):**
- ✅ Archive built + signed canary desired-release (cohort `team`) accepted 200.
- ✅ Canary = `aaron` (runtime `rt_QCwoG1CbhlPjaCZEIDm6PKkG`, on pool VM `openclaw-rt-production-pool-bd6x3dc3si` us-central1-a). Converged, 0 apply errors. IAP-SSH probe: all 11 skills on disk at `/var/lib/ampersand-runtime/workspace/skills`, `photo-location-identity` + `ampersand-get-to-know-me` SKILL.md sha256 MATCH main source (35059fcd… / 2cd79e4e…).
- ✅ Behavior proof (content-integrity attestation) + **widen to `--cohort all` signed & accepted 200**.
- ✅ **COMPLETE — fleet 8/8 converged on `71a7517b`, 0 divergent, 0 apply errors** (waira + jodi caught up too once a fresh release landed — they were NOT permanently stuck).
- ✅ Temp env drift REVERTED: `RUNTIME_OTA_TEAM_TAGS` removed from prod `api-server` (rev `api-server-00140-mht`). Back to fail-closed empty `team`; cohort is `all` so it's moot.

**DONE 2026-07-02 ~06:48 UTC. No open follow-ups from this rollout.** (The photo-location-identity skill is now live fleet-wide; if the enrichment consumer is still gated, flipping `enrichment_agent_trigger_enabled` per ENG-1055 is the separate next lever.)

**TEMP DRIFT TO REVERT:** set `RUNTIME_OTA_TEAM_TAGS=aaron` on prod `api-server` via out-of-band `gcloud run services update` (rev `api-server-00139-jc6`) so the `team` cohort was non-empty (percentage:1 selects 0 on this ~8-VM fleet; team was unset/fail-closed). Codify in `apps/infra/environments/production/terraform.tfvars` (`runtime_ota_team_tags`) or revert after all-widen — next prod TF apply reverts it anyway.

**How to run the publish (creds sourced live, nothing stored):** `scripts/fleet/publish-skills.sh` with `API_BASE_URL=https://api-server-prk5coam3q-uc.a.run.app`, `API_AUTH_TOKEN`←secret `api-auth-token`, `RUNTIME_OTA_OPERATOR_TOKEN`←secret `runtime-ota-operator-token`, `RUNTIME_OTA_SIGNING_PUBLIC_KEY`←`gcloud kms keys versions get-public-key 1` (impersonating `runtime-ota-signer-production@grounded-access-142814…`), `KMS_CRYPTO_KEY_VERSION=…/runtime-ota-production/cryptoKeys/runtime-ota-signing/cryptoKeyVersions/1`, and **`RUNTIME_OTA_KMS_IMPERSONATE_SERVICE_ACCOUNT=<signer SA>`** (the Node signer's own impersonation var — NOT gcloud's `CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT`). michael's ADC has KMS viewer + token-creator on the signer SA.

**Fleet health note:** `waira` + `jodi` are stuck divergent on an older image (`ocr-2026.6.5-3e5319a3`, null skills digest) — a publish alone won't move them; needs separate diagnosis. Only `mychal-shaw` shows a GCE tenant-labeled instance; other claimed runtimes run on pool VMs that keep their `-pool-` name (binding is in `agent_runtimes.gcp_instance_name`, not GCE labels).

Related: [[project_eng1055_capability_skill_paved_path]], [[project_eng1073_merged_rollout_pending]], [[reference_gcp_projects]].
