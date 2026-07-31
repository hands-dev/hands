---
name: Use git tags not GitHub Releases for version history
description: This repo uses bare git tags for releases, not GitHub Releases — use `git tag` not `gh release list`
type: feedback
---

Use `git tag --sort=-creatordate` to find the latest release, not `gh release list`. This repo cuts bare git tags (e.g. `v1.5.2`) to trigger production deploys — GitHub Releases are not used.

**Why:** `gh release list` only shows GitHub Releases (metadata attached to tags via the GitHub UI/API). It missed dozens of actual releases and showed `v1.1.0` as latest when `v1.5.1` was the real latest, leading to a wildly inaccurate diff of what would deploy.

**How to apply:** Whenever checking what's deployed, what would deploy, or what the latest version is, always use `git fetch origin --tags && git tag --sort=-creatordate | head -5`.
