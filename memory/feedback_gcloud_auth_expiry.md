---
name: feedback_gcloud_auth_expiry
description: "gcloud auth token expires mid-session and cannot be refreshed non-interactively — ask the user to run `! gcloud auth login` in-prompt, then resume"
metadata: 
  node_type: memory
  type: feedback
  sourceDream: 2026-07-29
  sourceRun: 2026-07-29-1335
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

On long prod/staging DB or Cloud Run investigations the **gcloud auth token expires mid-session** and the agent **cannot refresh it** — commands fail with `Reauthentication failed. cannot prompt during non-interactive execution.` This breaks both `gcloud` and Cloud SQL access (the DB password is fetched from Secret Manager, which also needs auth).

Recovery is always the same: ask the user to re-authenticate by running `! gcloud auth login` (the `!` prefix runs it in-session), then resume. Anticipate this on any multi-hour prod-verification thread — it often expires more than once. Distinct from [[feedback_cloud_sql_proxy_flaky]] (proxy dying) — this is the auth token, not the proxy.

**Why:** the agent can't complete an interactive re-auth, so the whole gcloud/Cloud SQL path stalls until the user acts.
**How to apply:** on `Reauthentication failed … cannot prompt`, ask the user to run `! gcloud auth login`, then continue; expect it again on long threads.
