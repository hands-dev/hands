---
name: feedback_foreman_rebase_before_delegation
description: Foreman must enforce rebase-onto-staging in every delegation so worktrees work off fresh code
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 006d5cd8-7dee-4ec2-9aaf-1cd74e636d71
---

When acting as the agent-bus foreman, every delegated task (code read the worktree will rely on, or any build/branch) MUST instruct the worktree to `git fetch origin && git rebase origin/staging` first — per the repo git-operations rule. Michael flagged (2026-07-30) that the foreman was delegating without enforcing this, risking worktrees analyzing/building against stale bases.

**Why:** staging moves fast (multiple merges/day). A root-cause read against a stale `checkout_executor.py` / `fleet-config.ts` can produce wrong line numbers or wrong behavior; a build branched off a stale base invites merge conflicts and re-introduces already-fixed bugs. Shipped PR branches cut fresh off staging are lower-risk; the exposure is code *reads* done on each worktree's own (possibly stale) branch.

**How to apply:** put "rebase onto origin/staging first" in every `agent_bus_delegate` body and every pasted spec; when a root-cause finding matters, ask the worktree to confirm it re-verified against current staging; when worktrees can't read task bodies (only send/receive/peers/board — true for wt2/wt5/wt6), paste the spec + the rebase instruction as a plain message. Related: [[reference_agent_bus_cross_worktree_mcp]].
