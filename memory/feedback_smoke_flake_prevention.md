---
name: smoke-flake-prevention
description: "Cloud Run canary smokes must use pre-warm + per-test 503/504 retry + wait for preview-deploy completion. Without all three, cold starts and rollout races silently skip deploy jobs."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 992e99b1-2b84-4225-b4ee-983e93faf2a6
---

When adding or modifying smoke tests for any Cloud Run-backed service (`apps/web`, `apps/admin`, `apps/mcp`, `apps/api`), all three of the following must be in place. Skipping any one of them produces a flaky test that, in the production orchestrator, *silently skips the deploy job that gates on it*.

1. **Pre-warm in the runner.** Before any test runs, the runner pings the base URL with a ~30s-per-attempt budget × 4 attempts until it gets any non-5xx response. Hides the first-request cold start from the test loop. Pattern lives in `apps/web/__tests__/smoke/runner.ts` and `apps/admin/__tests__/smoke/runner.ts` as `warmUp()`.

2. **Per-test cold-start retry.** Tests that opt in via `retryOnColdStart: true` retry once after a 2s wait when the first attempt returns 503/504 or hits a request-timed-out error. Catches second-hop cold starts (e.g. the web proxy forwarding to apps/api once web itself is warm). Predicate lives in each `tests.ts` as `isColdStartFailure()`.

3. **Wait for preview-deploy.** In the production orchestrator, `smoke-test-preview` polls `gh run list --workflow=preview-deploy.yml --commit=$SHA` until that run reaches a terminal state. Don't gate on its conclusion (Cloud Run keeps serving the prior revision on failure, and a real outage should surface as a failing smoke, not a silent skip). Honor `inputs.image_sha` for manual reruns.

**Why:** ENG-864 / 2026-06-04. The previous smoke had none of these, and the resulting flake caused a 13-day window where 6 production tag pushes silently skipped Deploy API/MCP/Web/Admin while their migrations did apply — see [[prod-deploy-ordering-risk]] for the downstream blast. A 10s request timeout vs ~22s observed cold start was the actual failure mode.

**How to apply:**
- New smoke runner → start by copy-pasting `warmUp()` from `apps/web/__tests__/smoke/runner.ts`. Don't write per-test retry logic from scratch — copy `isColdStartFailure()` + `attempt()` + the `runTest()` retry wrapper from the same file.
- New `smoke-test-*` job in any workflow → add the `Wait for preview-deploy to finish` step before the test invocation; pattern is in `.github/workflows/production-deploy-orchestrator.yml`.
- Don't rely on `min_instances=1` as the only mitigation — it removes the cold-start case but not the rollout race.
- If a smoke fails once in CI, do not auto-rerun it without checking the failure log. The whole point of these guards is that a real failure surfaces; if a guarded test still fails, it's worth investigating before retrying.
