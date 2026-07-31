---
name: feedback-verify-ticket-merge-status
description: "Before starting any \"In Progress\" Linear ticket, verify its PRs/commits aren't already merged — statuses go stale in this repo"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 20b5d7fd-a66c-48d4-923b-6669cc98a2d2
---

Before starting work on a Linear ticket that is marked **In Progress**, first
check whether its work is already merged. In this repo, "In Progress" status
frequently goes stale — the code ships to `staging`/`main` but the ticket is
never moved to Done.

**Why:** On 2026-07-06, two consecutive current-cycle "In Progress" tickets the
user asked me to pick up were already fully merged: **ENG-1122** (commit
`47ee9eec`, on staging + main) and **ENG-1160** (PRs #1968 + #1971, both merged
to staging + main). In both cases the correct action was to move the ticket to
Done, not to reimplement. ENG-1160 had even gone Todo → Done → reopened to In
Progress (a follow-up PR), then left open after that PR merged.

**How to apply:** For an "In Progress" ticket, before touching code:
1. `get_issue` and read its attached PRs; `gh pr view <n> --json state,mergedAt,mergeCommit`.
2. `git branch -r --contains <mergeCommit>` to confirm it's on `origin/staging`/`origin/main`.
3. Grep the current code for the ticket's prescribed change (constants, handlers).
If it's all present and merged, surface that to the user and offer to close the
ticket (see [[feedback_done_means_merged]]) rather than fabricating work.
A cycle-hygiene sweep of remaining board statuses is often warranted.
