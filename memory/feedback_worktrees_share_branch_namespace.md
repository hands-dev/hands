---
name: feedback_worktrees_share_branch_namespace
description: Git worktrees here share ONE branch namespace — never mass-delete/prune local branches from a pane.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a45d0fa5-735b-455c-bf0f-295134fdd2b5
---

The `ampersand` checkout uses multiple git worktrees (wt1..wt6 + Michael's main) that SHARE one `.git` (refs/objects). So local branches are a single shared set across all worktrees (~1197 accumulated). Deleting/creating branches from one pane mutates the SHARED refs — including other worktrees' `wtN/home` pointers.

**Why:** on 07-30 an over-broad "prune your branches" APB led me (and wt6, concurrently) to `git branch -d` the merged-into-staging set from our panes; my exclude filter only protected `wt2/home`, so it also clipped wt1/wt3/wt5 `/home`. Multi-pane concurrent restores then raced at inconsistent SHAs (5d9b2564 vs 18493777). All recoverable (zero unique commits), but a mess. Foreman corrected: refs are shared; do not mass-delete from a pane.

**How to apply:** from a worktree pane, only ever (a) `git fetch --prune`, and (b) after YOUR OWN PR merges, delete YOUR ephemeral branch + `git switch wtN/home`. NEVER mass-delete other local branches, and NEVER touch another `wtN/home`/staging/main. Bulk cleanup of accumulated locals is a SINGLE coordinated pass the foreman runs from the main checkout. `git branch -d` is "safe" (refuses unmerged) but still deletes SHARED merged refs others may rely on — merged ≠ yours to delete. Exclude ALL `wt[0-9]/home`, not just your own, if you ever must filter. See [[feedback_no_new_worktrees]], [[feedback_gh_no_delete_branch]] (the no-delete-branch rule was RETIRED 07-30 in favor of the wtN/home model).
