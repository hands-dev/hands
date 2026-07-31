---
name: project_reset_andee_signals_tool
description: reset-andee-signals QA script + ENG-1161 account-deletion FK fix (fresh-andee reset without deleting account)
metadata: 
  node_type: memory
  type: project
  originSessionId: e92aac2c-5bcd-405c-ad68-9905d9803250
---

Reusable "experience the app as a fresh andee" reset, built 2026-07-01. **MERGED to staging via PR #1969 (`869106f2`, admin-merged skipping checks); ENG-1161 marked Done.** Reset was actually EXECUTED for &michael in prod 2026-07-01 (wiped 35 identity_signals, 35 signal_suggestions, 5 loops, 10 raw_signals + 10 GCS blobs, revoked 1 runtime; verified all-zero after). Prod GCS bucket = `grounded-access-142814.appspot.com` (from api-server Cloud Run env `GCS_STORAGE_BUCKET`).

**Tool:** `packages/db/src/scripts/reset-andee-signals.ts`. Resolves andee by `--tag`/`--andee-id`/`--phone`; dry-run by default (prints per-table counts + target DB host), `--yes` executes an all-or-nothing tx reusing `andee-data-ops` helpers; revokes the hosted runtime (so provision-on-login mints a fresh one — old GCP VM is NOT reaped, no fleet reaper); `--gcs` sweeps `raw-signals/{andeeId}/` blobs. Keeps account/auth (andees, tags, otp/phone, devices, push_tokens, payments) + connections/contacts. Wipes identity_signals, signal_suggestions, place_affinities, photo_scan_runs, raw_signals, interview_card_responses, peer_questions, agent_prompts, identity_*_permissions, loops.
Run: `cd packages/db && DATABASE_URL=... pnpm tsx src/scripts/reset-andee-signals.ts --tag michael [--yes --gcs]`.

**ENG-1161 (bug found + fixed):** `account-deletion.ts` AND `teardown.ts` deleted the andees row without purging child tables whose andee FK is `ON DELETE no action` → final `deleteAndeeRecord` FK-fails and rolls back the whole tx for any andee with place/photo/suggestion data. Missing: `signal_suggestions`, `place_affinities`, `photo_scan_runs` (both flows) + `raw_signals` (teardown only). `signal_suggestions.accepted_signal_id` also FKs identity_signals → must delete before `deleteSignals`. Cascades (fine): agent_prompts, interview_card_responses, connect_suggestion_dismissals. Fix = new `deleteSignalSuggestions`/`deletePlaceAffinities`/`deletePhotoScanRuns` helpers wired into both flows + tests. Latent because prod raw-signal throughput was ~0 until late-June ([[project_raw_signal_zero_prod_throughput]]).

**DEFERRED to 2026-07-02+: reap orphaned agent VM(s) for &michael.** Investigation done, deletion NOT yet performed.
- ONLY ONE live orphaned VM remains: `openclaw-rt-production-pool-jo3jyhb7j6` (zone us-central1-a, project grounded-access-142814, RUNNING). It's the pool-slot VM claimed by the reset-revoked runtime `rt_bYlYYH0vY7K_ebVJDL04i18s`; pool slot `rps_5gopr6bo7c5ozggx4q2p` still `status=claimed` (retired_at null).
- The other 3 revoked-runtime VMs (`openclaw-rt-production-michael-34550715`, `-pool-7b2i0exncm`, `-pool-o5xh0qsu0o`) already DELETED in GCP — but their pool slots `rps_p0e34t8198mh1iv8tbpn` + `rps_1ialusdj6hin9bjjskpi` are STILL `claimed` (no retired_at/failed_at) → stale slot bookkeeping pointing at gone VMs + revoked runtimes.
- Reap plan: delete VM jo3jyhb7j6 AND retire slot rps_5gopr6bo7c5ozggx4q2p; also retire the 2 stale claimed slots. CAUTION: pool VMs (`openclaw-rt-production-pool-*`) are managed by a reconciler via `runtime_pool_slots` — don't raw `gcloud compute instances delete` without retiring the slot or the reconciler drifts. Prefer the provisioner/control-plane path: `retireRuntimePoolSlot` + instance delete live in `apps/api/src/services/hosted-runtime-provisioner.ts` (COMPUTE_DELETE_INSTANCE_* + `retireRuntimePoolSlot` import). STILL TODO: read that file's recycle logic (~L800-840) to see if a claimed-slot-with-revoked-runtime is auto-recycled (memory says "no reaper" — likely not).

**Prod DB proxy port gotcha:** a staging cloud-sql-proxy often already holds :5433, so launch the prod proxy on a different port (used :5434). Prod: `grounded-access-142814:us-central1:ampersand-production`; parse pw from secret `database-url-production`; `ampersand` user is read/write. Michael in prod = andee `4DHFDJ8Uccv8nmGr8nG7Yj9nm9zS` (tags michael / michael.phillips / michaelphillips). See [[reference_staging_gcp_access]].
