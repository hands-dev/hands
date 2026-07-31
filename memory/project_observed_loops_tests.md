---
name: project_observed_loops_tests
description: Observability tests + instrumentation to lift Loop 0/1/2 features to Observed >=3 (branch feat/eng-observed-loops)
metadata: 
  node_type: memory
  type: project
  originSessionId: fc2ba994-82af-48e7-b06f-1761486f9af4
---

Raising the **Observed** ladder (of the three-ladder maturity profile, see
[[project_maturity_three_ladders]]) to **>=3** for all 11 Loop 0/1/2 Feature
Catalog features. Branch **`feat/eng-observed-loops`** off origin/staging at
worktree `/Users/michaelphillips/Development/ampersand-observed`. **Built + all
tests green + verified via the maturity harness; NOT committed, NO PR yet.**

**Observed scoring (deterministic, assess.ts):** over a feature's `@observable`
scenarios — v=0 →1, u>=2 →2, u==1 →3, u==0 →4. Single-`@observable` features are
all-or-nothing (prove →4). Only **view-my-tag** has 2 `@observable` (proved 1 →3
by design; render-failure scenario left as an honest gap).

**Result (harness dry-run, staging tree):** all 11 loops now Observed >=3 — ten at
**4**, view-my-tag at **3**. (Working/Operated unchanged.)

**Tier A (test-only, signals already fired):** location-mcp, signals-review-mobile,
signals-review-mcp, connections-mcp, peer-questions-mcp. New MCP tests
(`apps/mcp/__tests__/unit/{connections,questions}-tools.test.ts`) needed node:test
module mocking → added `--experimental-test-module-mocks` to `apps/mcp` `test:unit`
(trackServer is a no-op w/o a token, so must be intercepted).

**Tier B (real instrumentation + test):** 2 new canonical events in
`packages/analytics/src/events.ts` — `CONNECTION_DENIED` (deny arm; Connects-tab
decline) + `HOME_CARD_IMPRESSION`. Emits: loops.tsx (3 home tiles), you.tsx already
had APP_TAB_VIEWED{tab:'you'} (reused, no new event), use-pending-connections.ts
(accept/deny + captureWithTags), andee-profile/[id].tsx (wired existing
PUBLIC_PROFILE_VIEWED, gated !isConnected), location-task.ts
(LOCATION_BACKGROUND_TASK_FAILED). #9 peer-questions-mobile: transitions are
server-side truth → retargeted @test to `apps/api/.../peer-questions.test.ts`;
**`expired` clause to be parked** (no such event).

**STILL OWED — the Linear pass** (chose "code first, Linear at end"): add the
`@test(path::case)` tag to each `@observable` scenario in its Feature Catalog
project, reconcile #8 scenario wording (`mcp.connected` → real `mcp.connection_*`),
park peer-q `expired`. Then a PR into staging (needs an `ENG-XXX` ref for the
cycle-gate — no ticket yet).

**GOTCHA (important, bit us):** the evaluator's `@test` ref parser **splits on
commas**, so a `::case` substring containing a comma spawns a bogus second ref that
never resolves → scenario stays unverified. Connections-mobile's case
`{targetAndeeId,targetTag}` hit this (same class as the known view-other-tag comma
bug). **Never put a comma in an `@test(::case)` name** — use a comma-free substring
(verify.ts substring-matches the test file). Also: the maturity CLI arg parser
makes every flag consume the next token, so put boolean `--dry-run` LAST (or
`--dry-run=true`) or it eats `--registry`.

Verified locally the mobile jest job should be a **required** CI check so these
grade as strong (gate/component) provenance, not existence-tier.

**COLLISION w/ ENG-1284 (resolved).** A parallel session shipped **ENG-1284 /
PR #2133** to staging (2026-07-15 23:57) doing the SAME connections-mcp +
connections-mobile observability (CONNECTION_DENIED, accept/deny emits, the mcp
mock flag, `connections-tools.test.ts` + `use-pending-connections.telemetry.test.tsx`)
plus Working-ladder UI (people-you-know render, `useOptimisticConnectionRemoval`,
notification-tap→profile). My PR #2134 duplicated it. **Resolution:** merged staging
into the branch and dropped ALL connections work — took staging's version of every
connections-owned file; my PR is now the **9 non-connections loop features** only.
`andee-profile.tsx` keeps both (staging optimistic-remove + my PUBLIC_PROFILE_VIEWED).
**Linear clobber (fixed):** my "all 11" pass had overwritten connections-mcp/mobile
descriptions with pre-ENG-1284 fixtures, dropping ENG-1284's `@test` refs + the mobile
Operated `@na`. **Linear does NOT version descriptions — no history to restore from.**
Reconstructed both from staging's actual tests + PR #2133 and re-saved: added the
missing `@core` `@test` refs (scope→`connections-tools::rejects request`;
accept-bucket→`use-pending-connections.telemetry::removes the request from the incoming
bucket when accepted`; notification-tap→`connection-notification-routing::opens the peer
profile when a connection request notification is tapped`; optimistic-remove→
`use-optimistic-connection-removal::removes optimistically and defers…`), fixed the
`@observable` tag, restored Operated `@na`. Harness now reads both **4/4/N-A**.
