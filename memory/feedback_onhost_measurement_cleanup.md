---
name: feedback_onhost_measurement_cleanup
description: Clean up + CONFIRM after any on-host/staging measurement; fleet-host root disks are tiny (~19GB).
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ac5573a7-dada-4a48-9c98-c3b2b44bc335
---

Foreman standing rule (broadcast 2026-07-31) for any worktree doing on-host or staging measurements — A/B, timeline, sizing, eval-on-truth, marker tests, etc.: anything you WRITE (throwaway engine homes, temp files, marker configs, scratch rows/tables) must be removed immediately after, and the report must CONFIRM cleanup (+ before/after disk state if you copied anything large).

**Why:** Fleet-host root disks are small (~19GB) and a single 1.3GB npm engine home fills them fast; silent leftover state accrues and wedges hosts.

**How to apply:** Read-only inspection (`ls`/`stat`/`cat`, `psql SELECT`) needs no cleanup. If a measurement leaves durable state you can't fully remove, flag it explicitly rather than leaving it silent. Relates to [[reference_staging_fleet_debug]] and [[reference_hosted_runtime_machine_type_cost]].

**Fleet-host perf-measurement technique (validated 2026-07-31, ENG-1425 cold-attach A/B):** SSH `openclaw-rt-staging-fleet-*` (fungible chat hosts) with `CLOUDSDK_PYTHON` pointed at python 3.12/3.14 (the 3.9 Xcode python errors). Pipe a script via `gcloud compute ssh HOST --command='sudo -u and-fleet-runtime bash -s' < script.sh` (avoids nested-quote hell). Make throwaway HOMEs under `/tmp` (`cp -a /var/lib/ampersand-fleet-host/engine /tmp/x`). No-API triggers to avoid burning the OpenAI key: `openclaw plugins list` (clean cold-start proxy) or `openclaw agent --local --model nonexistentprovider/none` (fails at model RESOLUTION *after* plugin-load, isolating startup). Then `rm -rf` the homes + stray `.out` and confirm `df -h /`. Measured numbers: onboard ~67s (full 1.3G codex npm install, NOT ~26-34s), models-set ~12.6s, agent `--local` cold-start ~12.8s — each openclaw CLI invocation pays a ~12-13s node+plugin-scan cold-start that stacks.
