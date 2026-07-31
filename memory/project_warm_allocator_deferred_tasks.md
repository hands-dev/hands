---
name: project_warm_allocator_deferred_tasks
description: "INN-233 warm-host matchmaker allocator + INN-234 deferred-task primitive merged to staging (PR #2323), both flag-off/partial pending INN-185 and INN-232"
metadata: 
  node_type: memory
  type: project
  written: 2026-07-29
  originSessionId: f0b88853-1312-46f5-a4a3-28a342bd98a0
---

Two INN-219 sub-tickets built + merged to staging in one squash commit (PR #2323, `abe4eb02`, 2026-07-29), server/DB only:

**INN-233 — warm-host matchmaker allocator** (finishes the allocator half of INN-227, which only shipped the evict primitive). Behind `FLEET_WARM_ALLOCATOR_ENABLED`, **OFF in every env**:
- Completion warm-binds + retains the host (skip clean/wipe) → `markFleetHostWarmReadyInTransaction`; `commitFinalWorkspaceAndCompleteTask` takes it via a `warmReturn` request flag (route reads the env flag).
- Matchmaker (`apps/api/src/services/task-matchmaker.ts`) prefers the andee's warm host; a warm-miss takes a **clean** pool host only (never another andee's dirty substrate — isolation).
- Interactive-aware-LRU evict-on-refill (`listWarmEvictionVictims`): when the clean pool < `FLEET_HOST_READY_TARGET`, enqueue one host-pinned `evict` per deficit slot. **Deficit MUST subtract in-flight evicts** (`countActiveEvictTasks`) or it over-evicts across passes (a claimed evict → `busy` host leaves the ready count + victim list) — this was the key code-review bug.
- **Blocked on:** `FLEET_WARM_ALLOCATOR_ENABLED` can't be turned on until the host-side wipe-skip lands (INN-185) — the retained-substrate contract is a lie otherwise. So INN-233's "verify warm-hit on staging" exit criterion is gated; ticket left In Progress despite the merge.

**INN-234 — deferred/scheduled task primitive** (`agent_tasks.execute_after`, migration `0162`). NULL = eligible now (existing producers unchanged). Eligibility gate `(execute_after IS NULL OR execute_after <= now)` on the matchmaker scan, the on-enqueue fast path (`getUnassignedQueuedTaskById`), and all three claim doors; SLA ordering by effective start `greatest(created_at, execute_after)`. The **self-perpetuation hook** (a `loop_advance` run enqueues its successor at start) and scanner retirement are **deferred to INN-232**'s `execute_loop_advance` exchange composer (not built yet).

Not-mine code-review follow-ups still open (already on staging, not this PR): `checkout_executor.py` 401-retry stall, `isFleetCheckoutConsumerHostEnabled` consumer-all short-circuit, 4th `formatDateTime` dup.

Related: [[project_task_queue_cutover]] (INN-219), [[project_eng1384_fleet_chat_open_attach]].
