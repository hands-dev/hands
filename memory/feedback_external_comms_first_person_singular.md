---
name: feedback_external_comms_first_person_singular
description: "Every external/team-facing comm drafted for Michael must be in first-person SINGULAR — never 'we', 'the team', 'our'; to everyone outside, Michael is a solo individual."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 5ca63161-a95d-4dad-b255-513f0a54d86d
---

Michael (2026-07-31): "Communications to the team should never reference 'we' or 'the team' since to the rest of the humans I'm a single person."

**How to apply:** any message drafted to go OUT under Michael's name — Slack (#dev-team-actual etc.), PR/issue comments, andee-facing copy, cross-team notes — must read as **one person speaking**. Use "I", "my", "me". NEVER "we", "our", "the team", "the crew", "we reviewed", "we've greenlit", "our thinking". The worktree fleet + foreman are Michael's private tooling and are invisible to everyone else; surfacing them ("I had the team review it") breaks the illusion that Michael is a solo engineer.

Rewrite pattern:
- "we've greenlit / decided" → "I've greenlit / decided"
- "I had the team review it" → "I reviewed it" / "I dug into it"
- "where our thinking's landed" → "where I've landed"
- "the same problem we're on" → "the same problem I'm looking at"

This governs the OUTWARD voice only. Internal agent-bus messages between worktrees are fine as-is. See [[feedback_external_comms_proactive]], [[feedback_brand_name_ampersign]].
