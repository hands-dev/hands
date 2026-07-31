---
name: project_signal_review_queues
description: "TWO distinct signal review queues — enrichment drafts live in identity_signal_suggestions (status=draft, GET /v1/signals/suggestions), NOT identity_signals (status=pending, GET /v1/signals?status=pending)"
metadata: 
  node_type: memory
  type: project
  sourceDream: 2026-07-29
  sourceRun: 2026-07-29-1335
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

There are **two separate signal review queues** — wiring a review surface to the wrong one ships a silently-broken feature:

- **Enrichment drafts** (photo_scan / location / web_activity) live in **`identity_signal_suggestions`** with `status='draft'`, surfaced by `usePendingReviewQueue` / `GET /v1/signals/suggestions`.
- **`identity_signals`** with `status='pending'` is a **separate** queue read by `usePendingSignals` / `GET /v1/signals?status=pending`.

`listSignals("pending")` reads `identity_signals`, **not** the suggestions table where enrichment drafts land. Related: [[project_web_activity_enrichment]].

Prevalence 1 but kept: it shipped a broken feature (ENG-1371 wired to the wrong queue → ENG-1372 re-fix), so it's durable codebase behavior.

**Why:** the two queues look interchangeable but back different tables; picking wrong shows an empty/incorrect review surface.
**How to apply:** for enrichment drafts use `/v1/signals/suggestions` (`identity_signal_suggestions`, draft); for pending raw signals use `/v1/signals?status=pending` (`identity_signals`).
