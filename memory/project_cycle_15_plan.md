---
name: Cycle 15 plan (May 11–18, 2026) — Pollination
description: Engineering cycle 15 plan — top priority is monitoring app-store reviews + a hotfix lane; streams cover install funnel, observability, privacy (Santiago) + connections (Michael), CLI/marketing/dev-docs branding. Full plan at .claude/plans/let-s-make-a-plan-replicated-stream.md.
type: project
originSessionId: 0d84edd6-45af-4624-bfcc-f5bcc8ec5357
---
**Plan file**: `.claude/plans/let-s-make-a-plan-replicated-stream.md` (full detail there).
**Notion doc**: `🌸 Cycle 15: Pollination` — https://www.notion.so/35d51f455bba8167818ae4493f35eb24

**Cycle dates**: 2026-05-11 → 2026-05-18 (Linear cycle 15, Engineering team).

**Top priority**: Apps are awaiting Apple + Google review. Monitor daily, respond fast, keep a hotfix lane ready cut from a clean main. The moment a store approves, ENG-701 (redirect routes) → ENG-702 (welcome email CTAs) → ENG-703 (claim confirmation CTAs) ship same-day.

**Streams**:
1. **Install funnel** (Michael) — ENG-701/702/703, pre-staged with placeholder URLs.
2. **Observability** (Michael) — ENG-681 (Sentry + Mixpanel across mobile/API/MCP), ENG-700 (mobile event audit).
3. **Privacy + connections** — ownership change: Santiago picks up privacy (ENG-669 reassigned 2026-05-11) to broaden controller-app ownership; Michael owns connections follow-on (Sentry/Mixpanel triage of cycle-14 flows + sized next-layer backlog).
4. **CLI + marketing + dev-docs branding** — ENG-643 (Santiago), ENG-640 (Santiago), new **ENG-710** "Brand-align developer docs site (apps/docs) + move to docs.and.com" (Michael, filed 2026-05-11).

**Deferred to cycle 16**: ENG-682 (encryption-at-rest spike), ENG-709 (Twilio SMS-pumping defense), ENG-698 (OTP cleanup scheduler).

**Why**: Cycle 14 submitted to both stores (ENG-647 closed 2026-05-05). Public availability is the gate; until both stores approve, every other distribution lever is hypothetical. Funnel work compounds for the rest of the platform's life. Observability is leverage for every future cycle. Distributed ownership reduces single points of failure.

**How to apply**: when working on cycle 15 work, reference the plan file for sequencing, file paths, and verification approach. The reassignment of ENG-669 to Santiago is intentional — do not reassign back to Michael without checking. The new ENG-710 dev-docs branding ticket couples loosely with ENG-640; coordinate visual decisions.
