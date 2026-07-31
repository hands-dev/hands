---
name: Linear ticket defaults
description: Always assign Linear tickets to the user, add to current cycle, and set status to Todo unless explicitly overridden
type: feedback
---

When creating Linear tickets, always apply these defaults:
- `assignee: "me"`
- `cycle: <current cycle number>`
- `state: "Todo"`

**Why:** The user creates tickets for their own work and wants them immediately visible in the current sprint. Setting these manually each time is friction.

**How to apply:** Apply on every `mcp__linear__save_issue` call for new issues. Only omit if the user explicitly specifies different values.
