---
name: feedback_gh_token_env_shadows_auth
description: "A GH_TOKEN/GITHUB_TOKEN env var shadows gh's keyring auth and makes gh commands 401 — prefix release/workflow-dispatch/PR calls with `unset GH_TOKEN GITHUB_TOKEN`"
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-31
  sourceBranch: feature/eng-1064
  written: 2026-07-31
  originSessionId: 2a7358cb-75a2-4589-8906-7de1462fcc80
---

A `GH_TOKEN` / `GITHUB_TOKEN` env var present in the shell **shadows `gh`'s own keyring auth**, so `gh` commands 401 even though `gh auth status` is fine. Prefix `gh` release / `workflow run` / PR commands with `unset GH_TOKEN GITHUB_TOKEN 2>/dev/null && gh …` so gh falls back to its keyring.

**Why:** the 401 looks like a genuine auth failure but is just the env var overriding the working keyring credential; it recurs on every `gh` call in a session because it's environmental.
**How to apply:** whenever `gh` unexpectedly 401s (or preemptively on release/dispatch calls), `unset GH_TOKEN GITHUB_TOKEN 2>/dev/null &&` first.
