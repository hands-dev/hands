---
name: project-staging-sandbox-worktree
description: The /Development/ampersand main checkout is the staging-pointing dev sandbox; worktree-1/2/3 stay fully local
metadata: 
  node_type: memory
  type: project
  originSessionId: fb64b0e2-1b31-41f7-b82e-d01bb388fcd6
---

Worktree topology for local dev (set up 2026-06-24):

- **`/Development/ampersand` (main checkout) = the STAGING sandbox.** Its `.env.local` was seeded from worktree-1 (to inherit backend secrets) then overridden: offset-0 ports (web 3001 / admin 3002 / mcp 3004 / api 3005 / metro 8081), `LOCAL_API_URL=https://api.staging.and.com`, `LOCAL_MCP_URL=https://mcp.staging.and.com/mcp`, mobile namespace `com.and.mobile.dev.staging` / sim `Ampersand-staging` / scheme `and-local-staging` / app name "And - Staging". The local backend still boots (full `pnpm dev` stack), but the mobile app + MCP talk to staging.
- **worktree-1/2/3 stay fully local** — `localhost` APIs at offsets 10/20/30 (metro 8091/8101/8111, bundles `…dev.wt{1,2,3}`).

**Why:** loops only get a live hosted agent when pointed at staging. Local provisioning is hard-gated off — `isHostedRuntimeAutoProvisionEnabled()` returns `process.env.RUNTIME_AUTOPROVISION_ENABLED === 'true'`, which is unset locally, so the local API returns `runtime_autoprovision_disabled` and never spins up a runtime VM. A locally-created loop is just an inert Postgres row (skill assigned, 0 items). See [[project-provision-on-login-prod]].

The mobile app chooses its backend in `apps/mobile/app.config.ts`: when `AND_ENVIRONMENT` is unset (local dev) it reads `LOCAL_API_URL` / `LOCAL_MCP_URL` from `.env.local` (else uses the baked staging/preview/prod URLs from `ENV_CONFIG`). `device-api.ts` / `api.ts` read `Constants.expoConfig.extra.apiUrl`.

**How to apply:**
- Testing loops end-to-end (agent deepening, real items) → use `/Development/ampersand`.
- Pure local/offline frontend work → use the numbered worktrees.
- First run of the staging sandbox needs a one-time native build of the `com.and.mobile.dev.staging` dev client: `pnpm mobile:ios` (sim) or `pnpm mobile:ios:device` (iPhone). No EAS credits — local xcodebuild.
- Logging into staging provisions a REAL agent VM (CPUS quota + cost) and writes to shared staging Postgres. Use a real staging andee, not the local `+1816555XXXX`/`267735` trick (that's local-backend only — see [[reference-local-dev-phone-auth]]).
- The sandbox runs whatever branch is checked out in the main worktree — to test a feature branch's app code against staging, check it out there (can't be checked out in a numbered worktree at the same time).
