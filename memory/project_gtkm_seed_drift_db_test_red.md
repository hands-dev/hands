---
name: project_gtkm_seed_drift_db_test_red
description: "get-to-know-me interview shows placeholder One/Two/Three because the running fleet lacks the <&loop_questions> skill (DB seed drift since fixed by 0090)"
metadata: 
  node_type: memory
  type: project
  originSessionId: dee30fd5-bccf-4818-bd7a-fd50c3891366
---

**DB-test-red (RESOLVED 2026-06-26):** `packages/db/__tests__/loop-skills-seed.test.ts`
was red on staging because the `ampersand-get-to-know-me` `SKILL.md` (edited in PR
#1867 to add the `<&loop_questions>` section) drifted from its byte-for-byte seed in
migration `0085` (v1.6.0). Migration `0090_loops_skills_v1_7_0.sql` (#1880, 2026-06-26)
republished it as v1.7.0 with the matching digest — the test passes now. (Branch
protection on `staging` requires only **Validate Linear Cycle Membership**; that red
was never a merge gate.)

**Live TestFlight bug (2026-06-26, OPEN — owned by another engineer):** the "Get to
know me" interview renders placeholder options **One/Two/Three/Four/Five**. That card
is the app's FULL fallback — `fallbackQuestions()` in
`apps/mobile/lib/use-get-to-know-me-interview.ts` builds the prompt locally from the
category and triggers when the agent doesn't return a valid `<&loop_questions>` batch
within `FALLBACK_AFTER_MS` (12s).

Root cause = **hosted-runtime software-update gap, not an app/code bug**. Runtime
agents read the skill from the fleet-published archive (`scripts/fleet/publish-skills.sh`
→ desired-release → convergence), which is **content-addressed** (`ocr-<ver>-<digest8>`).
The skill source + DB seed are current on staging, but the **fleet was never
re-published** since the skill changed (rollout deferred), so live VMs run the OLD
digest with no envelope instructions → agents reply in freeform chat → app falls back.

Fix path: deploy staging API with the new source (done), then publish the skills
archive to the staging fleet (needs KMS/OTA operator creds + a named cohort; full-fleet
needs `--behavior-proof-file`). NOT verified against the live fleet digest (no API
creds in-session). Secondary risk: the 12s timeout may still cause fallbacks for a cold
agent even after publish — a separate mobile-side fix. `worktree-loop-skills` is
actively redesigning the gtkm skill (`bd3a3d8c apply redesigned get-to-know-me skill`),
so the publish may want to wait for that. See [[project_eng1055_capability_skill_paved_path]].
