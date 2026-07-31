---
name: project_location_signal_sandbox
description: Backend seed harness to drive the raw-signal→venue→signal pipeline on synthetic data for tuning
metadata: 
  node_type: memory
  type: project
  originSessionId: d105986a-f3e8-4dec-9d7f-83dfba641d36
---

Location-signal extraction **sandbox** — branch `feat/eng-location-signal-sandbox` (built 2026-06-29, off staging). Feeds synthetic device GPS/photo metadata through the REAL pipeline so the clustering/venue/affinity/signal logic can be tuned. The pipeline itself was already fully built but runs on zero input (see [[project_raw_signal_zero_prod_throughput]]).

**Scope decision:** input side only. worktree-2 (`feat/eng-photo-pipeline-observability`) owns the OBSERVE layer (`apps/admin` `photo-pipeline.ts`, `PhotoPipelineDashboard`, `AndeePhotoScansCard`) — do NOT rebuild it. Admin trigger UI deliberately deferred to rebase onto worktree-2 after it merges. Loop: seed (this) → observe (theirs) → tune thresholds → re-seed.

**Confirmed choices:** dedicated sandbox andee `zzz-sandbox-location` (tag `zzz.sandbox.location`); real Google Places only (needs `GOOGLE_PLACES_API_KEY`, no mock); auto-accept suggestions all the way to identity_signals; resettable.

**What it added:**
- `apps/api/src/lib/sandbox/location-scenario.ts` — pure deterministic generator (seeded PRNG, real venue coords, knobs map to detectSpots 8/3/30d + trip 50km/7d thresholds; presets homebody/traveler/edge-thresholds).
- `apps/api/src/lib/sandbox/sandbox-andee.ts` — get-or-create sandbox andee.
- `apps/api/src/lib/suggestion-accept.ts` — factored `structuredVenueFacts`/`slugifySignalKey` out of `routes/signals.ts` (behavior-preserving) + new `acceptSuggestion(andeeId, suggestionId)` (suggestion-driven; signals land source `'integration'`; decompose runs without telemetry). Accepts BOTH pending (venue/cross-venue) AND draft (trip place cards) suggestions.
- Refactored `routes/raw-signals.ts`: extracted `ingestRawSignalBatchCore(andeeId, input)` (transport-free) from the Hono wrapper so the sandbox ingests via the identical digest/GCS/insert path.
- `packages/db/src/queries/sandbox.ts` — `resetSandboxData` (deletes 5 andee-scoped tables; NOT places_cache, which is coord-keyed/global) + `sandboxStageCounts`.
- Routes `apps/api/src/routes/internal-sandbox.ts` mounted at **`/v1/internal-sandbox`** (sibling of `/v1/internal` to dodge the drain plane's `use('*')` auth; added to `route-owns-auth.ts`). Endpoints: seed / run / seed-run / reset / status. Gated by `createSandboxAuth` (`middleware/sandbox-auth.ts`): hard 403 when `AND_ENVIRONMENT==='production'`; `SANDBOX_SEED_OPERATOR_TOKEN` via `authToken` header on staging; tokenless locally.
- `scripts/seed-location-sandbox.ts` (`pnpm tsx`, HTTP, `API_BASE_URL` default :3005).
- Test `apps/api/__tests__/lib/location-scenario.test.ts` cross-checks generator output against the real `detectSpots`.

**Rebased onto PR 1916** (`feat/eng-photo-pipeline-observability`, the admin observe layer) — 4 commits on top: sandbox harness; local-FS blob fallback + drain trace; `total-photos` knob; **admin "Seed sandbox" control**. ALL re-verified through the pre-commit hook (no `--no-verify`); reconstructed via cherry-pick+amend onto the PR's advanced head. SHAs churn on re-rebase. Backend-only conflicts: none.

**Pre-commit hook passes cleanly.** Hook = `turbo check-types --affected` + `lint-staged`; commit-msg = commitlint **lowercase subject** (camelCase like `totalPhotos` FAILS — used `total-photos`). The earlier hook failures were environmental, not code: fix was `pnpm install` (mobile expo-calendar) + `rm -rf apps/web/.next` (STALE typed-routes `.next/types` referenced a deleted route + missed `/about`; a fresh checkout has none, so CI is green — the artifact was the bug). All 14 packages green; 94 api tests pass.

**Admin control:** `apps/admin/src/components/dashboards/SandboxSeedCard.tsx` mounted atop `PhotoPipelineDashboard` → `app/api/sandbox/{seed-run,reset}/route.ts` + `lib/sandbox-proxy.ts` (admin-session-verified proxy to `/v1/internal-sandbox/*`, operator token server-side, 5xx Sentry + audit row). Needs `API_BASE_URL` (e.g. `http://localhost:3005`) set for the admin app; dev-stub admin auth works tokenless. Verified end-to-end: button → admin route → API → pipeline.

**Two enabling changes (committed):** `services/storage.ts` now persists/reads the gzipped blob under `RAW_SIGNAL_DEV_DIR` when no GCS bucket (else extraction was a forced no-op locally); `raw-signal-extractor.ts` `DrainResult` now carries `spotsClustered/venuesResolved/suggestionsDrafted/placesDrafted`. **`totalPhotos` knob** pads a batch with wide-scattered noise → realistic first-pass library (2000 photos extract in ~2s; noise coins zero spurious venues + costs no Places calls; a year-long span unlocks trip-scale home inference).

**Local-run recipe (verified 2026-06-29):** local DB is `localhost:5432` (worktree-1's published docker pg; user `ampersand`/`ampersand_local`/db `ampersand`; worktree-2/3 containers unpublished/stale). Run API: `cd apps/api && DATABASE_URL=postgresql://ampersand:ampersand_local@localhost:5432/ampersand API_PORT=3005 RAW_SIGNAL_DEV_DIR=/tmp/and-raw-signals-wt3 npx tsx src/index.ts`. Keys (Places + OpenRouter) pulled from GCP Secret Manager `and-dev-89990` (`engine-dev-google-places-api-key`, `api-openrouter-api-key`, `api-openrouter-model`) into gitignored `apps/api/.env.local`. Admin observe UI: `cd apps/admin && DATABASE_URL=... npx next dev --port 3002` (dev-stub auth when `ADMIN_AUTH_SECRET` unset) → `/dashboards/photo-pipeline` + `/andees/zzz-sandbox-location`. First-pass 2000-photo run yielded 6 signals: home `Kansas City` @8.1.1 + 4 favorite venues + derived `Pizza` @4.3.1.

Prod `raw_signals` (checked 2026-06-29 via cloud-sql-proxy): only 2 photo_gps rows / 195 pts / 2 andees (the 2026-06-26 ENG-1091 test scans) — points live in GCS blobs not DB rows, and it's real PII, so not reusable for the sandbox. Pre-existing OTA/openssl unit tests fail in this repo regardless.
