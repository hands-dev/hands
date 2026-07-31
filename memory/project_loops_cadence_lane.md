---
name: project_loops_cadence_lane
description: "GTKM loop_advance cadence lane — runner (INN-232) + self-perpetuation (INN-234) merged to staging; loops host provisioning HELD, to pilot via a fleet_upgrade task."
metadata: 
  node_type: memory
  type: project
  originSessionId: 80ae8413-eb9f-417a-8a75-6c890f38c840
---

The GTKM cadence lane runs GTKM autonomously on the fungible fleet hosts, independent of chat (a scheduled loop over enriched raw data; chat is an optional interface, not the trigger).

**Shipped to staging (2026-07-29/30):**
- **INN-232 runner** (PR #2325): `execute_loop_advance` single-turn course + `loops` capability in `checkout_executor.py`; strict `directive` parse on the exchange response; `_prepare_checkout` shared prologue. Server foundation: per-andee gate `FLEET_LOOPS_ANDEE_ALLOWLIST`/`isFleetLoopsAndeeEnabled`, `composeLoopCadenceEngineRequest` (agent-task-native, no runtime_channel_message).
- **INN-234 self-perpetuation** (PR #2327): a `loop_advance` run schedules its own successor at START (at exchange) via `execute_after = slot + period` (`perpetuateLoopCadence` in `loop-cadence-scanner.ts`); scanner shrank to bootstrap-only (`listCadenceLoopsNeedingBootstrap`, also a self-healing backstop); deleted orphaned `listDueCadenceLoops`. Built on the merged `execute_after` primitive (#2323). Fixed period `CADENCE_PERIOD_MS` (env `LOOP_CADENCE_PERIOD_MS`); NL parse of `cadence.schedule` deferred.

**HELD — loops host provisioning.** The fleet spawns hosts on-demand from ONE template (`FLEET_HOST_INSTANCE_TEMPLATE`, currently chat-configured, `fleet_chat_enabled=true`); a host serves exactly one task type (`configured_task_type` fails on ≠1); the heartbeat jq in `startup-fleet-host.sh.tftpl` (~line 533) HARD-REJECTS "loops". So loops needs its own template + a capability-aware provisioner/allocator — which overlaps the INN-233 warm-allocator design under negotiation with Kevin. **Michael's call (2026-07-30): hold; when the plumbing is ready, pilot the loops cohort rollout via a `fleet_upgrade` task** (the host-pinned rollout lane, worktree-1 `feat/fleet-upgrade-task`), not a big-bang TF apply.

**Also gating a live run:** `FLEET_LOOPS_ANDEE_ALLOWLIST` is empty (no andee opted in) → matchmaker blocks all `loop_advance` assignment today, so nothing perpetuates in a loop on staging yet. See [[project_warm_allocator_deferred_tasks]], [[project_task_queue_cutover]].
