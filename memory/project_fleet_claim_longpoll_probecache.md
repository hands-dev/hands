---
name: project_fleet_claim_longpoll_probecache
description: Fleet-host chat-ready latency — NOTIFY-woken /hosts/claim long-poll + OpenClaw probe cache (INN-227). LIVE on staging.
metadata: 
  node_type: memory
  type: project
  originSessionId: ad684e25-6e85-49ce-840c-0a4bb2bd6996
---

Shipped 2026-07-29 (PR #2322, commit `7e125aa8`, referenced INN-227) and **LIVE on staging** (api `32a01e5a` @ 100%, fleet hosts on release `flh-2026.6.5-3108214c`). **Not yet in prod.** Cut warm fleet-host chat-ready latency ~15-60s → ~3-6s by removing the two dominant waits on `unassigned → assigned → serving`.

What changed (files other worktrees will touch):
- **New Postgres NOTIFY channel `fleet_host_assigned`** (`packages/db/src/queries/task-events.ts`). `assignQueuedTaskToHostAtomic` (agent-tasks.ts) fires it transactionally on assign; `enqueueTaskInTransaction` (task-enqueue.ts) also fires it for **pre-pinned** enqueues (evict/fleet_upgrade) so an eviction interrupts a host's claim long-poll. Distinct from `task_work_queued` (which fires on enqueue, before host choice).
- **`POST /v1/fleet/hosts/claim` is now a long-poll** (`apps/api/src/routes/fleet.ts`): accepts `waitMs`, sliced NOTIFY-woken wait via new `apps/api/src/services/fleet-host-wakeup.ts` (mirrors `runtime-channel-wakeup.ts`). `waitMs` absent ⇒ byte-identical single-shot claim. On a no-work long-poll it sets response header `X-Fleet-Long-Polled: 1`.
- **Runner** (`apps/infra/modules/openclaw-fleet-host/runner/checkout_executor.py`): `claim()` sends `waitMs` and returns `ClaimResult(claim, server_long_polled)` keyed off that header (NOT an elapsed-time guess). Short-TTL (30s) andee-agnostic model-probe positive cache (`chat_model_access_cache_fresh`/`mark_...`/`invalidate_...`) keeps the ~13-17s OpenClaw probe off the claim path; invalidated on any chat-serve failure so a host that lost model access stops advertising `chat` immediately.

**Why:** relates to [[project_eng1384_fleet_chat_open_attach]] and [[project_chat_turn_lifecycle_and_instance_page]]; the claim/serve path is now evented, not polled.

**How to apply:** if you touch the fleet claim path, remember the claim is a long-poll and assignment/eviction both fire `fleet_host_assigned`. Deferred follow-ups (do NOT re-review as new): telemetry — claim-latency metric scoping, a wakeup-miss Sentry capture, and a shared `longPollClaim` helper — are parked for the [[project_sentry_distributed_tracing_worktree4]] work. Known debt: the pg-LISTEN waiter scaffolding is now triplicated (task-events, runtime-channel-wakeup, fleet-host-wakeup), and idle hosts each hold a ~25s request slot on the shared `api-server` Cloud Run service (fine at the current tiny fleet, revisit at scale). Rollout/verify procedure + the "green deploy can skip the api build" footgun are in [[reference_fleet_runner_rollout_and_staging_api_build_skip]].
