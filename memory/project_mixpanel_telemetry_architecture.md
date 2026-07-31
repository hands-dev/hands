---
name: Mixpanel telemetry architecture
description: Decisions for Mixpanel project split, event de-dup, and cross-surface event consistency
type: project
originSessionId: 9500282d-a87b-4393-bf80-9ab647a04561
---
Work on branch `feature/mixpanel-sentry-insights-dashboard` (cut off staging 2026-05-19). Business insights live natively in Mixpanel (not re-created in admin app); Sentry keeps its own dashboards ("two homes").

**Project decision (2026-05-19, final):** ONE Mixpanel project — "Ampersand" (3993101) — holds all apps (web + mobile + api + mcp + cli). It is production-only: Mixpanel must NOT fire in non-prod environments at all (no staging project). Enforced two ways: (1) Mixpanel token env var only set in production deploys; (2) code guard in the analytics wrappers — `initClient/initServer/initMobile` no-op unless `environment === 'production'`. Platform/surface distinguished by the `surface` super-property. Retire the platform-split "and-mobile-production" project (4021923) and re-point the mobile token to 3993101. (Earlier env-split-into-two-projects idea was dropped: Mixpanel has no first-class environment primitive like Sentry, and not firing in non-prod removes the pollution concern entirely.)

**Event de-dup state:** Codebase is 100% clean `dot.case` (canonical source `packages/analytics/src/events.ts`, 41 events, type-safe). Legacy `Title Case` events in the Ampersand project are dead historical data (web cut over ~May 11 2026) — hide them. Mobile `snake_case` events (`claim_tag`, `login`, `add_signals`, `connect_mcp`, `tab_view`, `edit_account`) were still firing but mobile has no real users — abandon/drop them; the `dot.case` mobile build had not shipped to stores.

**Status (2026-05-19):** Code work merged to staging via PR #1433 (cross-surface taxonomy + prod-only guard, claim/onboarding funnel parity, `tag.claimed` double-count fix, web hero `tag.claimed` emit). The 11 legacy Title Case events in project 3993101 are dropped+hidden. The `MIXPANEL_TOKEN_PRODUCTION` EAS secret (production environment) was re-pointed to the Ampersand project 3993101 on 2026-05-19 — takes effect on the next production mobile build. STILL OUTSTANDING — retire the `and-mobile-production` project 4021923 (Mixpanel UI; no MCP tool for it). Follow-up tickets: ENG-802 (mobile welcome email), ENG-803 (consolidate web+mobile tag-claim flows onto one backend). Task 5 done — 3 native Mixpanel boards built in project 3993101: "Acquisition & Claim Funnel" (id 11207955), "Auth & SMS Deliverability" (id 11207957), "Growth & Cross-Surface Overview" (id 11207961). Plan at `.claude/plans/joyful-puzzling-rain.md`. Deferred future boards: Engagement/Retention/Cohorts, Invitations & Virality, Account lifecycle/churn — build once volume grows.

**Welcome email gap:** Mobile signups (API `POST /register`) send no welcome email and never emit `email.welcome_sent` — web does both. Tracked as ENG-802 (cycle 16, Michael).

**Cross-surface consistency goal:** Shared actions must fire the SAME canonical event on every surface (web, mobile, CLI, MCP, future). Example: "viewing another andee" happens on web (`and.com/&foo.bar`), mobile search, CLI, MCP. Use standard super-properties to slice: `surface`, `platform`/os, `environment`, `app_version`. Scope being aligned first: claim/onboarding/email funnel.
