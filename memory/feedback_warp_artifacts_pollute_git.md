---
name: feedback_warp_artifacts_pollute_git
description: "`pr-walkthrough` skill leaves untracked `.warp/` (index.html/artifact.html) at the worktree root — inflates green-line count and risks being committed; exclude it or `rm -rf .warp` before staging"
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-30
  written: 2026-07-30
  originSessionId: ab3d845f-d64e-484e-ac14-5f3367de3935
---

The `pr-walkthrough` / PR-walkthrough skill drops untracked `.warp/` artifacts
(`index.html`, `artifact.html`) at the worktree root. These pollute `git status`,
massively inflate the added-line count on a PR/commit (one session counted **831
green lines** that were entirely `.warp/` HTML, not code), and can be swept into a
`git add -A`.

- Before committing after any `pr-walkthrough` run, stage **specific paths**
  (never `git add -A`/`.`) so `.warp/` is excluded, or `rm -rf .warp` first.
- If a green-line count looks wildly larger than your diff, check for a stray
  `.warp/` directory before anything else.

**Why:** wasted a diagnosis detour tracking down phantom added lines that were
tooling output, not the change.
**How to apply:** exclude/remove root `.warp/` before staging; treat an inflated
green-line count as a `.warp/` smell.
