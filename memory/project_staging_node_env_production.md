---
name: project_staging_node_env_production
description: "Staging runs with NODE_ENV=production, so all dev-only API routes (/v1/dev/*, reset-onboarding, mint-autofill-token) return 404 on staging — seed/reset via direct DB + GCS instead"
metadata: 
  node_type: memory
  type: project
  sourceDream: 2026-07-29
  sourceRun: 2026-07-29-1335
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

**Staging runs with `NODE_ENV=production`**, so all dev-only API routes (`/v1/dev/*`, e.g. `reset-onboarding`, `mint-autofill-token`) **return 404 on staging** (dev routes are gated off when `NODE_ENV === 'production'`). Don't assume dev endpoints are usable against staging — seed/reset via **direct DB + GCS** instead. (The web-activity aggregation window is also 30 days, relevant when seeding.)

Related: [[reference_staging_gcp_access]], [[project_web_activity_enrichment]].

**Why:** a 404 on a dev route against staging looks like a broken deploy but is really the production gate.
**How to apply:** to seed/reset staging state, write directly to DB + GCS rather than calling `/v1/dev/*` endpoints.
