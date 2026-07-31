---
name: project_eng1055_capability_skill_paved_path
description: Paved path to publish agent capability skills to runtime VMs + pending photo→identity activation (ENG-1055)
metadata: 
  node_type: memory
  type: project
  originSessionId: 84faa8c3-0127-4af5-892e-bef86b4a8cf4
---

ENG-1055 (PR #1851 → staging, branch `feature/eng-1055`) generalizes the loop-skill delivery machinery to also publish agent **capability** skills to hosted OpenClaw runtime VMs.

- New source tree `apps/infra/modules/openclaw-runtime/openclaw-capabilities/` (capability skills) alongside `openclaw-skills/` (loop starter skills). Both merge into the VM's single `workspace/skills/` tree via the same boot inject (`main.tf` fileset) + OTA archive (`runtime-skills-archive.ts`). Skill names must be globally unique across the two dirs — the archive builder fails the build on a collision.
- `photo-location-identity` moved here from `.agents/skills/` (it was never loaded by the API in-process loader; the runtime needs it and had no delivery path — the reason the photo→identity pass was dark).
- One-command publish: `scripts/fleet/publish-skills.sh` → `/fleet/skills-archive` → off-host KMS `sign-desired-release.ts` → `/fleet/desired-release` → optional `--wait-convergence`. Runbook: "Publish A Skill Bundle (paved path)" in `docs/infrastructure/runbooks.md`.

**Activation progress (as of 2026-06-25):**
- ✅ #1851 merged to staging; Staging Deploy Orchestrator deployed+promoted api-server. Deployed API confirmed bundling `photo-location-identity` (10 skills incl it).
- ✅ One-time operator grant applied: `michael@and.com` now has `serviceAccountTokenCreator` on `runtime-ota-signer-staging` SA + `cloudkms.viewer` on `runtime-ota-staging` keyring (kevin@and.com already had both). Required to KMS-sign manifests; not in IaC by design.
- ✅ **Staging skills-delivery canary DONE.** Published `photo-location-identity` via `publish-skills.sh --cohort percentage:1` → desired `ocr-2026.6.5-a97f544d` (skills digest a97f544d, engine 2026.6.5). Landed on `kevin.manase` (the only VM in hash%100==0 bucket); VM converged in-place (imageVersion+skillsDigest match, no reboot, no error). Other 5 VMs correctly excluded.
- ✅ #1855 (branch `fix/eng-1055-publish-wrapper-authtoken`) fixes two wrapper bugs found live: it used `Authorization: Bearer` but `authMiddleware` reads a custom `authToken` header; and `--wait-convergence` polled fleet-wide totals (never settles for a canary cohort) — now cohort-aware (counts VMs on the release).

**Cohort facts learned:** `team` cohort = VMs whose `tagId` ∈ api-server env `RUNTIME_OTA_TEAM_TAGS` (fail-closed; **unset in staging** → selects nobody). `percentage:1` = deterministic `hash(runtimeId)%100==0` bucket. Enabled skills release widened to `all`/`percentage>1` REQUIRES a `--behavior-proof-file` (gate enforced in BOTH envs, not env-conditional) — produce it from the canary first.

**STAGING ACTIVATION COMPLETE (2026-06-25):**
- ✅ Trigger ON: #1856 flipped `enrichment_agent_trigger_enabled = true` (staging tfvars), deployed — `ENRICHMENT_AGENT_TRIGGER_ENABLED=true` verified live on api-server.
- ✅ Team allowlist: #1858 wired `RUNTIME_OTA_TEAM_TAGS` on staging api-server = the 6 internal staging tagIds (`amanda.zimmmerman` [sic, 3 m's — matches stored tagId], `waira.mungai`, `kevin.manase`, `dan.carroll`, `michael.phillipszz`, `aaron`). NOTE: cohort matches the STORED tagId verbatim — Greptile flagged the spelling but the values are exact copies from /fleet/convergence (refuted).
- ✅ Widen: `publish-skills.sh --cohort team` (proof-free) → **all 6 staging VMs converged** to `ocr-2026.6.5-a97f544d` (skills a97f544d), 0 apply errors. michael.phillipszz HAS the skill → Michael's agent can re-run photo scans end-to-end (scan → drain → `<&enrichment-ready>` → photo-location-identity drafts via location_read).
- ✅ Wrapper fixes #1855 merged (authToken header + cohort-aware wait). NOTE the cohort-aware wait still settles eagerly (2-poll/30s stability) — for a multi-VM cohort, verify full convergence manually (count VMs on the release) since the first already-converged VM trips the stability check; a real follow-up improvement is to wait for the full in-cohort count.

**PRODUCTION ACTIVATION (in progress, 2026-06-25):**
- ✅ Promoted v1.41.0 staging→main (#1860, merge commit d3a79187), tagged `v1.41.0`, prod backend orchestrator deployed api/mcp/web/admin. mobile-deploy production/all succeeded.
- ✅ Prod OTA bucket bug FIXED: the prod api GCS client authenticates as `firebase-adminsdk-fbsvc@grounded-access-142814` (a creds file overrides ADC; staging uses the runtime SA), which lacked access to the UBLA OTA bucket → skills-archive 500. Granted it `roles/storage.objectUser` on `grounded-access-142814-runtime-ota-artifacts` out-of-band. **NEEDS CODIFYING in prod TF** (runtime-ota-signing.tf bucket IAM grants the runtime SA, not the firebase-adminsdk SA the client actually uses).
- ✅ Prod signer impersonation granted (michael@and.com: tokenCreator on runtime-ota-signer-production + cloudkms.viewer on runtime-ota-production keyring).
- ✅ Prod skill published: canary percentage:1 (mychal.shaw) then widened `cohort=all` with a behavior proof. **Proof was convergence+health-scoped (transparent summary), NOT an observed draft** — no headless way to drive a real agent turn; user approved widening on that basis with the trigger gated.
- ⚠️ Prod skill only on **4/10 VMs** (mychal.shaw, aaron, coco.claiss, amanda — current 2026.6.5 template). The other **6 are PRE-OTA** (openclaw 2026.5.28, no updater, imageVersion=null): `michael`, `kevin.manase`, `dan.carroll`, `santychuy`, `waira`, `amanda.zimmmerman`. They CANNOT converge via OTA.
- ⚠️ `/cohort/reprovision` of the 6 (operator-token, destructive, NOT retry-safe) FAILED: 5×`runtime_backing_instance_delete_failed` + 1 skipped, 0 reprovisioned, halted. Root cause = the endpoint times out waiting on the GCE delete operation (`compute.../operations/.../wait` network timeout — pre-existing bug `AMPERSAND-API-1M`, 25 events/3 days). **No VMs were deleted — all 6 still online + intact** (safe no-op). Reprovision tooling is broken; do NOT blindly re-fire.
- ⏸️ Trigger flip #1861 (`enrichment_agent_trigger_enabled = true` in production/terraform.tfvars) MERGED to staging (commit 92be2aed), NOT yet promoted to main → **prod trigger still OFF**. Next: promote staging→main → tag `v1.41.1` → orchestrator.

- ✅ Reprovision bug FIXED + shipped: #1862 — `isRetryableProvisioningError`/`isGoogleClientRequestTimeout` now recognize node-fetch's `type:'request-timeout'` (+ `network timeout at:` message) so the operation `.wait` timeout falls into the gone-check fallback instead of falsely reporting `runtime_backing_instance_delete_failed`. Regression test added.
- ✅ Promoted v1.41.1 (#1863, merge e061997b) → tag v1.41.1 → prod orchestrator deployed. **Prod trigger now ON** (`ENRICHMENT_AGENT_TRIGGER_ENABLED=true`, revision api-server-00118-knl) → enrichment LIVE for the 4 already-converged prod VMs.
- ✅ Re-ran `/cohort/reprovision` for the 6 pre-OTA VMs with the fix deployed → **all 6 reprovisioned, 0 failed** (rebuilding on 2026.6.5 template with photo-location-identity baked). Convergence to all-10 in progress (VMs provision→bootstrap→online over a few min).

**STATUS: prod activation essentially COMPLETE** (trigger ON fleet-wide; 4 converged + 6 reprovisioning to converge). michael's VM was reprovisioned and will carry the skill once online.

- ✅ #1865 merged + deployed (v1.41.2): env main.tf (both) now bake openclaw-capabilities into the VM template (the #1851 gap — envs had their OWN inline skills local reading only openclaw-skills; module fix didn't cover them) + codified the firebase-adminsdk OTA-bucket grant. Confirmed: the new prod template bakes photo-location-identity. firebase-adminsdk grant codified; per-operator signer/kms grants intentionally NOT (per runbook).

**INCIDENT (self-inflicted, 2026-06-25, recovered): reprovision grant-churn.** Reprovisioning the 6 pre-OTA prod VMs repeatedly (the fix worked on retry, but I fired 6-at-once 3×, one 504'd mid-flight) churned bootstrap grants → 5 EMPLOYEE runtimes stuck in `pending_bootstrap` with `revoked_grant` (backing VMs running, never bootstrapped). NOT systemic (dan.carroll reprovisioned fine). Recovery: reprovision only targets ACTIVE runtimes, so it can't fix pending_bootstrap rows. The built-in path is `recoverExpiredPendingBootstrapRuntimesBestEffort` on device `GET /v1/runtimes` (app-open) after the 15-min `PENDING_BOOTSTRAP_RECOVERY_GRACE_MS` → deletes stuck backing VM + revokes row → next provision makes a fresh skill-baked VM. **I deleted the 5 stuck backing VMs** (michael, kevin.manase, santychuy, waira, amanda.zimmmerman) so they self-heal + stop costing; they re-provision WITH the skill on next app-open.

**FINAL PROD STATE:** trigger ON; 4 VMs have the skill via OTA (aaron, amanda, coco.claiss, mychal.shaw); 5 employee VMs self-heal w/ skill on next app-open; dan.carroll online but on the OLD template (no skill — won't auto-heal since it's not stuck; needs a single clean reprovision or natural cycle). Template-bake means ALL future provision-on-login VMs get the skill.

**michael RESOLVED (2026-06-25 ~12:30):** Michael booted his own agent (app-open → device-auth provision; there is NO operator API to provision a new runtime for an andee — provision is device-auth only). michael came online cleanly BUT claimed a stale warm-pool slot (stamp ocr-2026.6.5-7df9243b, no skill) — 6th gap below. Fixed via OTA, not reprovision: re-minted desired release as `--cohort percentage:100` (= all, but NEW fingerprint so the replay-ignore + stale-guard release; same release/digest a97f544d, reused the <24h behavior proof). michael + ALL online VMs became eligible and OTA-applied the skill in place → **7/7 online VMs have the skill, michael included.** This is the clean low-risk heal for stale/pool-claimed VMs (no teardown, no grant churn).

**6th GAP — warm-pool staleness:** the 48 warm-pool VMs are a mix of pre- and post-skill-bake templates; provision-on-login can claim a pre-bake slot → new VM lacks the skill until an OTA re-mint (and re-mints only help VMs online at mint time; provision-on-login VMs are always created after the last mint → stale-guarded). Durable fix = drain/recycle the pre-bake pool VMs so every slot boots from the skill-baking template. Until then, freshly-provisioned VMs may need an OTA re-mint to get the skill.

**FOLLOW-UPS for the team (NOT done):**
- **Warm-pool recycle** after a template/skill change (6th gap above) — otherwise pool-claimed provisions miss new baked skills.
- `/cohort/reprovision` **504s** on large batches (synchronous; exceeds gateway timeout) — chunk internally or go async. Do reprovisions in SMALL batches (1-2) until fixed.
- Reprovision **grant-churn**: overlapping/repeated reprovisions revoke in-flight grants → stuck pending_bootstrap. Needs a guard / idempotency.
- dan.carroll still needs the skill (single clean reprovision when convenient).
- Sentry AMPERSAND-API-1W (bucket, fixed) + 1M (reprovision node-fetch, fixed by #1862).
- The prod cohort=all behavior proof was convergence+health-scoped, not an observed draft.

Never flip the trigger before the skill is live on the fleet, or runtimes get `<&enrichment-ready>` with no consumer. Related: [[project_provision_on_login_prod]], drain cron ENG-1036.
