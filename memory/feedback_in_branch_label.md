---
name: in-branch label convention
description: Linear label "in-branch" marks work built and verified locally but not yet merged to staging. Use it to bridge the gap between In Progress and Done.
type: feedback
originSessionId: 3c920124-da89-4e83-a899-105b978a801a
---
When a Linear ticket's implementation is complete on a feature branch (tests green, locally verified) but the PR hasn't merged to staging yet, apply the **`in-branch`** label and keep the status at **In Progress**.

**Why:** The repo's convention (`feedback_done_means_merged`) reserves "Done" for tickets merged to staging. Without an intermediate signal, a ticket could sit in "In Progress" for a week with no indication of whether the work is mid-flight or just waiting on review/merge. The label disambiguates.

**How to apply:**
- After the implementation is complete and verified locally (unit tests + any smoke verification), add the label and leave status at In Progress.
- When the PR merges to staging, remove the label (or leave it — the status flip to Done supersedes it) and move to Done.
- Use the label only when work is meaningfully done locally — not as a way to mark partial progress.

The label is workspace-team-scoped to Engineering (id `26bb7e6e-4fbc-4d32-aa43-30a51335a856`, color `#8B5CF6`).
