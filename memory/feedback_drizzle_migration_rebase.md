---
name: feedback_drizzle_migration_rebase
description: drizzle-kit generate reformats _journal.json tabs→spaces (spurious diff) and migration numbers collide on rebase onto fast-moving staging
metadata: 
  node_type: memory
  type: feedback
  sourceDream: 2026-07-29
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

Two coupled migration hazards:

- **`drizzle-kit generate` rewrites `packages/db/migrations/meta/_journal.json` (and the new snapshot) from TAB indentation to 2-space**, producing a huge (~2000-line) spurious diff. Fix: restore the committed tab-formatted journal (`git checkout HEAD -- _journal.json`), hand-append **only** the new entry with tab indentation, and reformat the new snapshot to tabs — so the diff stays a clean ~7-line append.
- **origin/staging moves fast during a PR and CI tests the merge against *current* staging.** A locally-generated migration number (e.g. 0145, 0153) collides with one staging merged meanwhile → rebase onto origin/staging, drop the colliding file, and re-run `db:generate` so it chains to the next number (0146/0154/0155). Overlapping journal/snapshot files also conflict on rebase. Corollary: a ratchet/test failure may be **inherited from staging**, not caused by your diff — rebase before assuming it's yours.
- **`_journal.json` `when` timestamp must be monotonic.** When a renumbered migration now runs **after** a migration that landed on staging, its journal `when` value must be **strictly greater** than the preceding entry's, or `validate-migrations` fails in CI even though it passes locally. When you hand-append the renumbered entry, bump its `when` to a fresh current epoch (ms).
- **Collision-resolution recipe (rebase):** `git checkout --ours` the conflicted `_journal.json` + `meta/NNNN_snapshot.json` (in a rebase, `--ours` = staging's side), `git rm` your colliding `.sql`, `rebase --continue`, then `pnpm db:generate` to re-emit as the next free number; `git mv` to the descriptive name and fix the journal `tag`. Renaming via `python3` with `json.dump(..., indent="\t")` preserved tab formatting cleanly (no tabs→spaces blowup that run).
- **After renumbering, `pnpm db:migrate` SKIPS your renumbered migration locally** — drizzle tracks applied migrations by SQL **content hash**, and the renumbered file's content is identical to the old (already-applied) one, so it isn't re-run and the "column already exists" error never happens. It applies only the genuinely-new sibling migration from staging, leaving the local DB consistent.

Related: [[feedback_data_classification_ratchet]] (snapshot regen), [[feedback_local_db_migration_drift]], [[feedback_no_manual_migrations]].

**Why:** the journal reformat buries your real change in noise, and a colliding number breaks the merge only in CI.
**How to apply:** after `db:generate`, restore the tab journal + hand-append one entry; rebase onto origin/staging and renumber if a sibling PR took your number.
