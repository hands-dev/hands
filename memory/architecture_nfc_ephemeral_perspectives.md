---
name: NFC entity perspectives implementation
description: NFC-triggered signal sharing between andees and entities (venues/businesses). Implemented on feat/public-profile-page branch 2026-03-28.
type: project
---

NFC entity perspectives — design completed and implemented 2026-03-28 on `feat/public-profile-page` branch.

**Core insight:** A tap-share is just a perspective. No separate "ephemeral" concept. Perspectives appear in the andee's regular list. Grants get optional `expires_at` with countdown badges.

**What was built:**
- **DB:** `entities` table + `entity_type`/`grantee_type` enums + `perspectiveGrants` extended with `grantee_type`, `expires_at`, `is_anonymous` + `perspectives` extended with `entity_context_id`. Migration: `0006_nfc_entities.sql`
- **API:** `GET /v1/entities/:slug` (public), `POST /v1/me/tap-grants` (atomic perspective+signals+grant), `GET/POST/PATCH/DELETE /v1/admin/entities` (admin CRUD), `GET /v1/admin/entities/:id/grants`
- **Admin:** Full entity CRUD at `/nfc-entities` (list, show, create, edit). Create generates X25519 key pair, returns private key once. Show page displays tap URL, grant counts, settings.
- **Mobile:** Consent screen at `apps/mobile/app/tap/[slug].tsx`. Signal selection, TTL picker, anonymity toggle. Perspective picker updated with entity name + TTL countdown badge.
- **Web:** Fallback page at `apps/web/src/app/(marketing)/tap/[slug]/page.tsx` for non-app opens.

**Why:** Enable physical-world interactions (tap NFC at a venue) to create ad-hoc perspectives granted to entities.

**Remaining open questions:** Entity private key storage long-term, expired perspective UX (grey out / re-share), signal vocabulary expansion.
