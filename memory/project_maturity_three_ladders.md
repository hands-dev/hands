---
name: project-maturity-three-ladders
description: Feature-maturity moved from a single 0–6 rung to three 0–4 ladders; two time-gated follow-ups remain
metadata: 
  node_type: memory
  type: project
  originSessionId: 8afb328a-f4bf-4e8c-8044-6853ef7b2118
---

The feature-maturity evaluator (`packages/maturity-eval`) was refactored from a
single **0–6 rung** to **three independent 0–4 ladders — Working · Observed ·
Operated** (a profile), with authoring on scenario-level `@test(ref)` +
`@observable`/`@operational` (reversing ENG-1216's per-clause `@covered-by`).
Shipped in **ENG-1281 / PR #2119, squash-merged to staging 2026-07-15**. All 16
Feature Catalog Linear projects were re-authored to the new grammar (via MCP,
parity-checked). Admin feature-registry renders three badges; the Linear write
heading is `**Eng. Maturity — Working n/4 · Observed n/4 · Operated n/4**`.

**Two follow-ups remain (both minor, non-blocking):**

1. **Remove the transitional V1 update-body read.** `registry/linear.ts` still
   reads the legacy `**Eng. Maturity: n/6**` heading (approximated) because the
   migration rewrote project *descriptions*, not historical *update* bodies —
   those only get a V2 replacement when the evaluator next runs on a `v*` tag.
   Once the first prod tag-eval has written V2 updates for all 16 features,
   delete `MATURITY_UPDATE_HEADING_V1` + `v1Profile` and its test. (The Gherkin
   parser dual-read was already removed.)
2. **Cosmetic:** the "View other tag (mobile)" project has a scenario whose
   `@test` `::case` name contains a literal comma, so the comma-splitting
   grammar renders a spurious extra `@test(ignoring leaf depth)` line. Score
   unaffected; hand-fix that one coverage line in Linear.

The evaluator is non-blocking (runs on `v*` tags, never gates a deploy).
See [[feedback_done_means_merged]].
