---
name: feedback-linear-subissue-cascade
description: Linear in this workspace auto-completes sub-issues when the parent is marked Done — pre-empt or reverse it for any diagnosis→implementation parent
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9e08f5a1-ebc5-4401-a098-fcacc41d4362
---

When a Linear issue is moved to Done in this workspace, all its sub-issues are auto-cascaded to Done at the same timestamp (no intermediate state transition, no comment). Discovered on ENG-880 (2026-06-08): a diagnosis ticket marked Done cascaded ENG-895, ENG-896, ENG-916, ENG-917 — all four implementation spinoffs the writeup created — to Done with no work performed.

**Why:** Linear's "sub-issue auto-complete" workflow setting is enabled at the workspace level. Useful for parent tickets that genuinely represent a rollup of their children, but actively wrong for any parent whose acceptance is independent of its children (diagnosis tickets, epics where children survive as standalone work).

**How to apply:**
- Before moving any parent to Done, check `list_issues parentId:<id>` and decide per-child whether it should cascade. If even one shouldn't, move the parent to a non-completed state and either (a) reparent the children to a separate epic, or (b) move the parent to Done and immediately reopen the children with `save_issue state:Todo`.
- After any parent→Done transition, re-check every child's state — Linear's API returns the cascade-updated state on subsequent reads but doesn't fire a notification.
- For diagnosis tickets specifically: the deliverable is the writeup, not the implementation. The implementation spinoffs are siblings in spirit, even if they're sub-issues structurally. Default to detaching them or accepting the reopen overhead.
