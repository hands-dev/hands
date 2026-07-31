---
name: feedback_monorepo_dev_commands
description: "pnpm filter / typecheck / test / lint gotchas — apps/* are unscoped names, script is check-types, linter is Biome"
metadata: 
  node_type: memory
  type: feedback
  sourceDream: 2026-07-29
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

Running dev tooling in this monorepo — the repeatedly-guessed-wrong facts:

- **Package names:** `apps/*` have **bare/unscoped** names (`apps/api` = `api`, `apps/web` = `web`, `apps/admin` = `admin`); shared `packages/*` use the `@ampersand/*` scope. `pnpm -F @ampersand/api` silently resolves to **`packages/api`** (a different package) and runs the wrong typecheck/test → false green. Use `pnpm -F api` / `-F web` / `-F admin`. Verify the name in the package's `package.json` before `-F`.
- **Typecheck script is `check-types`**, not `typecheck`.
- **`apps/api` has no `test` script** — tests run via `test:run` (vitest run), and its tests live at **`apps/api/__tests__/`**, not `apps/api/src/__tests__/`.
- **`apps/web` unit tests need `--config __tests__/vitest.config.ts`** (defines the `@/` alias); without it collection errors with "Cannot find package @/…", which looks like a broken edit but is an invocation problem. Sanity-check by running an untouched sibling test the same way.
- **Snapshot update:** `pnpm test -- -u` does NOT propagate `-u` to vitest — the snapshot stays stale. Invoke vitest directly: `pnpm exec vitest run -u <path>`.
- **Test filter also not forwarded:** `pnpm -F <pkg> test -- <filter>` likewise doesn't reach vitest — it runs the **entire** suite (wasting time, muddying results with unrelated failures). Pass the filter with no `--` via `test:run` (`pnpm -F <pkg> test:run <filter>`) or invoke vitest directly (`npx vitest run <path/to/file>`).
- **Linter & formatter are Biome, not eslint/prettier.** Running eslint yields a spurious "missing flat config"; prettier reformats away from the pre-commit canonical style (quotes, import order). Lint/format touched files with `npx biome check --write`. Suppress with `biome-ignore` placed directly **above** the JSX element (not among attributes). Pre-commit runs `turbo check-types` + lint-staged.

**Why:** wrong `-F` scope or wrong script name gives a false green or a spurious failure that looks like a code bug.
**How to apply:** confirm the package name in its `package.json`, use `check-types`, and format with Biome — never eslint/prettier.
