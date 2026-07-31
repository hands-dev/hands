---
name: feedback_foreman_reviews_zoomed_out
description: "Foreman PR reviews are ZOOMED-OUT priority-alignment reviews, not line-level code review — code specifics belong to Greptile/peer sign-offs."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8b3a496c-bd42-4eb7-934b-b9020d7b1621
---

Michael (2026-07-31): "I want your reviews of code to be zoomed out, not so much about the code
specifics but about 'is this PR mapping directly to the priority that we're solving for right
now.'"

**Why:** The foreman is chief-of-staff, not another code reviewer. Line-level correctness is
already layered — Greptile on every PR, peer/domain sign-offs (e.g. wt3's isolation reviews),
and the authoring worktree's own tests. The foreman's unique value is the altitude nobody else
holds: the ranked priorities + the whole board.

**How to apply — the foreman review checklist (replaces defaulting to /code-review high):**
- **Priority mapping:** does this PR directly advance the CURRENT ranked priority? Which one?
  If it doesn't map, why is it landing now?
- **Scope match:** is the diff what was asked — no drive-by scope, no under-delivery?
- **Board fit:** does it fight/duplicate another initiative, a migration, or a retiring lane
  (see [[feedback_foreman_proactive_board_crosscheck]])?
- **Blast radius proportionate:** is the risk (migrations, infra, destructive rolls) justified
  by the priority it serves? Are the gates (canary, flag, staging-first) in place?
- **Right sequencing:** should it land now, after something else, or wait?

Deep multi-agent line-level review (/code-review high) is the EXCEPTION, reserved for
irreversible/destructive-rollout diffs — and even then prefer delegating the deep pass to a
worktree; the foreman's own verdict stays at the alignment level.
