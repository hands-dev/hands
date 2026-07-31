---
name: feedback_deploy_canary_not_live
description: "A green 'Deploy X → success' in the staging/prod orchestrator ≠ live: admin/api/web ship a `--no-traffic --tag=canary` revision first; traffic only moves after a separate smoke-gated Promote job — confirm via the Promote job / Cloud Run traffic split, not the Deploy job"
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-30
  written: 2026-07-30
  originSessionId: 395e5225-705d-42dc-af52-43fbdbd2be16
---

A green **Deploy** job (`Deploy Admin App → success`, api, web) only means the
canary revision is **up and healthy at 0% traffic** — it does NOT mean the change is
live. These deploys ship `--no-traffic --tag=canary` first; live traffic migrates
only in a **separate Promote / traffic-migration job gated on smoke tests**.

- To confirm a change actually reached users, check the **Promote job** conclusion
  (or the Cloud Run traffic split), not the Deploy job.
- The summary line to look for reads like `Traffic: 0% (canary — promotes after
  smoke tests)`.
- A re-run of a Deploy on the same commit is just another 0%-traffic canary and
  can't affect serving traffic (and may 409 on a conflicting canary revision name).

**Why:** cost real back-and-forth — user kept saying "still not seeing it" while the
Deploy was green but un-promoted.
**How to apply:** verify the Promote/traffic step (or Cloud Run split), never treat
a green Deploy as live.
