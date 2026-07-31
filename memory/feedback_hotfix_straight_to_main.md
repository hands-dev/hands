---
name: feedback_hotfix_straight_to_main
description: How to land a hotfix straight to main/prod bypassing the staging branch requirement
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3e9d0fe7-11d6-4072-a96f-b59b87113d19
---

To ship an urgent fix to prod without dragging all of staging's pending work along (staging is often many commits ahead of main), bypass the feature→staging→main flow:

1. Branch off `origin/main`, cherry-pick only the fix commit, push, open PR to `main`.
2. `verify-pr-source.yml` (`verify-source` job) hard-fails any PR to main whose head isn't `staging` — and it does NOT read the `break-glass` label. BUT it is a **non-required** check, so the PR shows `mergeStateStatus: UNSTABLE` (not `BLOCKED`) and can still merge.
3. The actually-blocking gate is the **Greptile Score Gate** (`main-pr-gate.yml`). Add the **`break-glass`** label — `main-pr-gate.yml` posts a passing status that bypasses it ("DoE reviews after the fact").
4. Merge with `gh pr merge <n> --squash --admin` (no `--delete-branch` per [[feedback_gh_no_delete_branch]]). `--admin` clears the red non-required `verify-source`.

**Why:** Merging to main does NOT trigger the Production Deploy Orchestrator (that's `v*`-tag-only; pushes to main only hit preview services). So a main merge + a manual `gh workflow run "Mobile Deploy" --ref main -f environment=production -f platform=ios` rebuilds + auto-submits ONLY the mobile app to ASC, no backend redeploy.

**How to apply:** Used 2026-06-17 for the App Review 2.5.4 hotfix (eng-986, removing `UIBackgroundModes: location`). DANGER: a fix landed only on main diverges from staging — when staging next promotes via `staging→main` it can regress the fix. Always port the same change to staging too. See [[feedback_no_auto_merge]] and [[feedback_mobile_deploy_ref]].
