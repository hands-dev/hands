---
name: cycle-gate-first-ticket-ref
description: Staging cycle-gate validates the FIRST ENG/INN ref in the PR body; lead with the current-cycle ticket and never rerun the stale gate run
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2a7358cb-75a2-4589-8906-7de1462fcc80
---

The `Validate Linear Cycle Membership` (aka "Staging Cycle Gate") check extracts the ticket with `grep -ioE '(ENG|INN)-[0-9]+' | head -1` — the **first** match anywhere in the PR body. If the body mentions an older/closed ticket before the current-cycle one (e.g. an `ENG-1190` in a "Problem" section above `Closes ENG-1371`), the gate validates the wrong ticket and fails with "not in current cycle."

**How to apply:**
- Make the current-cycle ticket the FIRST `ENG-`/`INN-` reference in the PR body — prepend a `Ref: ENG-XXXX` line at the very top if the body cites other tickets earlier.
- To fix a failed gate: **edit the PR body** (a trivial change like appending `<!-- ci -->` works) to trigger a FRESH gate run. Do NOT `gh run rerun` the old failed run — reruns replay the stale pre-edit body context and fail again, and if that rerun completes last it leaves the check BLOCKED as the "latest" status.

**Why:** wasted ~10 min on PR #2267 (ENG-1371) chasing a false cycle-gate failure caused by an earlier `ENG-1190` mention, then compounded it by rerunning the stale run. See [[feedback_ci_merge_gotchas]], [[feedback_no_auto_merge]].
