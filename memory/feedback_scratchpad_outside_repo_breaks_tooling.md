---
name: feedback_scratchpad_outside_repo_breaks_tooling
description: "Throwaway scripts/lint runs in the external scratchpad dir break repo-relative tooling (tsx can't resolve node_modules, biome finds no biome.json) — run from inside the repo tree"
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-31
  sourceBranch: feature/eng-1064
  written: 2026-07-31
  originSessionId: 114dbff1-1916-4e67-870b-1a309d445cad
---

The harness scratchpad (`/private/tmp/claude-501/.../scratchpad`) lives **outside the repo tree**, so anything that resolves config or modules by walking up from cwd breaks there: `tsx`/`node` can't find `node_modules`, and `biome` finds no `biome.json` (yielding false-clean or false-dirty comparisons).

Run throwaway scripts and lint checks **from inside the package tree** (write a temp file in-repo, run it, delete it) — or, to lint your actual changes accurately, stash → run the repo-pinned tool on the real files → pop.

**Why:** a script/lint that runs in the scratchpad silently resolves the wrong (or no) config, so its result is meaningless — a false pass or false fail.
**How to apply:** put temp scripts inside the repo package tree and delete after; for lint, use the repo-pinned tool on real files. Pairs with [[feedback_biome_not_precommit_gated]] (use `pnpm exec biome`, not `npx biome`).
