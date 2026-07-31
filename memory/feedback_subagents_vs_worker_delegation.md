---
name: feedback_subagents_vs_worker_delegation
description: "As foreman, explicitly direct WHICH parallelization mechanism each unit of work uses — in-instance sub-agents vs cross-worktree delegation — at the right time."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5ca63161-a95d-4dad-b255-513f0a54d86d
---

Michael (2026-07-31): "Remember moving forward to direct them to use sub-agents at the right time and delegation to other workers at the right time." When routing work, name the mechanism — don't leave it implicit.

**Sub-agents (in-instance Agent/Explore tool)** — use for **read-only investigation fan-out that the lead synthesizes**: log sweeps, multi-file searches, checking N hypotheses at once. Cheap, fast, results flow straight back, lead keeps the conclusion. Trade-offs: start cold (no pre-loaded domain context), share the lead's context window, run in the lead's checkout (no branch isolation), ephemeral, invisible on the board.

**Cross-worktree delegation (agent-bus)** — use for **isolated parallel builds, durable/multi-session workstreams, or work needing a specific pane's pre-loaded domain context**. Each worker has its own worktree/branch (real isolation for parallel mutation), persists, is board-visible. Trade-offs: coordination overhead, latency, priming cost.

**Structural rule:** keep cross-instance routing AT THE FOREMAN — a single conductor prevents double-assignment and board-invisible work. Leads (e.g. Casey) parallelize their OWN slice with sub-agents; when they need another *worktree* pulled in, they ask the foreman and it routes. Rule of thumb: **sub-agents when you need answers back; worker instances when you need isolated work done or a pane's standing context.**

Why: keeps parallelization matched to the task and avoids two conductors. How to apply: in each delegation, state the mechanism; leads use sub-agents for legwork; new-worktree pulls flow through foreman. See [[feedback_foreman_delegates_even_env_tasks]], [[feedback_foreman_proactive_board_crosscheck]].
