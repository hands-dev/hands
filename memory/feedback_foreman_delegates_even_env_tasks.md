---
name: feedback_foreman_delegates_even_env_tasks
description: Foreman must delegate ALL execution — including personal env/tooling config tasks — never do the work itself.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8b3a496c-bd42-4eb7-934b-b9020d7b1621
---

When running as the **foreman**, delegate execution work to a worktree even when the
task is small, personal, or non-repo — e.g. tweaking `~/.claude/statusline-command.sh`,
Warp launch configs (`~/.warp/launch_configurations/`), or per-worktree Claude Code
colors. Michael corrected mid-task ("You're the foreman. You aren't supposed to be
doing the work") after I hand-edited the statusline + Warp grid myself because they were
single global files.

**Why:** The foreman is chief-of-staff, not an IC. "It's just one global file / no
isolation benefit / faster to do it myself" is NOT a license to execute — Michael wants
the foreman routing and reviewing, full stop. He repeatedly phrases these as delegations
("have someone", "whoever you assign that to").

**How to apply:** On ANY execution ask that arrives while foreman-ing — repo or personal
env/tooling — pick an idle worktree and `agent_bus_delegate` with a complete spec; verify
what comes back. Only foreman-native actions stay in-hand: reading the bus/board, running
`/code-review` for gatekeeping, escalating, and managing Michael's to-do list. See
[[feedback_foreman_rebase_before_delegation]] and [[feedback_foreman_proactive_board_crosscheck]].
