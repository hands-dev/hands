---
name: feedback_deprecate_old_paths
description: Prefer one active code path — deprecate/delete old paths as you ship; breaking old paths is fine if prod data is protected
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75c1ef98-55db-45b5-b395-60873fc0a91a
---

When implementing features, actively identify and remove old code paths that
are no longer used. The team ships features very fast, so the goal is to keep
**exactly one active path** rather than letting parallel/legacy implementations
accumulate.

**Why:** Multiple live paths for the same job is the dominant source of context
rot and 401-class bugs here (e.g. the route-owns-auth allowlist drift in
ENG-977/ENG-1026). One path = less to keep in sync.

**How to apply:**
- When migrating from implementation A to B, fully retire A in the same effort
  (delete the route/lib/component, drop dead config, remove stale flags) — don't
  leave A dangling "just in case."
- Breaking the old path is acceptable: there are **no real production users**.
  The only hard constraint is **prod data must be protected** (no destructive
  migrations, no data loss; raw_signals/identity data stays intact).
- Call out deprecation opportunities proactively even when not explicitly asked,
  and fold the deletion into the PR that supersedes the path.

Relates to [[feedback_done_means_merged]] and the ENG-1028 auth-gate-refactor
goal (rip out the legacy blanket `/v1/*` gate + allowlist entirely).
