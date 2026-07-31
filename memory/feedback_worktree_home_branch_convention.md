---
name: feedback_worktree_home_branch_convention
description: Worktree branch model — each worktree lives on a persistent wtN/home branch; PR work goes on ephemeral branches cut fresh off origin/staging
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 006d5cd8-7dee-4ec2-9aaf-1cd74e636d71
---

Michael's directive (2026-07-30): give each agent-bus worktree a persistent **home branch** so there's no shared-checkout contention and nothing to delete after a merge. Git only allows a branch to be checked out in ONE worktree at a time, so worktrees can't all sit on `staging` — that's why nobody could delete their branch post-merge (nowhere to land).

**The model:**
- Each worktree has a persistent HOME branch `wt<N>/home` (e.g. `wt1/home`) — its workspace, never merged, never deleted, no contention. It lives there by default.
- Home is kept ≈ current: rebase/reset onto `origin/staging` when idle, so reference reads are fresh.
- ALL shippable work is done on **ephemeral** branches cut fresh off the right base — `origin/staging` normally, `main` for a hotfix, or another feature branch for stacked work.
- Flow: `git fetch origin` → cut `wt<N>/<ticket-slug>` off `origin/staging` → build → PR → after merge, delete the ephemeral branch → `git switch wt<N>/home`.
- Never checkout `staging`/`main` in a worktree (contention with the main checkout); never delete them locally.

**Why:** solves the checkout-contention + no-delete mess AND enforces fresh-off-staging PRs (every PR branch is cut off current `origin/staging`) — the same fresh-code guarantee behind [[feedback_foreman_rebase_before_delegation]]. Separates "where I live/scratch" (home) from "what I'm shipping" (ephemeral PR branch); today those are conflated in one task-branch, which is the root of the mess.

**How to apply (foreman):** bake "cut your PR branch fresh off `origin/staging` off your `wt<N>/home`" into every delegation. Roll out worktree-by-worktree as they free up — don't disturb an open PR's branch until it merges; `feature/inn-234` is Michael's own active branch (wt3 works near it) — leave it alone. Branch deletion is now SAFE and expected (the old "no `--delete-branch`" rule is RETIRED, 2026-07-30): because PR branches are ephemeral and each worktree returns to its `wtN/home` after merge, nothing gets stranded on a deleted branch. So merge PRs with `--delete-branch` (cleans the remote ephemeral branch), and worktrees periodically `git fetch --prune` + delete merged/stale local branches, keeping only `wtN/home` + any live PR branch. Related: [[feedback_no_new_worktrees]].

**PRUNE HAZARD — shared refs across worktrees (learned 2026-07-31, the hard way):** these worktrees share ONE git repo/ref namespace (`git worktree list` shows all of them; ~1200 branches shared). A `git branch -D` of the `--merged origin/staging` set from ONE pane deletes those refs for EVERY worktree — it is NOT per-pane. git only auto-protects a branch **currently checked out** in some worktree. The trap: a peer's `wtN/home` is UNPROTECTED whenever that peer is sitting on an ephemeral PR branch (not on their home) — and since `wtN/home` tracks staging it's in the merged set, so a blanket merged-delete silently removes other people's home branches (hit wt1/home, wt3/home, wt5/home this way; restored to their identical SHA `git branch --track wtN/home origin/staging`, no working-tree impact since only the idle ref pointer was gone). Lesson: mass branch-prune in a shared-worktree repo must be CENTRALIZED (one pane, coordinated), never fired independently from each worktree; and any merged-set delete must EXCLUDE every `wt*/home` (`grep -v 'wt.*/home'`), not just the checked-out ones. When in doubt, prune only branches you own.
