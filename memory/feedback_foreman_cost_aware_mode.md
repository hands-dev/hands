---
name: feedback_foreman_cost_aware_mode
description: "Cost-aware foreman mode — trade verification for velocity, keep irreversible-action gates."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0dad843a-5034-4393-9983-50fd0fefa31f
---

As of 2026-07-31 the team is on usage credits — move at the same speed but with **less double-checking**. Baked into `.claude/skills/foreman/SKILL.md` ("Operating mode — cost-aware").

**Why:** Every token has a direct cost now; redundant verification (re-reading a worker's source, re-deriving an already-evidenced conclusion, confirm-then-act handshakes, status pings for readable state) is the waste to cut — not throughput.

**How to apply:**
- Adjudicate returned tasks from the `result` + `priority`; don't re-read the worker's files or re-run their investigation. Spot-check only when irreversible or surprising.
- Auto-resolve a **wider reversible slice** on a confident read; escalate only genuinely irreversible / product-judgment / cross-worktree calls.
- One clear delegation/answer, no handshake; batch reads once per pass; don't re-establish known state.
- **Do NOT trim safety:** hard gates stay (no merge to main/prod, no destructive/shared-CI/deploy/migration, no `--admin` without Michael), plus on-host cleanup-and-CONFIRM and rebase-before-delegation. Trim verification, not the irreversible-action gates.

**Admin-merge authority (Michael, 2026-07-31):** foreman MAY `--admin` merge low-risk WORKER PRs to keep moving — an otherwise-green, bounded PR blocked only by a known-flaky non-required check or a cosmetic process gate (prefer a clean fix first if cheap, e.g. cycle-add the ticket). Do NOT admin-merge past a COMPLIANCE gate (data-classification ratchet / PII/secret/sink checks) even when inherited from a red base — fix the base. Do NOT admin-merge risky diffs (infra/migrations/deploy) or anything to main/prod — those still escalate. This loosens the prior "never admin-merge alone" rule; use the judgment, don't rubber-stamp. Baked into `.claude/skills/foreman/SKILL.md` §6B.

**Model tiers (standing, set 2026-07-31):** wt4 (C.J.) is the SOLE Opus worker; all other workers (wt1/2/3/6) are Sonnet; the foreman stays on a strong model. **Route Opus-worthy work to C.J.** — deep-design, architecture, highest-stakes / irreversible-adjacent (e.g. the clean-sheet structural-isolation spine + the atomic attestation flip). Keep mechanical/scoped work on the Sonnet bench. If Opus-worthy work backs up on C.J. and she becomes the bottleneck, **recommend a model change to Michael** (temporarily bump another worker to Opus for a specific high-stakes task, or resequence) — his call, never a silent pane switch. Also: keep critical-path builders *driving continuously* to a real milestone — don't let them yield-and-park between micro-increments waiting for a nudge (the `/loop /worker` default).

Applies to the foreman today; likely propagate the same "trim verification, keep gates" posture to worker directives if asked. Related: [[feedback_foreman_reviews_zoomed_out]], [[feedback_onhost_measurement_cleanup]], [[feedback_foreman_rebase_before_delegation]].
