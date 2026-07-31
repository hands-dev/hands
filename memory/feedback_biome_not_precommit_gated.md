---
name: feedback_biome_not_precommit_gated
description: "biome is NOT run by the pre-commit hook or as a required PR check — local `biome check` reports pre-existing drift that isn't CI-gated; don't chase it"
metadata: 
  node_type: memory
  type: feedback
  written: 2026-07-29
  originSessionId: f0b88853-1312-46f5-a4a3-28a342bd98a0
---

The pre-commit hook (`.husky/pre-commit`) runs only **`pnpm turbo check-types --affected`** + **`lint-staged`** — and `lint-staged` is configured for `apps/infra/**/*.tf → terraform fmt` ONLY. So **biome does not gate commits**, and it did not appear as a required check on a merged staging PR (#2323) either.

Consequence: running `pnpm exec biome check` locally on TS files you're editing surfaces "violations" (`noNonNullAssertion`, `assist/source/organizeImports`, `format`) that are **pre-existing on staging** and pass CI — i.e. local biome version differs from whatever (if anything) CI enforces. This is false drift.

- **Don't chase it.** Ensure only YOUR added lines are clean; the pre-existing lines are staging's problem, not your diff's.
- **Never `biome check --write` a shared file** you're partially editing — it reformats the pre-existing drift too, polluting your diff with unrelated churn across the whole file. If you already did, `git checkout HEAD -- <file>` and re-apply only your hunks.
- The real gates are typecheck (pre-commit + CI Unit Tests) and the [[feedback_data_classification_ratchet]] snapshot. Verify those, not local biome.

**Why:** I burned effort trying to make agent-tasks.ts biome-clean; the drift was pre-existing and ungated, and `--write` pulled unrelated reformatting into the change.
**How to apply:** skip local biome fussing on shared files; only keep your own new lines tidy and lean on typecheck + ratchet.
