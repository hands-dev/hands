---
name: feedback_staging_risk_not_urgent
description: "Staging is not prod — don't fire-drill/halt-a-roll/desktop-ping for staging-only latent or conditional issues; they're normal follow-ups."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8b3a496c-bd42-4eb7-934b-b9020d7b1621
---

Michael (2026-07-31): "Nothing is urgent with staging." Said after I escalated a *staging*
post-merge review finding (a latent, corruption-conditional cross-andee leak via a seeded
`openclaw.json.bak`) into a halt-the-live-reprovision decision + a desktop ping.

**Why:** staging is a test environment. A latent/trigger-gated issue there (needs a rare fault to
fire, isn't actively harming healthy hosts) is a **normal follow-up PR**, not a fire drill. Reserve
halts, reverts, and "needs you" desktop pings for **prod** risk or **actively-firing** staging
breakage.

**How to apply:** on staging, let the roll/merge proceed and route real findings as normal
follow-up work. Calibrate escalation to blast radius × probability × environment: prod or
actively-firing → escalate; staging + latent/conditional → fix it, don't fire-drill it. (Prod
parity fixes still matter before promotion — see the destructive-reprovision gates — just don't
treat a staging latent gap as urgent.) Relates to [[feedback_foreman_reviews_zoomed_out]].
