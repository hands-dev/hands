---
name: Auth API Migration Plan
description: Plan to migrate and-api-server auth (OTP send/verify) into new apps/api Hono app with PostgreSQL storage
type: project
---

Migrating the monorepo's dependency on and-api-server (Kotlin/Spring Boot on GAE) into a new `apps/api` Hono app.

**Scope**: Only the 2 endpoints the monorepo actually uses — `private/send-sms-verification` and `private/verify-phone`. The mobile app's UDK/MIK/IPK crypto auth stays on the Kotlin server for now.

**Key decisions**:
- Hono (not Express) — consistency with apps/mcp
- PostgreSQL via @ampersand/db (not Firestore) — aligns with migration
- Port 3005 (next in sequence)
- Twilio for SMS (no Plivo fallback initially)
- Wire-compatible responses via `{ data: { ... } }` envelope

**Why:** Eliminates the monorepo's runtime dependency on a separate Kotlin server for auth. The Kotlin server remains for mobile-only features (UDK, chat, contacts, etc.).

**How to apply:** When working on auth flows, OTP verification, or the apps/api app, reference the full plan at `.claude/plans/jolly-giggling-music.md` or gist at https://gist.github.com/and-michael/6057f2ecb1d2cbef908647185612399b.
