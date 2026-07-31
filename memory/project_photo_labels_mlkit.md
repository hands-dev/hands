---
name: project-photo-labels-mlkit
description: Re-adding on-device MLKit image labeling to the photo→identity pipeline (ENG-841 revival)
metadata: 
  node_type: memory
  type: project
  originSessionId: a97bd859-cb72-417f-9967-307b15d4b682
---

Re-added on-device MLKit image labeling to the photo→identity pipeline as of 2026-07-01. Ticket **ENG-1131** (cycle 22). **MERGED to staging** via PR #1935 (squash `1c6cea19`, admin-merge — only required check "Validate Linear Cycle Membership" was green; Greptile is non-required and its re-review was still pending). Rebased onto staging first (resolved a one-line import conflict in `raw-signal-extractor.ts` vs ENG-1130's `SPOT_CAP`; migration 0100 had no collision). Plan: `.claude/plans/i-want-us-to-zany-sun.md`.

Applied both Greptile P2s before merge: `isRawLabelRecord` now enforces the `[0,1]` confidence range; `inferLabelIdentityFromBins` emits `PHOTOS_IDENTITY_INFERRED` on the `dedup_unavailable` path too.

**Why:** GPS-only identity is thin. Image content (pets/food/hobbies/outdoors) is richer and captures ungeotagged photos. ENG-841 had this on-device; ENG-1031 ripped it out when scanning went off-device (dumb shipper). Now re-added respecting the current "thin shipper + one server reasoner" architecture.

**Architecture:** MLKit labels on-device (privacy: only `{name,confidence}` labels leave, never pixels); a new `photo_labels` raw-signal kind ships them; server aggregates → HDS bins → LLM reasoner drafts `label_pattern` signal_suggestions. Confirmed decisions: most-recent-500 count cap (foreground) / 100 (background walk); local-originals-only (no iCloud fetches); server LLM reasoner (not on-device templates).

**Key files:** `apps/mobile/lib/photo-inference/labels.ts` (resurrected, SDK-55 manipulator context API) + `label-ship.ts` (caller-side label pass), `apps/api/src/lib/photo-labels-aggregate.ts` + `label-identity-{drafter,inference}.ts` + `hds-prompt.ts` (shared), `.agents/skills/label-identity/SKILL.md`, migration `0100`. All typechecks + new tests pass (mobile 7, api 14); 3 pre-existing openssl signing-test failures are unrelated.

**Post-review hardening (multi-agent /code-review, all 8 findings fixed):** label pass moved OUT of runPhotoScan into the callers (runs after GPS remainder ships, fire-and-forget foreground / awaited-last background) — fixes UI stall + gates to `result.labelEligible` (resumeAfter==null) so resumed backfill windows never label stale years-old photos; background gets a smaller 15s time budget; `PHOTOS_IDENTITY_INFERRED` now carries a `source: 'venue'|'label'` discriminator (was double-firing conflated); background `storedPoints` no longer folds label counts; label digest quantizes confidence to 2dp; feedback-profile provenance splits out `label_pattern`; shared `buildHdsReference` extracted.

**How to apply / remaining before "done":**
- **Native rebuild required** — MLKit is dark until a new EAS build + store submission; OTA can't enable it. Validate on a physical device.
- `label-identity` SKILL is a runtime-software artifact → publish to fleet via the publish-skills path (see [[project_eng1055_capability_skill_paved_path]]).
- Migration must run through CI before API deploy (additive `ALTER TYPE ADD VALUE`, backward-compatible). [[feedback_no_manual_migrations]]
- Server phases (ingest + extract) are dark until the device ships `photo_labels`, so testable via the raw-signals seed sandbox first.
