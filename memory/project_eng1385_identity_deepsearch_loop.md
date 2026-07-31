---
name: project_eng1385_identity_deepsearch_loop
description: "ENG-1385 backlog design — evolve onboarding web search into a maturing \"public footprint\" loop"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5d552c2f-29d0-4c23-9367-980793289b5c
---

**ENG-1385** (Backlog, Engineering, assigned Michael) — design captured 2026-07-29, not scheduled. Evolve onboarding web search (the "Be You" self-discovery flow) from today's **single-shot, non-agentic** server function into a **dedicated, maturing loop** ("The you the internet knows") whose **first turn is the onboarding birth**.

Decisions/thoughts locked in the ticket:
- **Separate loop**, NOT a web rail on Get to Know Me (Michael's call).
- Birth = fast + non-blocking; deep agentic Exa fan-out = a later (wider) turn — dissolves the blocking-onboarding tension.
- **Core new design = graded identity confidence** (high/medium/low) that sharpens via andee confirm/reject feedback → the multi-hop mis-identification risk becomes the maturation mechanism.
- Three pillars already map to loop primitives: `confidence`+`groundingRefs` on items, the novelty gate + `run_outcome honest_no_write` ("stop short of things you already have"), birth-vs-wider-pass = maturing.
- **Only net-new primitive** = expose Exa as a runtime *tool* via the tool gateway ([[project_runtime_web_rag_capability]]); turns otherwise ride the existing `loop_advance` task lane. Dormant GTKM skill hook ("web grounding only when session exposes a web-search capability") is waiting on this.
- Storage: stop discarding `sources[]`; handles/links → HDS `0.5.1 Profiles & Links` (public) / `6.6 Social Media`; papers/posts → loop items w/ grounding refs.

Current-state anchors: `apps/api/src/lib/identity-discovery.ts:135` (single search), `web-search/{provider,exa}.ts`, `.agents/skills/interview-self-discovery/SKILL.md`, `routes/identity-discovery.ts:102` (drops sources). Companion artifact walkthrough linked on the ticket. Lineage: ENG-887/1000/973/978.
