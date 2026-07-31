---
name: Don't run migrations manually against shared DBs
description: Migrations against staging/prod must run through CI (db-migrate.yml), not via manual `pnpm db:migrate` with prod credentials
type: feedback
---

Don't run `pnpm db:migrate` manually against staging or production DBs. Migrations must flow through CI (the `db-migrate.yml` reusable workflow invoked by deploy orchestrators). Manual runs are how the team got into the drift state ENG-634 fixed in the first place.

**Why:** Pre-ENG-634, drizzle-orm's silent skips caused tracking drift; people compensated with manual SQL fixes that introduced more drift. Now that ENG-634's tag-based runner + blocking gate are in place, CI is trustworthy and should be the only path. Manual runs reintroduce the exact class of human-tracked-state-vs-actual-state divergence the work was meant to eliminate.

**How to apply:** Resist the urge to run migrations manually even when "we're stuck on a deploy." Instead: surgical SQL on the tracking table (e.g. INSERT a single missing row to bring `__drizzle_migrations` into sync) is acceptable as a one-off recovery, but actually applying migration SQL must always go through CI. The brief production downtime window during a deploy's migrate → app phase is something the orchestrator is designed to handle.
