---
name: project_chat_cold_reattach_latency
description: Root cause of the ~55s staging chat pickup latency (cold re-attach) and the two-track fix (ENG-1422)
metadata: 
  node_type: memory
  type: project
  originSessionId: be3fb886-aa9a-4343-9802-c2e557add6b7
---

The ~55s "slow chat" on staging (warm host, andee returns after idle) is a **cold re-attach**, NOT strand/attach/NOTIFY/generation. Root-caused 2026-07-30/31 with REAL Sentry data → **ENG-1422** (full analysis + line refs).

- **In-house:** the fleet-host runner `apps/infra/modules/openclaw-fleet-host/runner/checkout_executor.py` owns the rc-turn claim loop + drives OpenClaw via a local gateway (`127.0.0.1:18790`). NOT the OpenClaw `ocr-` image, NOT the agentkit `and` CLI.
- **INN-238** (Michael, 07-30) made `chat_bridge` completion **per-turn** ("checkout never held"), retiring **INN-215**'s idle-hold — because a held task re-assigned on every quarantine (epoch++) → unbounded VM-churn loop. So reverting to a hold (option a) reopens that. On idle → host finalizes+detaches → next msg re-enqueues a fresh `chat_bridge` → full cold re-attach.
- **REAL Sentry ENG-1389 host-beat p50s (org and-com / project ampersand-api / staging):** `host.exchange` 0.18s · `host.prepare_checkout` (workspace HYDRATE) **0.38s — NEGLIGIBLE** · `host.engine_setup` **~54s = the whole cost**. Michael's "hydrate is big" hypothesis is WRONG; hydrate is a rounding error.
- **The ~54s = ~3–4 serial `openclaw` CLI cold-starts** (`_run_engine_setup`: `openclaw onboard` + `openclaw models set` + `mint_mcp_session` + ~13–17s model preflight), each paying ~13–17s CLI startup. NOT gateway boot (gateway is a persistent systemd service `ampersand-fleet-openclaw-gateway.service` + shared engine home; only the per-checkout engine home is wiped).
- **Two-track fix (ENG-1422):** **Track 1 (immediate, pure in-house, no dep)** — cut the 3–4 CLI cold-starts in checkout_executor.py: (A) collapse onboard+models-set into fewer invocations, (B) persist/extend per-host preflight cache, (C) run onboard+preflight concurrently. **Track 2 (structural end-state)** — warm-affinity: INN-185 (host stops wiping substrate) + `FLEET_WARM_ALLOCATOR_ENABLED` warm-bind routing + a runner change to SKIP onboard/models-set/preflight when re-attaching a warm engine home for the same andee. **INN-185 alone is necessary-but-NOT-sufficient** (saves only the 0.4s hydrate). See [[project_warm_allocator_deferred_tasks]].
- Ruled out: `NO_WORK_BACKOFF_SECONDS=(2,4,8,16,30)` is the UNASSIGNED-host checkout-claim storm-prevention, NOT this. Chat turns bounce across hosts (no affinity today; warm-allocator flag OFF).
- Observability: fixed as of the real-data pull, but note `first_token_ms`/`total_ms` still NULL in `runtime_channel_messages` (wt5 ENG-1421); `host.engine_setup` is a leaf beat (can't split MCP-vs-onboard-vs-preflight from tracing — a further instrumentation ask).
