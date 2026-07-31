---
name: feedback_cloud_sql_proxy_flaky
description: "Cloud SQL proxy dies mid-session (pkill+restart) and :5433 is usually staging's — use :5434 for prod so you don't clobber staging"
metadata: 
  node_type: memory
  type: feedback
  sourceDream: 2026-07-29
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

During long sessions the **Cloud SQL proxy repeatedly dies mid-work** — queries start failing; `pkill -f cloud-sql-proxy` then restart it and re-query.

The default port **`:5433` is usually already held by a *staging* proxy** (see [[reference_staging_gcp_access]]), so run **prod** work on a distinct port (**`:5434`**) to avoid clobbering the staging connection.

**Why:** a dropped proxy makes queries fail as if the DB is down, and reusing :5433 for prod kills an in-flight staging session.
**How to apply:** when queries suddenly fail, `pkill -f cloud-sql-proxy` and restart; bind prod to `:5434`, leave `:5433` for staging.
