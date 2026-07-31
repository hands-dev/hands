---
name: feedback_admin_prod_deploy_env_and_storage
description: "admin/web images promote preview→prod so build-time env bakes wrong; and the admin GCS client auths as the firebase-adminsdk SA, not the runtime SA"
metadata: 
  node_type: memory
  type: project
  sourceDream: 2026-07-29
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

Two prod-only footguns for the admin/web apps:

- **Docker images are promoted preview→production**, so any env read at **build/module-load time** — raw `process.env.AND_ENVIRONMENT` in a server component, or any `NEXT_PUBLIC_*` var — bakes in the **PREVIEW** environment and is wrong in prod. Env-dependent UI must read the environment **at runtime** via `getRuntimeAppEnv()` / `@/lib/runtime-env`, and the route/page must be `force-dynamic`.
- **The admin GCS storage client authenticates via `GCP_SERVICE_ACCOUNT_JSON`** (the `firebase-adminsdk-fbsvc@grounded-access-142814.iam.gserviceaccount.com` SA), **NOT** the Cloud Run runtime SA. A newly-created bucket whose IAM grants only the project runtime/legacy SAs will **403** (surfacing as a catch-block 500) until `roles/storage.objectViewer` is granted to the firebase-adminsdk SA. Staging happened to work because its key-SA already had project-level storage read.

Prevalence 1 but kept: each cost a real prod bug + follow-up PR. See [[project_prod_deploy_ordering_risk]] and Admin Dashboard Architecture in [[MEMORY]].

**Why:** both pass in preview/staging and fail only in prod, making them expensive to diagnose after the fact.
**How to apply:** read env at runtime (`getRuntimeAppEnv()` + `force-dynamic`), and grant new buckets `objectViewer` to the firebase-adminsdk SA, not the runtime SA.
