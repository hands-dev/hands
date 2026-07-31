---
name: mobile-deploy-ref-must-match-environment
description: "When dispatching mobile-deploy.yml, --ref must match the target environment's branch (staging→staging, production→main)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2d8af35c-5d43-4603-bce6-757c68c2dcff
---

When dispatching `mobile-deploy.yml` via `gh workflow run`, the `--ref` flag controls which branch the EAS build checks out. **The ref must match the target environment**:

- `environment=staging` → `--ref staging`
- `environment=production` → `--ref main`

**Why:** EAS builds from whatever the workflow checked out. Dispatching `-f environment=staging --ref main` will produce a build for the staging EAS channel using main's code — silently missing any commit on staging that hasn't been promoted to main yet. The dispatch succeeds and the build completes, so this is easy to miss unless someone notices the missing changes on the device.

**How to apply:** any time you dispatch the workflow for staging, append `--ref staging`. Default to looking up the staging tip with `git log origin/staging --oneline -1` first if you're uncertain. For production releases, `--ref main` is correct because the v1.23.x tag deploys also use main.

Discovered 2026-06-09 when an ENG-887 + ENG-932 push to staging missed the And – Staging build because the dispatch had `--ref main` and main was behind staging.
