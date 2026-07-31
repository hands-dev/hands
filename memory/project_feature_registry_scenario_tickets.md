---
name: project_feature_registry_scenario_tickets
description: Admin feature registry ties Linear tickets to scenarios two ways (declared @eng-tickets + resolved-by-PR-provenance); GITHUB_TOKEN needs a TF apply
metadata: 
  node_type: memory
  type: project
  originSessionId: 87af972b-55eb-4a10-9553-a45ad075498d
---

The admin **feature registry** drill-down (`apps/admin/src/app/(admin)/tools/feature-registry/[slug]`) ties Linear tickets to individual Gherkin scenarios two distinct ways. Scenarios + tickets come from the Linear project (Feature Catalog initiative); the rung is recomputed live against GitHub `main`.

**Two mechanisms (keep them distinct):**
- **Declared** (`@eng-tickets(ENG-1, ENG-2)` tag on a scenario, ENG-1210): an *explicit, directional association* — NOT a status. The ticket's real state (Done/In Progress/…) is derived from Linear and shown per-ticket. Parsed in `packages/maturity-eval/src/gherkin.ts` → `ScenarioSpec.engTickets`.
- **Resolved by** (ENG-1213, PR provenance): the ticket that *delivered* a verified scenario, derived from its `@covers` test. Chain in `apps/admin/src/lib/github.ts` `resolveTicketProvenance(path)`: `commits?path=` (oldest via `Link rel="last"`) → `commits/{sha}/pulls` → feature PR → `/(ENG|INN)-\d+/i` on `head.ref`→title→body; **fallback** when `/pulls` returns only a `main <- staging` promotion PR (`head.ref==='staging'`) → parse the commit message. `unstable_cache` 1h.

Reconciliation (`computeScenarioTickets` in `feature-detail.ts`, pure + tested): a ticket that's both declared and resolved shows once, under Resolved. Off-project referenced ids are enriched via one batched Linear `issues(filter:{or:[…]})` call in `feature-detail-live.ts` (`fetchTicketsByIdentifier`), so declared/resolved cards show status+assignee even when not on the project. `EnrichedTicket.linkedToProject` is just an "off-project" flag, not a reason to hide data.

**GITHUB_TOKEN provisioning (bit us this cycle):** the registry needs a repo-read `GITHUB_TOKEN` to verify `@covers` + walk provenance. In deployed envs it's TF-managed: `ADMIN_GITHUB_READ_TOKEN` (GitHub **environment** secret, staging+production) → `TF_VAR_github_read_token` → Secret Manager `github-read-token` → admin Cloud Run env (`apps/infra/environments/*/main.tf`, conditional on the var being non-empty). It only lands after a **Terraform apply** AND a **fresh admin revision** — a normal deploy skips TF unless infra changed, so force it: `gh workflow run staging-deploy-orchestrator.yml --ref staging -f force_terraform=true`. Don't also `-f force_admin=true` at the same SHA — the admin canary revision name is `canary-<sha8>` and collides. **Staging is provisioned (2026-07-08); PROD still needs its own TF apply.**

Related: [[project_eng1204_feature_maturity]] · list-query 400 fix was ENG-1212 (`projects(first:25)` not 100 — Linear complexity = product of nested connection page sizes).
