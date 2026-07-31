---
name: Firestore to PostgreSQL migration
description: Large-scale migration from Firestore to PostgreSQL (CloudSQL) using Drizzle ORM — 9-phase plan covering schema, services, apps, infra, data migration, and Firebase decommission
type: project
---

Migrating entire data layer from Firestore to PostgreSQL on CloudSQL. Clean cutover (no dual-write), ~468 accounts so volume is trivial.

**Why:** Eliminate legacy normalization layer (4 andee doc variants, dual-format tags, transformer pipeline), get proper relational modeling, shared Drizzle ORM across turborepo.

**How to apply:**
- Phase 0: `@ampersand/db` package + Docker Compose (Drizzle ORM, postgres.js driver, drizzle-zod for Zod schema gen)
- Phase 0.5: 10 PostgreSQL tables (andees, tags, invitations, payments, refunds, employees, otps, email_logs, email_verification_tokens, app_config)
- Phase 1: Query layer + seed data (replace all Firebase Model classes)
- Phase 2: Service layer migration (`@ampersand/services` → `@ampersand/db`)
- Phase 3: App route migration (web, admin, app, mcp)
- Phase 4: CloudSQL via Terraform
- Phase 5: One-time Firestore→PG data migration script
- Phase 6: E2E test fixture updates
- Phase 7: Cutover (staging then prod)
- Phase 8: Firestore decommission
- Phase 9: Firebase Storage → direct GCS (follow-up)

Full plan source: https://gist.github.com/and-michael/61a32d2e8f5d4e8eb1a1e4edbecdccb7

Key architectural decisions:
- Drizzle ORM chosen for drizzle-zod, TypeScript-first, lightweight, AI-legible
- postgres.js driver (zero native deps)
- Docker Compose for local dev PostgreSQL
- Cloud Run connects via Cloud SQL Auth Proxy (unix socket)
- `updated_at` trigger via PL/pgSQL
- Stateless query helpers (not classes) accepting `db` instance
