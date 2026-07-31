---
name: feedback_precommit_checktypes_sibling_drift
description: "pre-commit `turbo check-types --affected` fails on unrelated apps/{web,admin} local drift (stale .next/dev/types, uninstalled deps after rebase) — fix with `pnpm install` + `rm -rf apps/{web,admin}/.next/dev/types` before committing, NOT `--no-verify`"
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-30
  written: 2026-07-30
  originSessionId: a126ef35-44d5-4fe5-9954-eac19ef1486d
---

The pre-commit hook runs `pnpm turbo check-types --affected`, which pulls sibling
packages (`web`, `admin`) into the typecheck. These repeatedly fail on **local-env
drift unrelated to your change**, walling the commit — and CLAUDE.md forbids
`--no-verify`. Two recurring causes + the clean (non-bypass) fix:

- **Stale Next.js generated types** — `apps/web/.next/dev/types/validator.ts` (and
  the admin equivalent) go stale after a branch switch/rebase. Fix:
  `rm -rf apps/web/.next/dev/types apps/admin/.next/dev/types`.
- **Uninstalled deps after a rebase** — e.g. `react-markdown` newly declared in
  `apps/admin/package.json` but not installed since the rebase. Fix: `pnpm install`.

Run `pnpm install` and clear the stale `.next/dev/types` dirs **before** committing
so the hook passes without bypass. This is distinct from
[[feedback_biome_not_precommit_gated]] (which covers *what* the hook runs, not this
sibling-drift failure or its remedy) and [[feedback_local_db_migration_drift]].

**Why:** the failure is in files you never touched, looks like a blocker, and tempts
a forbidden `--no-verify`.
**How to apply:** `pnpm install` + `rm -rf apps/{web,admin}/.next/dev/types` before
committing; never bypass.
