---
name: cycle-gate-inn-tickets
description: "An Innovation-team (INN-XXX) ticket ref passes the \"Validate Linear Cycle Membership\" PR gate even though the Innovation team runs no cycles."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 80ae8413-eb9f-417a-8a75-6c890f38c840
---

On staging PR #2314 (base `staging`) the body led with **INN-219** (Innovation team, `teamId 238a7d84-50fb-4c3c-bcdc-918c4ec00f37`). `list_cycles(type:current)` for Innovation returned `[]` — the team has **no active cycle** — yet the **"Validate Linear Cycle Membership"** check **passed in 6s**.

**Why:** The cycle-gate does not require the referenced ticket to sit in an active cycle for teams that don't run cycles. It validated the INN ref as a member without an Innovation cycle existing. So the "needs a *current-cycle* ticket" rule (which came from ENG experience) is really "the referenced ticket must satisfy the gate for its team" — and for cycle-less teams like Innovation, an in-progress INN ticket suffices.

**How to apply:** For INN-scoped work, lead the PR body with the relevant `INN-XXX` ref; you do NOT need to invent or attach an ENG current-cycle ticket to pass the gate. Still lead with the ref (the gate/`cycle-gate` reads the first ticket ref). Only reach for an ENG current-cycle ticket when the work is ENG-team-scoped. Related: [[feedback_cycle_gate_first_ticket_ref]], [[feedback_ci_merge_gotchas]].
