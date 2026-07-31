---
name: project_photo_gps_enrichment_loop
description: "Photo-GPS enrichment loop initiative — batched + profiled; ENG-1418 umbrella, Phase-2 profiling PR open."
metadata: 
  node_type: memory
  type: project
  originSessionId: a45d0fa5-735b-455c-bf0f-295134fdd2b5
---

Photo-GPS enrichment loop: turn the cron-poked one-shot enrichment into a batched, profiled loop. Umbrella **ENG-1418** (cycle 26), children:

- **ENG-1419 Phase 2 — duration profiling.** Added `enrichment.*` span vocab (`EnrichmentSpanName` + `enrichmentSpanOp()`) in `apps/api/src/lib/observability.ts` next to the [[project_host_span_beats_tracing]] host-span shape; wraps live one-shot photo_gps path in `raw-signal-extractor.ts` (parent `enrichment.extract` → cluster/resolve/place_pass) + `venue-resolution.ts` (per-spot `places_lookup`/`venue_pick`). **PR #2356 MERGED to staging 07-30** — live. Independent of batching + the flag; instruments the device-kicked path.
- **ENG-1420 Phase 1 — batching: heavy_work lane is the WRONG lane (07-31 finding).** heavy_work is being RETIRED into agent_tasks — INN-220 (P0, In Progress) "retire heavy_work into it" + INN-219 one-work-queue. Enrichment's real home is **INN-231** (Todo): a FLEET-HOST consumer (checkout_executor.py claims photo_enrichment/location_enrichment agent_tasks like chat_bridge; hybrid = server bounded-drain reusing drainRawSignalExtraction + agent-in-harness draft turn; checkpoint via kv item; materiality-gated loop_advance re-trigger). Producer already exists (task types + /enrichment-pass enqueue, PR #2314). INN-231 step 6 explicitly retires triggerEnrichmentAgentPass + HEAVY_WORK_ENRICHMENT_ENABLED — the exact lane ENG-1420 targeted. I built the heavy_work handler+runner (green, wt2/eng-1420, UNPUSHED) then found this → recommended ABANDON, repoint ENG-1420 under INN-231. Phase-2 profiling (#2356) stays valid (profiles the drain INN-231 reuses). Original (now-superseded) framing:
- ~~**ENG-1420 Phase 1 — batching** on the `photo_location_enrichment` heavy-work lane.~~ RESUMED 07-30 (priority #2 un-held once chat latency solved). Refreshed-plan finding: it's THREE pieces, not just a batch loop — (A) enqueue is WIRED (`triggerEnrichmentAgentPass` at raw-signal-extractor.ts:733, gated by `HEAVY_WORK_ENRICHMENT_ENABLED`, dark) but (B) NO enrichment HANDLER/adapter registered (adapters only in tests) and (C) `runNextHeavyWorkAttempt` is invoked NOWHERE in prod (tests only) — so enqueued orders sit unclaimed. Phase-1 must add the ResidentHeavyWorkAdapter batch-loop handler (align batch to DRAIN_BATCH=20, drop the 5-cap, checkpoint per batch) + a runner drainer (piggyback the drain-all internal cron, which already runs heavy-work retention). Depends on ENG-1419 (done). Not built.
- **Phase 3 — enablement** (cron-trigger on backlog + staging flag): NOT ticketed solo — folds into wt3's map (`internal.ts` drain-all cron piggyback + `perpetuateLoopCadence` dedupe key). Coordinate with wt3.

Dropped: `signals:raw_read` staging-scope "blocker" — wt3 proved it granted cohort-wide (11/11). Not a blocker.

Related: runtime timing-emission (firstTokenMs/totalMs + real executionBeats in runTerminal, bus task #8) folds into the [[project_host_span_beats_tracing]] eng-1389 runtime change — one runtime change + one fleet-template roll lights up both the flat `runtime.channel_turn_latency` metric AND the per-turn trace. Keep in-house (not Santiago); no template roll without Michael's explicit cohort go. See [[project_raw_signal_zero_prod_throughput]], [[project_venue_lens_enrichment_skill]].
