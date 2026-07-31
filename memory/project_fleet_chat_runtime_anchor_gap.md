---
name: project_fleet_chat_runtime_anchor_gap
description: Fleet-chat root cause — no fleet-path agent_runtimes minter + fleet-blind provisioning strands an andee (bind_failed) and drains the pool
metadata: 
  node_type: memory
  type: project
  originSessionId: af12b89a-19f9-4d06-a1bd-e0fbd3015a54
---

**Symptom:** a fleet-chat andee's mobile is stuck at "Set up agent"; fleet hosts churn `checkout.claim`/`checkout.bind` → `rejected/bind_failed`, then quarantine, draining the whole pool. Found 2026-07-30 on staging for the single fleet-chat canary `michael.phillipszz` (`andee_1772749836721_20j256u`, the only id in `FLEET_CHAT_ANDEE_ALLOWLIST`).

**Root cause chain:**
1. The fleet claim HARD-REQUIRES a pre-existing active `agent_runtimes` row to bind the checkout to: `claimAssignedTaskAndBindRuntime` (`packages/db/src/queries/agent-tasks.ts:1082-1085`) → `lockActiveAgentRuntimeForAndeeInTransaction` (selects newest row `revoked_at IS NULL AND device_reset_reserved_at IS NULL`) → throws `checkout_runtime_not_found` if none. Surfaces as `bind_failed` (`apps/api/src/lib/checkout-observability.ts` BIND_FAILURE_CODES).
2. **There is NO fleet-path minter for that row.** The ONLY inserter of `agent_runtimes` is the DEDICATED provisioner `createAgentRuntimeWithBootstrap` → `insertPendingRuntimeAssignment` (`agent-runtimes.ts:1571`). `fleet-host-provisioner.ts` explicitly creates NO agent_runtimes row. A fleet host only *binds* an existing row and stamps its own fleet VM name onto `gcp_instance_name` (`bindCheckoutRuntimeInTransaction`, `agent-runtimes.ts:2341-2360`) — nulled on unbind. So a row named `openclaw-rt-staging-fleet-*` is just a dedicated-born row a fleet host bound.
3. **Provisioning is fleet-blind.** Device "Set up agent" (`POST /v1/runtimes`, `routes/runtimes.ts:1057`) and provision-on-login (`routes/auth-mobile.ts:73-94`) mint a DEDICATED runtime+VM with no `isFleetChatAndeeEnabled` check. The only fleet gate is the matchmaker (`services/task-matchmaker.ts:45-59`, `chatCutoverBlocksAssignment`).
4. **Fleet-blind reset/reprovision strands the andee.** `runHostedRuntimeReprovisionSequence` (`hosted-runtime-provisioner.ts:401-471`, triggered by device `/reset` or operator cohort-reprovision) revokes the andee's fleet-bound row FIRST, mints a fresh dedicated row+VM; if the dedicated VM create fails, cleanup revokes that too → **zero active runtime rows** → every subsequent fleet claim `bind_failed` forever.
5. **Blast radius:** one andee with zero active runtime + a queued `chat_bridge` task drains the fleet pool — the matchmaker keeps assigning fresh hosts, each fails bind and quarantines.

`delivery_mode` is a single-value enum (`control_plane`), carries NO fleet/dedicated signal (`schema/enums.ts:466`). Only real discriminator: whether `gcp_instance_name` is a `*-fleet-*` VM.

**Fix directions:** add a fleet-path runtime-row mint (create/adopt the durable identity row WITHOUT a dedicated VM — lazily on claim, or fleet-aware provisioning); make reset/reprovision fleet-aware so it doesn't revoke a fleet andee's anchor via the dedicated path; protect the durable identity from a failed instance-create. Durable storage does NOT need to change — see [[architecture_agent_runtimes_model]] (runtime-agnostic).

**`revoked_at` is load-bearing at TWO exact seams (confirmed 2026-07-30)** — despite fleet semantics saying the row is durable identity + host is fungible, so it *shouldn't* gate: (1) **resolution** — `getActiveAgentRuntimeForAndee` (`agent-runtimes.ts:1294`) filters `isNull(revokedAt)` + tag-owner, so all-revoked → returns **null** → no runtimeId to bind; (2) **bind** — `lockOwnedActiveRuntimeForCheckout` (`agent-runtimes.ts:2196`) hard-throws `checkout_runtime_revoked` when `revokedAt !== null`. `bindCheckoutRuntimeInTransaction` "Does not insert a runtime row" — it only ADOPTS an existing non-revoked row and swaps the claiming host's `gcpIdentity` onto it (proves `gcp_instance_name` is not a durable pin). Partial unique index `(tag_id) WHERE revoked_at IS NULL` enforces ≤1 active identity/andee. Fix belongs at these two seams (+ a minter), not "keep a VM alive."

**Auto-revokers:** the ONLY reaper that tombstones a row is the pending_bootstrap GC (`recoverExpiredPendingBootstrapRuntime`, status=`pending_bootstrap` + no token/heartbeat + >15min stale + no grant). Guest-health reconcile only moves status among online/degraded/unreachable/offline — never revokes. So a manually-restored row set to **`offline`** survives.

**Staging manual-unblock recipe (2026-07-30):** with all rows revoked, un-revoke exactly one to give the canary a usable identity: `update agent_runtimes set revoked_at=null, status='offline', updated_at=now() where id='rt_...' and andee_id='andee_1772749836721_20j256u' and revoked_at is not null;` (safe vs the partial unique index because 0 non-revoked rows exist for the tag; verify tag still claimed by the andee first). Checkout bind overwrites status→`provisioning`. This is a staging-only expedient — the real fix is the minter/seam change.

**Current staging env (api-server, 2026-07-30):** `FLEET_CHAT_ANDEE_ALLOWLIST=andee_1772749836721_20j256u`, `FLEET_CHAT_ATTACH_ON_OPEN=true` (opening a conversation enqueues the chat_bridge — no first message needed), `FLEET_HOSTS_ENABLED=true`, `FLEET_HOST_READY_TARGET=2`, `FLEET_HOST_MAX_TOTAL=4`, `FLEET_CHECKOUT_CONTROL_ENABLED=true`, `FLEET_CHECKOUT_CONSUMER_ALL=true`.

**Incident actions taken (staging, 2026-07-30):** cancelled the stuck epoch-0 chat_bridge task (`terminal_code=manual_stop_inn236`) to stop the loop; decommissioned a leaked `assigned`-unbound host (deleted VM + fleet_hosts row); fleet reset to steady baseline (1 ready host, 0 tasks). **Still open:** the architecture fix above is unshipped. Debug how-to: [[reference_staging_fleet_debug]]. Distinct from the CPU/model-probe storm in [[project_inn235_checkout_watcher_backoff]] (INN-236).
