---
name: staging-gcp-access
description: "How to reach staging GCP/Cloud SQL from this machine — project id, broken-gcloud workaround, DB connection recipe"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 3e9d0fe7-11d6-4072-a96f-b59b87113d19
---

- Staging GCP project: `and-dev-89990` (production is `grounded-access-142814` — see [[gcp-project-ids]]).
- **gcloud is broken under the system Python 3.9** on this machine. Prefix every gcloud call with `CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.12` (installed via `brew install python@3.12`, 2026-06-11).
- Staging Postgres access: `cloud-sql-proxy and-dev-89990:us-central1:ampersand-staging --port=5433` (often already running — check `lsof -i :5433`), then build the URL from the secret:
  `URL=$(gcloud secrets versions access latest --secret=database-url-staging --project=and-dev-89990)` and rewrite host → `127.0.0.1:5433`, strip `?host=...`.
- Instance is `db-g1-small` with `max_connections=50` (bumped from db-f1-micro/25 after the 2026-06-11 connection-exhaustion incident, ENG-970). Client pools are capped at 5/process with 60s idle reaping in `packages/db/src/client.ts`.
- **Schema naming when writing raw SQL against staging PG (spot-check against `packages/db/src/schema/*.ts` — point-in-time as of 2026-07-30):** no `users` table — andees live in **`andees`**; `agent_runtimes`' kind column is **`runtime_kind`**, not `kind`; `trusted_hosts` has **no `status`** column; `tags` has **no `andee_id`** column. General rule: read the Drizzle schema in `packages/db/src/schema/*.ts` (or `\d <table>`) before writing raw SQL, rather than guessing column names and burning query round-trips.
- **Full staging→local DB clone recipe (2026-06-24):** staging server is PG **16**, local Docker is PG **17** — host `pg_dump` (14.x Homebrew) is too old, so run pg_dump/pg_restore from the **local postgres:17 container**, reaching the proxy at `host.docker.internal:5433`. Build the staging URL by rewriting the secret's host: `sed 's#@[^/]*/#@host.docker.internal:5433/#; s#?host=...##'`. Dump: `docker compose exec -T postgres pg_dump "$SURL" -Fc --no-owner --no-acl > /tmp/x.dump`. Restore: `ALTER DATABASE ampersand ALLOW_CONNECTIONS false` → terminate backends → `DROP/CREATE DATABASE` → `pg_restore --no-owner --no-acl`; then restart `pnpm dev` for a clean pool. Delete the PII dump from /tmp after. **Gotcha:** `docker compose up -d postgres` *restarts* a pre-existing (old) container with its stale config — `docker ps` shows `5432/tcp` (unpublished) not `0.0.0.0:5432->5432/tcp`, so the API gets ECONNREFUSED; fix with `docker compose up -d --force-recreate --wait postgres` (pgdata volume persists).
