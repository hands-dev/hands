---
name: Don't push EAS updates without explicit ask
description: Each `eas update` burns EAS credits — never push to a staging/preview/production channel unless the user explicitly asks. Local dev (Metro hot-reload) is the default verification path.
type: feedback
originSessionId: cd0f0498-b9cc-46ff-a35b-ba62301a6315
---
Do **not** run `eas update --channel <env>` (or `pnpm eas:update:<env>`) as part of a normal ship flow. Each publish burns paid EAS credits and the user does most verification in the local sim against `pnpm dev`, not against EAS-distributed builds.

**Why:** Burning credits adds up across small iterations. The user paid for an EAS plan with a finite quota and is intentionally conservative about per-PR pushes.

**How to apply:**
- After admin-merging a PR to staging, **stop**. Don't follow up with `eas update`.
- Mention in the wrap-up that the change is on staging git but **not** on the EAS staging channel yet, in case the user wants to push it.
- Only run `eas update` (or `eas build`) when the user says something explicit: "push to staging", "EAS update it", "send it to my phone", "OTA it", etc.
- This rule covers the EAS *update* (OTA) path. Native EAS *builds* (`eas:build:*`) are even more expensive — same rule, stronger emphasis.
