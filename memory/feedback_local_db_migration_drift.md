---
name: feedback_local_db_migration_drift
description: Local dev Postgres chronically lags migrations — integration tests fail with missing-column errors that look like code bugs; migrate or use a fresh scratch DB before trusting
metadata: 
  node_type: memory
  type: feedback
  sourceDream: 2026-07-29
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

`packages/db` integration tests **skip locally without `DATABASE_URL`**, and the local dev DB (`postgresql://ampersand:ampersand_local@localhost:5432/ampersand`) is **chronically drifted** — often many migrations behind (10 behind in one session; missing `agent_runtimes`/`fleet_hosts` columns from recent migrations like 0156/0157). So integration tests fail with **missing-column errors that look like code bugs but are local DB drift**, and a bad integration-test edit can ship only to fail in CI.

- Cheap check: run the local migrate script to bring the dev DB current before running integration suites.
- Reliable pre-push check: spin up a **fresh scratch DB** (non-destructive to the dev DB), run **all** migrations, and run the integration suite against it. ("All 16 integration files pass (242 tests) on a fresh DB.")

Related: [[feedback_local_db_migration_drift]] pairs with [[feedback_drizzle_migration_rebase]] (migration numbering) and [[feedback_no_manual_migrations]] (staging/prod migrate through CI).

**Why:** a "missing column" failure reads as your code being wrong when it's really the local schema being stale — you can waste time "fixing" correct code.
**How to apply:** before trusting a red integration suite, migrate the dev DB current (or run against a fresh fully-migrated scratch DB); only then treat failures as real.
