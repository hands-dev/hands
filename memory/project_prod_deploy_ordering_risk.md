---
name: prod-deploy-ordering-risk
description: "The prod orchestrator runs DB migrations BEFORE smoke-gated API/MCP/Web/Admin deploys, so a flaky smoke causes silent schema drift between live API and DB. Caused a 13-day prod outage in June 2026."
metadata: 
  node_type: memory
  type: project
  originSessionId: 992e99b1-2b84-4225-b4ee-983e93faf2a6
---

## The trap

`.github/workflows/production-deploy-orchestrator.yml` runs jobs in this order on a `v*` tag push:

1. `security-scan` (pass/fail)
2. `terraform-apply` (pass/fail)
3. **`run-migrations` (production)** ← applies schema changes to prod DB
4. `smoke-test-preview` (pass/fail) ← hits `preview.and.com` via a separate `preview-deploy.yml` workflow
5. `deploy-api` / `deploy-mcp` / `deploy-web` / `deploy-admin` ← all gated on smoke pass
6. `smoke-test-production`
7. `verify-deployment`

When step 4 fails, steps 5–7 are skipped — but **step 3 has already run**. The live API container keeps serving the *old* code while the DB is on the *new* schema. Any column rename or constraint change becomes a guaranteed 500 storm the moment the next request hits the renamed surface.

## Why: it bit us hard

**Why:** ENG-855 (2026-06-03) renamed `andees.discoverable_by_contact_match → discoverable`. The migration applied to prod via the orchestrator's run-migrations step, but `smoke-test-preview` failed (cold-start flake hit a 10s timeout — see [[smoke-flake-prevention]]). API/MCP deploys were skipped silently for 6 consecutive tag pushes (v1.18.0 → v1.20.0). For 13 days production API stayed on v1.17.1 (2026-05-22, `api:0a37c27d`), still SELECTing `discoverable_by_contact_match`. The actual production crash didn't manifest until users woke up the next morning and `mobile-refresh` started hammering the renamed column → 92 events / 5h on AMPERSAND-API-J, mass `SessionExpiredError` cascade on mobile (AMPERSAND-MOBILE-{6,8,9}).

**How to apply:**
- When proposing any column rename / NOT NULL / FK change, treat the prod deploy chain as a serial dependency: migration + redeploy must succeed together, or the contract is broken.
- Before tagging a release that changes the schema, check the last successful `production-deploy-orchestrator` run — if it's >24h old, assume the API is on stale code and don't tag.
- A correct future fix swaps the ordering: migrations should gate on a successful API/MCP deploy, OR migrations and deploys should both gate on a single end-to-end smoke (not a preview-only one). Tracked as a followup in ENG-864's PR body.
- The companion convention to know is [[tag-on-staging-merge]] — tagging a later commit silently skips API/MCP redeploy too, for a related but distinct reason.

Related: [[smoke-flake-prevention]].
