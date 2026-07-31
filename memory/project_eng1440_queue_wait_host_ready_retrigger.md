---
name: project_eng1440_queue_wait_host_ready_retrigger
description: ENG-1440 chat queue-wait first-hop fix — matchmaker re-run on host-ready; PR
metadata: 
  node_type: memory
  type: project
  originSessionId: 9f96329b-6761-469b-bfcc-135d761aa416
---

ENG-1440 (cycle 26, wt5/Casey) — the chat **queue-wait first-hop** fix, the real cause of the multi-minute `queue_wait` ENG-1421's metric surfaced. Root: the on-enqueue fast path (`matchTaskById`, INN-196) only fires at ENQUEUE; when no host is ready+capable then (fungible host flapping through cold-boot capability attestation), the task waits for the next batch drain tick. Nothing re-ran the matcher when a host *became* eligible.

Fix (api-server, normal deploy, NO host reprovision): the `/hosts/heartbeat` route now fire-and-forget calls `noteFleetHostHeartbeatForMatch` → `matchQueuedTasksForReadyHost` the instant a host attests `ready`+caps. Host-scoped (one task/host, capability-filtered — no whole-queue re-match), reuses the shared atomic `assignQueuedTaskToCapableHost` (no second matcher). In-memory false→true eligibility EDGE detection + per-host 5s debounce (Sam's flap gotcha). New `apps/api/src/services/task-matchmaker-host-ready.ts`. `ORCHESTRATOR_ASSIGNED.trigger` += `on_host_ready`.

**Status:** branch `feat/matchmaker-host-ready-retrigger`, **PR #2377** (base staging) — **HOLD MERGE** per foreman (mid staging canary-reprovision; merge = concurrent TF apply). Foreman batch-merges once canary+traffic-promote settle. 221 tests green.

**INN-240 correction (non-obvious):** STAGING already has `cpu_idle=false` + `api_server_min_instances=1` (default 1) with INN-240 comments — LISTEN already survives on staging, so ENG-1440 (not INN-240) is the staging queue-wait win. The ONLY residual INN-240 gap is **prod** `main.tf` `cpu_idle=true` (throttles the LISTEN callback between requests) → going to Michael as a separate prod-only infra/cost decision, NOT bundled. Supersedes the "fix cpu_idle on staging" framing in [[project_inn240_notify_wake_dead_cloudrun]].

Deferred: drain-cadence stopgap (`*/5`→30-60s) — matchmaker batch rides the SHARED `raw_signal_drain` Cloud Scheduler cron (internal.ts:292); scheduler floors at 1min (30-60s impossible) and `*/1` 5x's raw-signal drain cost; ENG-1440 makes it largely moot. Related: [[project_chat_cold_reattach_latency]], [[project_fungible_cold_claim_capability_lag]].
