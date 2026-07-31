---
name: project_hds_taxonomy_db_versioning
description: "HDS taxonomy moved from hardcoded const into versioned Postgres rows (option 4), with admin draft→publish editing"
metadata: 
  node_type: memory
  type: project
  originSessionId: 109afebc-58a6-490b-9406-76869d82c127
---

Moved the HDS taxonomy (was a hardcoded const in `packages/db/src/constants/hds.ts`) into versioned Postgres rows. **ENG-1193 DONE — merged to staging 2026-07-06** via PR #2003 (squash `d708d88c`). Follow-up **ENG-1194** (Backlog): version-aware label resolution — `getHdsLabel` reads only the current snapshot, so removing/renaming a published code orphans old signals (raw dotted path leak); until then treat taxonomy edits as additive. Snapshot is still v1.0.0 (byte-identical 122 codes to the old const), so no hosted-runtime republish needed. Prod promotion will run migrations 0106+0107 via CI.

**Architecture (DB is source of truth; committed snapshot ships to bundles):**
- Tables `hds_taxonomy_versions` (draft/published/deprecated; partial unique index = one published at a time) + `hds_codes` (PK version,code) — `schema/hds-taxonomy.ts`. Mirrors loop_skills immutable-versioning.
- Mobile/web can't query PG at request time, so the current published version is a committed generated snapshot `constants/hds.generated.ts` (HDS_CODES + HDS_VERSION + HDS_CONTENT_DIGEST). `constants/hds.ts` keeps its full helper API unchanged → the ~25 consumers didn't change.
- Codegen `taxonomy/generate.ts` (`pnpm -F @ampersand/db gen:hds`, `--from-db`, `--check`, `--emit-seed`) renders BOTH the snapshot and migration seed from one core `taxonomy/build.ts`. Guard test `__tests__/hds-generated.test.ts` fails if snapshot/source/digest drift.
- `identity_signals.hds_version` stamps provenance (backfilled to 1.0.0). Admin tool `/tools/hds-taxonomy` (`HdsTaxonomyManager.tsx` + `api/tools/hds-taxonomy/*` routes + `queries/hds-taxonomy.ts`) does draft→edit→publish.
- Migrations `0106_hds_taxonomy_v1_0_0.sql` (seeds published v1.0.0, 122 codes, digest 6e392b680766…) + `0107_identity_signals_hds_version.sql`.

**Publish workflow gotcha:** publishing a new version in admin updates the DB but does NOT auto-update the bundled snapshot. After publish, an engineer must run `pnpm -F @ampersand/db gen:hds --from-db` and commit the regenerated `hds.generated.ts` so mobile/web pick it up (the admin UI shows this reminder).

**Per-node default privacy — ENG-1200, PR #2011 → staging (2026-07-07, branch `feature/hds-node-default-visibility`).** Added `hds_codes.default_visibility` (reuses the `visibility` enum: private/connected/public; DEFAULT 'connected'). Versioned taxonomy content — `digestCodes` now hashes `code\tlabel\tvisibility`, so flipping a node's default mints a new version. Snapshot gained `HDS_DEFAULT_VISIBILITY` map + `getHdsDefaultVisibility(code)` helper. Admin tool got a per-row visibility `<Select>` (draft) / badge (read-only) + "Default privacy" add-code field; PUT codes route + `useUpsertCode` carry optional `defaultVisibility`. **Signal wiring:** `pickEffectiveVisibility` fallback changed from the hardcoded `DEFAULT_VISIBILITY='connected'` constant to the node's `getHdsDefaultVisibility(hdsCode)` (still fail-closed private for out-of-taxonomy codes) — a new/untouched signal inherits its node default, applied at read time (no backfill). Confirmed the consolidated suggestion-accept flow (`apps/api/src/lib/suggestion-accept.ts` → `upsertSignal`) writes NO permission row, so the node default is honored; enforcement point is `getEffectiveSignalVisibilities` used by `visibility-filter.ts`.

**Versioning (rebased onto staging, which had already shipped v1.0.1/ENG-1192 with 0.5.1 Profiles & Links + 0.5.2 Payment Links):** migration `0110` adds the column (backfills connected) + recomputes stored digests for v1.0.0 (`6145922240d7…`) and v1.0.1 (`8a78a46d3d47…`) — content unchanged, only the digest formula extends. New **v1.0.2** = source module `hds/v1_0_2.ts` (composes from frozen v1.0.1, flips 0.5.1/0.5.2 → public) + seed migration `0111`; digest `b79fcdbca557…`. Verified: full chain (112) applies clean on scratch DB (v1.0.2 published, only 0.5.1/0.5.2 non-connected); 466 db tests + 38 api perm tests pass; `gen:hds --check` clean; all 6 packages typecheck.

**Gotchas learned this round:** (1) staging moved fast — ALWAYS `git fetch && rebase origin/staging` before starting taxonomy work; my first cut built on stale v1.0.0 and had to be redone on v1.0.1. (2) `pnpm install` after a branch switch — staging added `@ampersand/schemas` as a `@ampersand/utils` dep; missing workspace symlink made unrelated packages fail typecheck. (3) Don't `npx biome` — it grabs an unpinned config (spaces + stricter rules) and mass-reindents tab-style files (`constants/hds.ts`, `__tests__/*` use tabs); lint-staged does NOT run biome on TS anyway (only terraform), so just match each file's existing indentation. See [[reference_hds_taxonomy]].
