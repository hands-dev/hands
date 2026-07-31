---
name: Cycle 16 plan (May 18–25, 2026)
description: Engineering cycle 16 plan — two mobile releases to both app stores. Release A (early week) = Privacy settings + Connections. Release B (late week) = MCP/CLI re-integration + branded docs (+ in-app chat stretch). Michael owns Connections UI + shipping; Santiago owns Privacy in-app + MCP/CLI + docs.
type: project
originSessionId: 3cf020b4-b399-4d2e-b685-3f70fbe3090f
---
**Plan file**: `.claude/plans/yeah-let-s-go-into-woolly-micali.md` (full detail).

**Cycle dates**: 2026-05-18 → 2026-05-25 (Linear cycle 16, Engineering team).

**Top-line outcome**: Two mobile releases to App Store + Play Store this week, each a coherent slice of identity-product value.

- **Release A** (Mon–Wed): Privacy settings (Santiago) + Connections (Michael) — polished mobile UI end-to-end.
- **Release B** (Thu–Fri): MCP `connections_read` re-enabled + CLI `and connections list` parity + branded MCP/CLI docs (Santiago). Optional: in-app identity chat (Michael, stretch only if 1–3 track by Wed).

**Primary focus split**:
- **Michael** — Connections UI (un-stub row tap, get `feature/mobile-header-footer-layout` mergeable, profile nav) + shipping both releases + stretch chat if time appears.
- **Santiago** — Privacy in-app UI polish + visibility chips + cross-surface verification + MCP/CLI re-enable + branded docs (`apps/docs` + `apps/web/src/app/(marketing)/mcp/*`).

**Explicitly held back this cycle**: MCP `andee_read` and CLI `and andee read` stay disabled. Open privacy question — an LLM client reading connection-only signals about a third-party andee, where that third party never consented to that LLM environment knowing about them. File a tracking ticket for the product decision; don't ship the surface this cycle.

**Encryption-strategy stream is NOT in this cycle plan**. Kevin's `ENG-682` spike continues separately but isn't a cycle deliverable.

**Carryover that rides along** (none gate the releases): `ENG-774` (OTP 500s, in-branch — ship with Release A), `ENG-769` (signals/write off request path), `ENG-759` (Mixpanel dashboards — needs to be live before Release A gate), `ENG-758` (`GITHUB_SHA` super-prop), `ENG-721` (mobile source maps), `ENG-698` (cleanup scheduler — ship so Stream 1c policy claim is honest). Recommend reassign these out of cycle 16: `ENG-703`, `ENG-709`, `ENG-772`, `ENG-751`, `ENG-639`.

**How to apply**: when working on cycle 16 work, reference the plan file for stream sequencing, file paths, and verification. The first gating task is fixing the Metro/Expo dev-client boot on `feature/mobile-header-footer-layout` (suspected Expo SDK 55 sub-package drift). Without that, no Release A.
