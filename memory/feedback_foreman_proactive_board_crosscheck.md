---
name: feedback_foreman_proactive_board_crosscheck
description: "Foreman must proactively cross-check worktree work against known initiatives/tech-debt/other panes, catching cross-cutting issues before Michael has to"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 006d5cd8-7dee-4ec2-9aaf-1cd74e636d71
---

Michael's expectation (2026-07-31): as foreman, look at the WHOLE board and catch cross-cutting issues so he doesn't have to — "within reason." The trigger was a miss: Sam was building the Phase-1 enrichment handler+runner onto the `heavy_work` lane, which is slated to consolidate into the `agent_tasks` single queue — the foreman approved the lane without flagging the conflict; Michael caught it instead.

**Why:** the foreman holds the only whole-board view (all worktrees + priorities + the memory of ongoing initiatives). Adjudicating a delegation is NOT just "does this plan work" — it's "does this fit the bigger direction." Building on a lane that's being retired, duplicating an in-flight initiative, or colliding with another pane's work is the foreman's to catch, not Michael's.

**How to apply:** before approving a worktree's plan/scope, cross-check it against — (1) known initiatives/migrations/deprecations in [[MEMORY.md]] + Linear (is this subsystem/lane being retired or consolidated? e.g. heavy_work→agent_tasks, runtime_channel_messages→agent_tasks INN-219); (2) other worktrees' in-flight work (file collisions via `agent_bus_board`, duplicated effort); (3) whether it fights an established architecture decision. Flag the mismatch to the worktree + surface it to Michael with a recommendation, proactively. Run a periodic board sweep (`agent_bus_board` collisions + recentJournal) as part of the loop, not only when prompted. Related: [[feedback_foreman_rebase_before_delegation]].
