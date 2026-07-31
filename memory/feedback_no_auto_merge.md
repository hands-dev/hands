---
name: no-auto-merge
description: "theandcompany/ampersand has GitHub auto-merge disabled — use direct `gh pr merge` once checks pass, don't try `--auto`"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8a374da8-a06d-4618-b5d2-11e69342a817
---

`gh pr merge <n> --auto` fails on theandcompany/ampersand with:

> GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)

**Why:** the repo settings don't enable auto-merge. Trying `--auto` returns immediately without arming anything, then `gh pr view` shows `autoMergeRequest: null` and `mergeStateStatus: BLOCKED`.

**How to apply:** when the user says "auto-merge" or "merge once checks pass," don't reach for `--auto`. Instead poll PR status (`gh pr view --json statusCheckRollup,mergeable,mergeStateStatus`) until `mergeStateStatus: CLEAN` and `mergeable: MERGEABLE`, then run `gh pr merge <n> --squash` (no `--delete-branch` — see [[gh-no-delete-branch]]). If checks are long-running, use `Bash` with `run_in_background` to wait rather than sleeping in foreground.

Also: every PR to staging must reference a Linear ticket ID (`ENG-XXX` in the title or body) — the `Validate Linear Cycle Membership` workflow fails the PR otherwise. Create the ticket first, then reference it in both the title and the body (and rerun the failed check via `gh run rerun <id> --failed` — editing the PR doesn't auto-retrigger it).
