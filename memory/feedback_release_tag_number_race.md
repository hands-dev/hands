---
name: feedback_release_tag_number_race
description: Release vX.Y.Z numbers advance concurrently — git fetch --tags and compute the next FREE version immediately before tagging; the number you saw earlier is often already taken
metadata: 
  node_type: memory
  type: feedback
  sourceDream: 2026-07-29
  sourceRun: 2026-07-29-1335
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

Production release tags (`vX.Y.Z`) **advance concurrently** — teammates cut promotion tags from their own staging→main merges at the same time. Before cutting a prod tag, `git fetch origin --tags` and compute the next **free** version **immediately before** tagging; the number you saw earlier in the session is frequently already taken, and assuming a stale next-number risks a collision or tagging the wrong SHA.

Complements [[feedback_tag_on_staging_merge]] (which SHA to tag) — this is about which NUMBER is still free. See also [[feedback_use_git_tags_not_releases]].

**Why:** the release counter moves under you between when you read it and when you tag.
**How to apply:** `git fetch origin --tags` and recompute the next free `vX.Y.Z` right before tagging, never from a number seen earlier in the session.
