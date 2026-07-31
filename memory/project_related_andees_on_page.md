---
name: project_related_andees_on_page
description: "& Autofill \"who's on this page?\" — reverse profile-link lookup surfaces the andee behind a page; shipped to staging (ENG-1376)."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1344d5f5-268d-4ab3-86d5-5f2d53b988ee
---

"Related andees on the current page" for the & Autofill Chrome extension — merged to **staging** 2026-07-28 (ENG-1376, PR #2290, squash `baee235a`). STAGING only, not prod. Built on the existing extension surface — see [[project_web_activity_enrichment]].

**What it does:** on a LinkedIn/GitHub/X/personal-site page, a **sash above the side-panel tabs** surfaces the matching andee (Connect ⇄ Pending ⇄ Connected). Tapping the card dips the panel into a full-height **iframe of the andee's `and.com/&tag` public page** (reuses its info + `ProfileQR`) with a Back button.

**Key pieces:**
- `profileLinkFromUrl()` (`packages/utils/src/profile-links.ts`) — inverse of the profile-link URL-template registry.
- `findAndeesByProfileLink()` (`packages/db/src/queries/andees.ts`) + functional partial index `(hds_code, key, lower(value)) WHERE deleted_at IS NULL` (migration **0155**). Query matches `lower(value)` case-insensitively — index MUST be on `lower(value)` or it's unused.
- `POST /v1/developer/profile/related-andees` (`apps/api/.../developer-profile.ts`, scope `profile:read`) — **public-only** visibility (`filterSignalsForCaller(..., {allowConnectedTier:false})`, per ENG-782 OAuth-client rule); HDS bucket from platform category (payment→0.5.2 else 0.5.1); returns previews + env-correct `profileUrl` (`getAppUrl('web')`). Connect reuses `POST /v1/connections`.

**Reusable patterns / gotchas:**
- **OAuth scope-drift reconcile**: adding scopes to `OAUTH_SCOPE` does NOT re-consent existing extension users — the cached OAuth *client* was registered under the old scope and can't be granted the new one (`isClientRejected` ignores `invalid_scope`). Fix: store the registered scope (`storage.getRegisteredScope`), and a startup `reconcileScopeUpgrade()` in the service worker drops client_id + session on drift → forces a one-time re-register + re-consent. Dev-connect sessions (no refresh token) exempt.
- **Extension build channel**: manifest name/key now key off `BUILD_CHANNEL` (config.ts), separate from `APP_ENV` (Mixpanel). A **local build (no `GITHUB_RUN_NUMBER`) is always `development`** → `& (development)` + dev key, so an unpacked local build never clobbers the installed prod `&`. CI staging/prod unchanged.
- Public andee page `/andee/[tag]` must stay framable (no `X-Frame-Options`/`frame-ancestors`) for the iframe — guarded by `apps/web/__tests__/unit/andee-page-framing.test.ts`. Extension manifest CSP needs `frame-src <web-host>`.
- Migration collision on rebase: my 0153 → renumbered **0155** (staging had 0153/0154). drizzle-kit reformats `_journal.json` tabs→spaces on generate; restore staging's tab journal + append the new entry, and reformat the new snapshot to tabs, to keep the diff minimal.
