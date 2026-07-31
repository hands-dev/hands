---
name: feedback_data_classification_ratchet
description: "Data Classification Ratchet CI gate — every new console.*/Sentry sink file must be registered (both sink lists) + snapshot regenerated, or Unit Tests (DB) goes red at merge"
metadata: 
  node_type: memory
  type: feedback
  sourceDream: 2026-07-29
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

The **Data Classification Ratchet** (`packages/db/src/security/data-classification-register.ts` + its snapshot, enforced by the "Unit Tests (DB)" / "Data Classification Ratchet" CI gate) fails whenever a diff adds a plaintext-egress sink or a schema column, and it surfaces only at merge — not obvious from the diff.

- **New sink file** (a `console.*` **or** `Sentry.captureException`/`trackServer` callsite in a new production file) must be registered. A file with a Sentry sink goes in the **sentry** list; a file with a `console.*` sink goes in the **application-logs** list — a file with both goes in BOTH. Alphabetize within each list. Do **not** drop it in the mixpanel-analytics list unless it has an actual analytics sink.
- **Deleting** such a file requires removing its register entry too.
- **New schema column** (esp. a text column referencing an andee, e.g. `fleet_hosts.bound_andee_id`) needs a classification entry / snapshot regen.
- **Renamed DB fields** leave stale field paths in the snapshot (`tasks.*` → `agent_tasks.*`) — regenerate.
- **Regenerate the snapshot** with vitest directly: `pnpm exec vitest run -u src/security/__tests__/data-classification-*` — `pnpm test -- -u` does NOT reach vitest (see [[feedback_monorepo_dev_commands]]).
- **Editing an already-registered file also trips it** — the snapshot stores a **per-file fingerprint hash of sink callsites**, so changing ANY registered file (e.g. altering a `Sentry.captureException` argument) changes that file's hash and requires a `vitest -u` regen **even when no new sink is added and the sink count is unchanged** (e.g. count stays 11, hash `64c7bf33…` → `37d1a37c…`). Passes locally, fails in CI.
- **Passes locally but fails in CI** with "Obsolete snapshots found when no snapshot update is expected" — vitest only errors on obsolete snapshots in **CI mode**. Reproduce with `CI=true` before pushing.
- A red ratchet may be **inherited from origin/staging** (a sibling PR added a sink and never registered it), not caused by your diff — rebase before assuming it's yours. See [[feedback_drizzle_migration_rebase]].

**Why:** the gate is invisible in the local diff and only fails at merge, costing a CI round-trip each time.
**How to apply:** when adding a production file with a log/Sentry sink or a schema column, register it in the right list(s) and regenerate the snapshot with `CI=true` before pushing.
