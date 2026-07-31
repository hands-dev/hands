---
name: project_loop2_unlock_archived_gtkm_bug
description: "Loop 2 falsely re-locks when an andee archives their \"Get to know me\" (GTKM) loop — the unlock gate only lists the living shelf"
metadata: 
  node_type: memory
  type: project
  originSessionId: f91f2a99-af3c-463d-a294-e188968ef24d
---

**Bug (found 2026-07-20, prod &lesa / andee `d08b4df5-c4fd-4d85-8677-7c033117556b`).** Mobile Loops home Loop 2 ("Get to know an &ee"/Connect) is gated by `isConnectLoopUnlocked` (`apps/mobile/lib/loop-unlocks.ts`) → `deviceApi.listLoops({ skillId: 'ampersand-get-to-know-me', limit: 20 })` → `findGetToKnowMeLoop` (`apps/mobile/lib/get-to-know-me-loop.ts`, matches skillId **AND** exact title "Get to know me"). `listLoops` passes **no tier**, and the server default shelf (`listLoopsForAndee`, `packages/db/src/queries/loops.ts` ~L944) adds `ne(loops.tier,'archived')` — the LIVING shelf hides archived loops. So if an andee archives their GTKM loop, the gate finds nothing → Loop 2 re-locks even though the loop exists (Lesa's had 102 items, is_identity=t, correct title, deleted_at NULL, tier=archived; she archived it herself ~07-16).

**Two underlying defects:** (1) unlock gate treats "GTKM on the living shelf" as completion, but completion should be permanent (existence, archived-or-not). (2) `archiveLoopForAndee` (`loops.ts` ~L2503) has **NO identity guard** — it archives identity organs despite the schema invariant "identity organs never tier."

**GOTCHA — do NOT tell the user to just re-run Loop 1.** `getOrCreateGetToKnowMeLoop` uses the *same* archived-excluding finder, so re-running births a **duplicate GTKM identity organ**, it won't reuse the archived one. And there's no in-app archive/wake view yet ("a future archive view"), so the andee can't un-archive it themselves.

**Fix applied for Lesa:** one-off prod write mirroring `wakeLoopForAndee` — `UPDATE loops SET tier='active', epitaph=NULL, last_human_touch_at=now(), last_human_actor='<andeeId>', rank_key='3:'||to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), updated_at=now() WHERE id=... AND tier='archived'`. rank_key class 3 = humanTouch (`LOOP_RANK_CLASS`). Verified the gate query (living shelf + skillId + inner join loop_members) now returns it → unlocks.

**Not a treatment/experiment/flag** — the gate is universal + deterministic + per-andee. No code fix requested yet (diagnosis-only); systemic fix = make the gate/get-or-create resilient to archived GTKM (existence=completion) and guard identity loops from archival. Related: [[project_gtkm_seed_drift_db_test_red]], [[reference_gcp_projects]] (prod DB read-only recipe in [[project_raw_signal_zero_prod_throughput]]).
