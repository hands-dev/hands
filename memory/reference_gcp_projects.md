---
name: GCP project IDs
description: Real GCP project IDs for ampersand environments — production starts with "grounded-" not "and-"
type: reference
originSessionId: 3c920124-da89-4e83-a899-105b978a801a
---
GCP project IDs:
- **Production**: `grounded-access-142814`
- **Staging**: `and-dev-89990` — confusing! The project ID has `-dev-` in it but its GCP `name` is "And - Staging" and it hosts the staging Cloud SQL instance (`ampersand-staging`) and the staging Firebase Storage bucket (`and-dev-89990.firebasestorage.app`). Do NOT assume a URL pointing at `and-dev-89990.firebasestorage.app` is a cross-env leak from dev — it's the native staging asset host. Confirm with `gcloud projects list --filter='lifecycleState:ACTIVE'`.
- **Development/personal**: same `and-dev-89990` project also serves as the dev environment (no separate dev GCP project today).

Key secrets in production:
- `api-test-bypass-token` — the value the API checks against the `x-test-bypass` header to allow +1816555XXXX numbers in production. Web forwards it from the `__test_bypass` cookie via `apps/web/src/app/api/proxy/[...proxyPath]/route.ts`.

Read with `gcloud secrets versions access latest --secret=<name> --project=grounded-access-142814`. The sandbox blocks production reads by default — use `dangerouslyDisableSandbox: true` only when the user has explicitly authorized both the specific secret and its destination.

The repo never hardcodes project IDs — they live in `vars.GCP_PROJECT_ID` in GitHub Actions, not in any committed file. So `grep` won't surface them; ask the user or check `gcloud projects list`.
