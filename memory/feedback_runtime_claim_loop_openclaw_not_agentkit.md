---
name: feedback_runtime_claim_loop_openclaw_not_agentkit
description: "The runtime turn-claim / agent loop is OpenClaw-owned, NOT agentkit/Santiago — agentkit owns only the `and` CLI surface (per docs/runtime-tool-gateway.md); verify ownership before naming an owner"
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-31
  sourceBranch: feature/eng-1064
  written: 2026-07-31
  originSessionId: 006d5cd8-7dee-4ec2-9aaf-1cd74e636d71
---

When attributing the fleet **runtime turn-claim loop / agent loop** (the `/hosts/claim` re-poll cycle), it is **OpenClaw-owned**, not agentkit/Santiago. Per `docs/runtime-tool-gateway.md` (~:13/:232), **agentkit owns only the `and` CLI surface** ([[reference_agentkit_cli_repo]] is Santiago's — that part is correct).

The loose "openclaw/agentkit" shorthand in worktree notes has twice led to mis-crediting agentkit for the claim loop.

**Why:** naming the wrong owner in writing (tickets, escalations) sends investigation/ownership to the wrong team.
**How to apply:** verify ownership in the repo (grep the gateway/runtime docs) before naming an owner; the claim loop → OpenClaw, the `and` CLI → agentkit.
