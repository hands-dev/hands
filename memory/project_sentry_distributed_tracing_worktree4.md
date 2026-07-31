---
name: project_sentry_distributed_tracing_worktree4
description: Sentry distributed tracing being wired in worktree-4 — the telemetry surface for fleet-host chat-ready latency
metadata: 
  node_type: memory
  type: project
  originSessionId: ad684e25-6e85-49ce-840c-0a4bb2bd6996
---

Sentry **distributed tracing** is being wired up in **worktree-4** (as of 2026-07-29). It is the intended measurement surface for latency telemetry going forward.

**Why:** It supersedes adding ad-hoc per-metric `Sentry.metrics.distribution` calls for cross-service latency. For the fleet-host chat-ready work ([[project_eng1384_fleet_chat_open_attach]] / the assign→claim long-poll + OpenClaw probe-cache implementation on branch `investigate/fleet-host-assign-timing`), do NOT add a bespoke `open→connected` latency metric — a trace span around the `/v1/fleet/hosts/claim` long-poll and the `chat.open → connectionState:connected` transition will give the real assigned→claimed / warm-host numbers once tracing lands.

**How to apply:** When measuring the fleet-chat latency delta (projected warm-host ~15-60s → ~3-6s), use the worktree-4 distributed tracing once merged rather than wiring a standalone metric. Existing per-op series like `checkout.operation_latency` stay; tracing adds the end-to-end view they can't.
