---
name: Tag release versions on the staging-merge commit
description: Production deploy orchestrator promotes per-tag-SHA preview images; tagging a non-staging-merge commit silently skips API/MCP deploys
type: feedback
originSessionId: 33fc563a-bf0f-4c13-8dd3-3f9ec5f1a12e
---
When cutting a `vX.Y.Z` release tag, the tag MUST point at the
staging→main merge commit (e.g. "Merge pull request #1430 from
theandcompany/staging"), not at a later commit on main.

**Why:** `.github/workflows/production-deploy-orchestrator.yml` decides
whether to redeploy API/MCP by looking for a `preview-deploy.yml` run
whose `headSha` matches the tag's commit SHA. Preview-deploy has path
filters — it only runs when API/MCP/web/admin paths change. A tag
landed on a mobile-only commit (e.g. an `app.config.ts` version bump)
has no preview-deploy run, so the orchestrator logs *"No preview-deploy
run for $SHA — this tag has no API changes (path filter skipped
preview-deploy). Skipping production redeploy; api-server stays on its
current image."* Web and admin still build fresh from source, so the
deploy looks 80% green while API + MCP stay on the previous tag's image.

Symptom that hit us on v1.16.0 (2026-05-19): mobile TestFlight hit prod
API and got "Andee not found" because the v1.15.4 API image was still
running. Fix was: delete the tag, recreate at the staging-merge SHA
(`060c1f63` in that case), force-push, let the orchestrator re-fire.

**How to apply:** before `git tag -a vX.Y.Z`, run
`git log --oneline origin/main` and pick the SHA of the most recent
"Merge pull request #XXXX from theandcompany/staging" commit. Don't
tag on top of subsequent main-only commits (mobile version bumps,
doc-only changes, etc.) — those silently skip the API/MCP promotion.
