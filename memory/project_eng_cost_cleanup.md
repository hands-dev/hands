---
name: Engineering Cost & Operations Cleanup Initiative
description: Linear initiative tracking engineering cost optimization across 9 pillars — repos, services, security, accounts, costs, subscriptions, observability, CI/CD, and data governance
type: project
---

Engineering Cost & Operations Cleanup initiative created 2026-04-13.

**Why:** Michael (Director of Engineering) wants to inventory all engineering costs, ensure only needed services are paid for, rotate keys regularly, and make cost centers easy to measure.

**How to apply:** When working on infrastructure, deployments, or service integrations, check if changes align with or conflict with this initiative's goals.

## Linear Structure

- **Initiative:** "Engineering Cost & Operations Cleanup" (Active, owned by Michael)
- **9 Projects** (one per pillar), each containing 3-4 issues
- **31 total issues:** ENG-513 through ENG-543

## Pillars & Projects

1. Repo Cleanup (ENG-513 to ENG-516)
2. Data/Service/Storage Cleanup (ENG-517 to ENG-520)
3. Key Rotation & Security (ENG-521 to ENG-524) — Urgent priority
4. Account Management (ENG-525 to ENG-527)
5. Cost Reduction (ENG-528 to ENG-531)
6. Subscription Maintenance (ENG-532 to ENG-534)
7. Observability & Monitoring Costs (ENG-535 to ENG-537)
8. CI/CD Efficiency (ENG-538 to ENG-540)
9. Data Governance & Compliance (ENG-541 to ENG-543)

## Source Data

- `cost-inventory.csv` — org-wide scan of all 39 repos (generated 2026-04-13 by `scripts/scan-org-costs.sh`)
- Scanning script at `scripts/scan-org-costs.sh`
