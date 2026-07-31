---
name: project_fungible_cold_claim_capability_lag
description: "Root cause of the ~multi-min fungible chat cold-claim: cold-boot capability-attestation lag + no matchmaker re-trigger on host-ready (not a warm/affinity bug)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9bffabc8-0525-43ea-a80c-f88f20253683
---

The fungible-host chat cold-claim latency (priority #2; a staging turn took ~3.9min to first-claim, 2026-07-31) is NOT a warm/affinity predicate-asymmetry bug. Diagnosed on task 61.

- **Warm allocator is OFF on staging** (`FLEET_WARM_ALLOCATOR_ENABLED` absent on api-server; INN-185-parked). With it off, `pickHostForTask` (apps/api/src/services/task-matchmaker.ts:135-141) reduces to "first capable ready host", so the fast on-enqueue path (`matchTaskById`→`assignQueuedTaskToCapableHost`, :429/:447) and the 5-min `/drain-all` batch (`runTaskMatchmaker`→same fn, :265/:338) use the IDENTICAL predicate. The warm-refill divergence (`maybeRefillCleanPool` :350 vs fast-path omission :443-446) is real code but DORMANT until warm flips on — it goes LIVE with INN-185; flag for the fungible-vs-warm decision (Taylor task 57).
- **Actual cause = eligibility timing, not predicate.** Freshly-provisioned fungible hosts FLAP through capability attestation (`capabilities` only populate under `capabilityAttestation='measured-v1'`) — observed a host as `ready`/`["chat"]` then `booting`/`[]` minutes later. At enqueue no host was simultaneously `status=ready` + heartbeat-fresh (`FLEET_HOST_READY_STALE_MS`=5min) + attesting `chat`, so `assign_on_enqueue` `no_eligible` was CORRECT (payload is bare, no sub-code). The andee gate returns `skipped` not `no_eligible`, and the target andee was allowlisted (`FLEET_CHAT_ANDEE_ALLOWLIST`), so `no_eligible` ⟹ genuinely no eligible host.
- **The real defect = NO wake re-runs the matchmaker when a host BECOMES ready/attested.** Fast-path assign fires only on task ENQUEUE (task-matchmaker-wakeup.ts:77-80); a task enqueued while no host is eligible then waits for the `*/5min` `/drain-all` cron (internal.ts:292). Confirmed: the task was assigned exactly on the 14:10:05 drain tick (`raw_signal.drain_swept` fires every 5min). So worst-case cold-claim ≈ time-to-next-5min-tick. [[project_inn240_notify_wake_dead_cloudrun]] degrades the SECOND hop (assign→claim) but the dominant gap is the first hop.
- **Fix direction:** (1) add a host-ready/capability-attested → re-run-matchmaker-for-queued-tasks trigger (highest leverage); (2) stopgap tighten batch */5min→30-60s; (3) fix INN-240; (4) strategic — warm pre-attested capacity (INN-185) or faster cold boot, since fungible hosts are ineligible for minutes post-provision. Contrast with [[project_enrichment_lane_consumer_deferred]] (that `no_eligible` is PERMANENT — no host ever attests `location`; this one is TRANSIENT). Related: [[project_chat_cold_reattach_latency]], [[project_opt3_warm_engine_pool]].
