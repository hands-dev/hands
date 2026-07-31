---
name: project_held_task_and_release_orchestrator
description: "held (assigned-but-not-released) task primitive MERGED (#2342); the capacity-gated release orchestrator that consumes it is DEFERRED by design"
metadata: 
  node_type: memory
  type: project
  originSessionId: a126ef35-44d5-4fe5-9954-eac19ef1486d
---

## Shipped: the `held` task primitive (PR #2342, `edc277c1`, 2026-07-30)

A task can be **assigned to a host but withheld from claim** until something releases it.
`agent_tasks.held boolean NOT NULL DEFAULT false` (migration `0164`, constant default =
fast/rewrite-free). It's the **authorization axis**, sibling to the INN-234 **time axis**
`execute_after` — both are claim-eligibility predicates, one flipped by the clock, one by a
caller.

- Gate: `taskEligible(clock) = executeAfterEligible(clock) AND notHeld` applied wherever
  `execute_after` gates (matchmaker scan, on-enqueue fast path, claim doors) + `notHeld` on the
  two host-pinned doors that had no gate (`claimEvictTask`, `claimFleetUpgradeTask`). Default
  false ⇒ zero behavior change.
- `EnqueueTaskInput.held?`; a held insert **suppresses** the work + host-wake `pg_notify`s
  (`task-enqueue.ts`). Dedupe unchanged — a held task is still `queued`/active, holds its slot.
- `releaseHeldTask(taskId)` (`agent-tasks.ts`): idempotent `held→false`; reproduces the EXACT
  suppressed wake — `TASK_WORK_QUEUED_CHANNEL` always + host wake when pinned.
- Held tasks are **exempt from the stale-assigned-unclaimed reaper** (`notHeld` in
  `listStaleAssignedUnclaimedTasks`) — "held == intentionally unclaimed, never reaped."
- Tests: `packages/db/src/queries/__integration__/agent-tasks-held.integration.ts`.
- **Nothing seeds or releases held tasks yet** — the primitive is inert until a caller uses it.

## Deferred BY DESIGN: the capacity-gated release orchestrator

Michael parked this ("prioritization is a different track"). It is the intended CONSUMER of the
held primitive: pre-seed a held `fleet_upgrade` task per divergent host, then release them as
capacity allows. Design we converged on (build later):

- **Only the OTA cutover lane needs capacity coordination.** The template lane is already
  capacity-neutral: `reserveFleetHostsForReconcile` does **surge-before-drain** (boots the new
  host, waits for its `ready` heartbeat, only then drains the old one — never dips below the
  ready floor). So template reprovisions don't reduce assignable capacity and stay independent.
- An in-place OTA cutover DOES remove a servable host for its `upgrading` window (you can't
  surge-replace it), so it's the one thing to budget.
- Replace the OTA producer's static `DEFAULT_UPGRADE_BATCH=25` with a demand-aware budget:
  `budget = max(0, servable_now − floor − outstanding)`, release ≤ budget held tasks whose host
  has staged. `servable = status='ready' AND heartbeat fresh (FLEET_HOST_READY_STALE_MS=5m)`.
  Open floor/knob choices: fixed reserve vs demand-aware vs `FLEET_HOST_READY_TARGET−1` (can't
  reuse the target directly — reconcile holds servable ≈ target so budget→0).
- **Latent bug to fix when building it:** the reconcile's `activePredicates`
  (`fleet-hosts.ts:1167`) does NOT include `upgrading`, so a brief cutover looks like lost
  capacity and would trigger a spurious cold-boot surge. Count `upgrading` as live capacity.
- Rejected alternatives for the gate: a `held` STATUS enum value (global blast radius) and a
  `reserved_for_host_id` column (dual host-pin); overloading `execute_after` (it's time-based,
  wrong semantics). The `held` boolean won (safe default, single pin, dedupe untouched).

See [[project_inn237_fleet_upgrade_task]].
