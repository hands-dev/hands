---
name: project_eng1073_merged_rollout_pending
description: ENG-1073 (suggestion-feedback learning loop + photo/location provenance) merged to staging; fleet rollout deliberately deferred
metadata: 
  node_type: memory
  type: project
  originSessionId: dee30fd5-bccf-4818-bd7a-fd50c3891366
---

ENG-1073 merged to staging 2026-06-25 via PR #1875 (squash `bc7d64db`), Linear Done.
Added: derive-on-read suggestion-feedback profile (`getSuggestionFeedbackProfile` +
pure `reduceSuggestionFeedback` in `packages/db/.../signal-suggestions.ts`), new
`GET /v1/raw-signals/suggestion-feedback`, new MCP tool `suggestion_feedback_read`,
and `provenance` (`historical_photo|forward_location`) on identity-substrate venues.
No migration.

**Pending (deferred by Michael until more changes batch to staging):** the Hosted
Runtime Software Update — existing runtimes do NOT yet have the tool/skill. Ordered
rollout: deploy API → deploy MCP (tool must exist before skill references it) →
`scripts/fleet/publish-skills.sh` photo-location-identity to staging-team cohort →
verify convergence digest → widen. Related paved path: [[project_eng1055_capability_skill_paved_path]].

Note: `suggestion_feedback_read` has NO deprecated alias; the SKILL.md was written to
degrade gracefully (skip if tool unavailable) to survive the reprovision-ordering window.
