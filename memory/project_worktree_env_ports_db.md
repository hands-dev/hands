---
name: project_worktree_env_ports_db
description: "This worktree runs a +20 port namespace and its .env.local sets no DATABASE_URL — dev stack shares worktree-1's localhost Postgres and mobile defaults to staging API"
metadata: 
  node_type: memory
  type: project
  sourceDream: 2026-07-29
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

Before asserting default ports/DBs in a worktree, derive the offset and confirm the actual target:

- This worktree uses a **+20 port namespace** — Admin Console is `http://localhost:3022` (not 3002), and the rest shift by +20 similarly (Web :3021, App :3023, etc.). Compare with the base dev stack (Web :3001, App :3003, Admin :3002 — see App Routing in [[MEMORY]]).
- Its `.env.local` sets ports but **no `DATABASE_URL`**, so the admin/db client falls back to the default `localhost:5432` = **worktree-1's shared Postgres** (not an isolated DB). Edits here are not sandboxed from other worktrees' DB state.
- **Running `@ampersand/db` integration tests** (`pnpm -F @ampersand/db test:integration`) requires `DATABASE_URL` exported (unset in env files). The docker-compose Postgres creds are `ampersand` / `ampersand_local` / db `ampersand`, so: `export DATABASE_URL="postgres://ampersand:ampersand_local@localhost:5432/ampersand"`. The wt-1 container is the one bound to `0.0.0.0:5432` (`docker ps` shows `ampersand-worktree-N-postgres-1`). Apply pending migrations first with `pnpm -F @ampersand/db migrate` (ignore the pre-existing `0080/0085/0090/0094 loops_skills` hash-mismatch warnings — [[project_gtkm_seed_drift_db_test_red]]). Integration files self-guard: they throw if `DATABASE_URL` is missing.
- The **mobile app defaults to `staging`** (`ENV_CONFIG[... ?? 'staging']`) — even local Metro talks to `api.staging.and.com` unless overridden. `.env.local` `LOCAL_API_URL=http://localhost:3025` points at localhost, which is **unreachable from a physical iPhone** ("No internet connection").

**Why:** assuming the base ports/DB in this worktree sends you to the wrong service or a shared DB, and the mobile "no internet" symptom is really localhost-unreachable-from-device.
**How to apply:** compute the +20 offset for URLs, remember the DB is shared with worktree-1, and for physical-device testing point mobile at a reachable host, not localhost.
