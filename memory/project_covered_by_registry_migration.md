---
name: project_covered_by_registry_migration
description: "All 16 feature-catalog Linear projects migrated to per-clause @covered-by; several referenced tests don't exist yet"
metadata: 
  node_type: memory
  type: project
  originSessionId: 07596a93-a028-4c66-85fd-10b045a91094
---

2026-07-09: ENG-1216 (per-clause `@covered-by`, hard-enforced; PR #2036, squash `904b14b1`) merged to staging, then all **16 feature-catalog Linear projects** (initiative "Feature Catalog" `da313259-45e2-43a5-8a55-51a0ed2fbb7c`) were re-authored from scenario-level `@covers(path)` to inline per-clause `@covered-by(path::case)`, one assertion per `Then`. Verified deterministically with the real `maturity-eval` parser (0 invalid, 0 broken links). See [[project_feature_maturity_rubric]] and [[project_feature_registry_scenario_tickets]].

Key mechanics that bit during migration:
- The evaluator's compound-splitter flags any `Then` with a space-delimited ` and ` / ` but ` / `;` yielding ≥2 multi-word fragments as `invalid`. Conjoined **noun lists** ("category, type and provenance") trip it too — fix by rewording the trailing " and"→"," or "/", or splitting into `And` lines. A single comprehensive test may legitimately prove several split clauses (e.g. `notification-catalog.test.ts` proves all 4 catalog invariants).
- A scenario-level (coarse) `@covered-by` only satisfies a **single-clause** scenario; multi-clause needs each clause linked inline.

**Honest gaps surfaced (registry references tests that DO NOT exist in the repo — clauses left bare, scenarios read unverified):** `apps/mobile/__tests__/screens/connects.test.tsx`, `.../notifications.test.tsx`, `.../pending-review.test.tsx`, `.../home-screen.test.tsx`, `packages/services/tags/__tests__/tag-registration.service.test.ts`. Also intentionally un-linked on honesty grounds: Push `@administerable` (catalog test proves data, not the admin surface); Location-mcp read happy-path (its `@covers` pointed at an ingest test, not a read test); View-my "grouped by HDS domain **with per-category counts**" (grouping proven, per-category counts not).

Post-migration rung/ceiling per project (v = verified core count): Public-page(web) 1/5 · Location(mcp) 2/5 · Connections(mobile) 3/6 · View-other(mobile) 3/6 · Home(mobile) 1/5 · Peer(mobile) 4/5 · Peer(mcp) 4/5 · Connections(mcp) 3/5 · Push(mobile) 4/6 · Phone-auth(mobile) 3/5 · Encryption(mobile) 1/5 (shelved) · Signals(mobile) 3/6 · Signals(mcp) 4/5 · Location(mobile) 3/5 · Claim(web) 3/6 · View-my(mobile) 1/5.
