---
name: Feature API Cloud Run deploy plan
description: Plan to deploy the mobile API feature branch to an isolated Cloud Run service in staging, connecting to staging CloudSQL
type: project
---

Plan stashed at `.claude/plans/velvety-floating-chipmunk.md` on 2026-03-27.

Spin up `api-mobile-feature` Cloud Run service via `gcloud run deploy` (no Terraform). Reuses `api-server-staging` service account. Needs two extra secret IAM bindings (`web-secret-key`, `web-firebase-service-account`). Connects to staging CloudSQL. Migration is additive-only (6 nullable columns with defaults) — safe for existing staging services.

**Why:** Test new mobile API endpoints (dual auth, profile CRUD, photo upload, token refresh) against a real environment without contaminating the existing staging `api-server` deploy pipeline.

**How to apply:** When ready to deploy, read the plan file and execute steps 1-5. Clean up the feature service when done testing.
