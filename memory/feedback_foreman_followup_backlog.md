---
name: feedback_foreman_followup_backlog
description: "Maintain a Linear \"foreman-followup\" backlog (assigned to Michael) of follow-ups surfaced during worktree work; pull the top unblocked item from it when a worker goes idle."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5ca63161-a95d-4dad-b255-513f0a54d86d
---

Michael (2026-07-31) approved a durable foreman-maintained follow-up backlog so idle workers get resourced from a real queue, not improvised from the active fire.

**Where:** Linear label **`foreman-followup`** (Engineering team; label id `d787a0ab-834e-4e2a-bb41-b0a14263773a`). Tickets go **assigned to Michael**, **Backlog** state (no cycle — these are for-later, not current-cycle work).

**The discipline:**
- When a worker (or you) identifies a "file for later" engineering follow-up, file it as a Linear ticket under `foreman-followup` (assigned to Michael, Backlog), with enough context to act on cold.
- When a worker goes idle AND isn't needed on the active priority/fire, **pull the top unblocked item off `foreman-followup`** to resource them — don't leave them idle, and don't only improvise from the active incident.
- Keep the split clean: **Michael-personal to-dos** (decisions, merge clicks, re-auth, things only he can do) stay on the **agent-bus todo list** (`agent_bus_todo_add`); **engineering follow-ups** go to the **Linear backlog**.

Why: during the 2026-07-31 fleet incident, idle workers were resourced ad-hoc off the active fire, which worked mid-incident but risks non-urgent follow-ups scattering/dropping once the fire's out. The label is the single queue to pull from. See [[feedback_linear_ticket_defaults]], [[feedback_subagents_vs_worker_delegation]].
