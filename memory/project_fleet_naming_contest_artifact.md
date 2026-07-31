---
name: project_fleet_naming_contest_artifact
description: "Fleet-host naming contest — claude.ai artifact (RCV voting) backed by shared Notion databases; URL, DB ids, passcode, and how it works."
metadata: 
  node_type: memory
  type: project
  originSessionId: e5a5dd89-b2bd-4ef3-ad05-3af94c807a0b
---

Built 2026-07-30 for the week-of-Aug-17 on-site contest (Slack C68P1NZML): team submits 3
fleet-host naming-theme ideas, votes ranked-choice (instant-runoff) at the on-site, winner's
author gets a prize. Authors hidden on the ballot; no running tally shown to voters.

- **Artifact URL (canonical, team-shareable):** https://claude.ai/code/artifact/17c2a0cc-e7c6-4f04-9d88-cdfff764e8b0
  — source `fleet-naming-contest-org.html`; republish THAT path to keep this URL.
  **Sharing lesson:** a capability (connector) artifact can't be public-linked; it's shareable only if
  published from a Claude Code session bound to a **Team/Enterprise workspace** (The & Company). Personal-space
  copies (old URLs `0580f4c5…`, `6489b05d…`, `fleet-naming-contest.html`/`-team.html`) only offer "Only you" —
  delete them. Switching the claude.ai WEB login isn't enough; the publishing session must be org-bound
  (here: user re-authed Claude Code under The & Company, reconnected Notion via `/mcp`, then a fresh publish
  landed in the org workspace and exposed team sharing).
- **Store = Notion** (switched from Google Drive — Drive connector has no append/update, forcing an
  ugly one-file-per-record hack; Notion gives one readable table + real `update-page` edits).
  Parent page **"Fleet Naming Contest"** (`3ad51f45-5bba-81bf-81d0-ed2634a970f8`) with two DBs:
  - Fleet Ideas data source `ccb48a9a-7b91-4897-b6ac-e8cac82e6712` (Theme·Description·Samples·Author·Scales50·Ts)
  - Fleet Ballots data source `21969e44-3110-4c49-89e8-6cb153c81a38` (Voter·Ranking·Ts)
  Michael must **share the parent page (full access) with the team** so their connectors can read/write.
- **Admin passcode** (Results reveal gate): `fleet-reveal-2026` (client-side; change in source + republish to rotate).
- **Candidate identity = Notion page id.** Editing an idea reuses its page id → `update-page` (no dup);
  new ideas → `create-pages`. Ranking = comma-joined page ids.
- **Author is stored obfuscated**: `Author` = base64(JSON `{t:"&tag", k:"<notion user id>"}`). `t` = display
  tag (shown only at reveal), `k` = owner identity used for prefill. Obfuscation only (reversible).
- **Refresh-prefill uses connector identity, NOT localStorage** (localStorage is blocked in the sandboxed
  artifact iframe). On load the page calls `notion-fetch {id:"self"}` → `payload.self.user.id`, then
  loads ideas whose owner `k` matches. Only ideas submitted with this scheme prefill.
- **Notion FREE-PLAN query cap**: `query_data_sources` is rate-limited ("upgrade_required" in self-report;
  we hit "reached usage limit" during testing — resets periodically). Writes (create/update) are NOT capped.
  Mitigation shipped: per-session ideas cache (coalesce reads, invalidate on write) + voting is write-only
  (ballots dedup at tally, not via a pre-query). Owner can upgrade to Business for unlimited querying.
- Ballots dedup per voter at TALLY time (latest Ts wins); re-votes leave extra rows (harmless).
- Manifest capability: `{server:"claude_ai_Notion", tools:["notion-create-pages","notion-query-data-sources","notion-update-page","notion-fetch"]}`.
  Runtime resolves server via `listTools()` → "Notion". Checkbox values `__YES__`/`__NO__`; query via
  SQL `SELECT * FROM "collection://<id>"`; row `id` = page id.
- Four tabs: Rules/lore · Submit (edit-prefill by &tag on author blur; localStorage boot-prefill is
  a no-op in the sandboxed artifact iframe) · Vote (shuffled, no author/tally) · Results (passcode → IRV rounds + author reveal).

**Verified end-to-end live in-browser (2026-07-30):** create, update-in-place (no duplicate row),
query-by-author prefill, anonymized shuffled vote load, ballot writes, passcode gate, IRV runoff with
redistribution, winner + author reveal. Notion consent dialog only accepts a REAL human click (browser
automation clicks are rejected) — hand that step to the user.

**Constraints:** capability-declaring artifacts can't be public-linked — share to the workspace only.
Author/tally hiding is UI-level (honor system). **Test data left in the DBs** (&michael's 3 ideas +
2 ballots from &dan/&lesa) — clear the rows in Notion before the real contest opens.
