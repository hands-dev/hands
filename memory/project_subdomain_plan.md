---
name: Subdomain standardization plan
description: Plan to standardize subdomains to {app}.{env}.and.com format, rename admin domain, and scope cookies per environment
type: project
---

Subdomain standardization plan saved as gist: https://gist.github.com/and-michael/954b347731dff924df31a1a4e27d5fa7

**Why:** Staging subdomains are inconsistent (3 different patterns), production admin uses `vip-admin` instead of `admin`, and session cookies on `.and.com` leak across all environments.

**How to apply:** When picking this up, the plan covers DNS (Cloudflare manual), GCP domain mappings (gcloud CLI), Terraform tfvars, app code (runtime-env.ts, admin-url.ts, layout.tsx), CI workflows, and test files. 13 files total. Preview environment is already correct — staging and production admin need changes.
