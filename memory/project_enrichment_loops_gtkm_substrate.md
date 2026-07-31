---
name: project_enrichment_loops_gtkm_substrate
description: Enrichment runs as per-signal-family batched LOOPS (most-recent-N-unprocessed → enrich → repeat) producing substrate GTKM consumes as identity signals.
metadata: 
  node_type: memory
  type: project
  originSessionId: 8b3a496c-bd42-4eb7-934b-b9020d7b1621
---

Michael's enrichment architecture (2026-07-31): enrichment tasks are **LOOPS**, not one-shot
processes. Each loop's instruction = **"find the most-recent N raw signals of my type that
haven't been processed yet, process them,"** then repeat — batched + self-perpetuating (rides
the loops-cadence lane [[project_loops_cadence_lane]] + the agent_tasks consumer, INN-231).

The enrichment output is **SUBSTRATE data** that the **GTKM (Get-To-Know-Me) loop consumes and
interprets as IDENTITY SIGNALS.** Enrichment ≠ identity mapping — enrichment produces substrate,
GTKM maps substrate → the individual's identity.

Each signal family runs as its **own** enrichment loop:
- **photo GPS + MLKit labels** — the first instance being built (ENG-1418/1420 on agent_tasks; [[project_photo_gps_enrichment_loop]])
- **dwell-location GPS**
- **web activity** ([[project_web_activity_enrichment]])
- **web-search content** (eventually)

So photo_gps is the **first instance of a reusable enrichment-loop pattern**, not a one-off — the
build should be scoped as such. The key interface is the **substrate→GTKM contract** (likely the
identity_signal_suggestions / draft queue — see [[project_signal_review_queues]]). Generalized-pattern
plan delegated to Sam (wt2) for Michael's review before building beyond photo_gps.
