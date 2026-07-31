---
name: project_enrichment_lane_consumer_deferred
description: "Why agent_tasks location_enrichment/photo_enrichment never drain on staging — consumer deferred + no host attests the `location` capability"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9bffabc8-0525-43ea-a80c-f88f20253683
---

The `agent_tasks` enrichment lanes (`location_enrichment`, `photo_enrichment`) have a shipped PRODUCER but no working CONSUMER on staging, so they never drain. Diagnosed 2026-07-31 (task-queue stability, gates priority #3).

- **Lane shape:** it's a fungible FLEET-HOST lane — matchmaker (`apps/api/src/services/task-matchmaker.ts`) assigns a `queued` task to a ready host, host claims via `POST /v1/fleet/hosts/claim` (`agent-tasks.ts` `claimAssignedTaskAndBindRuntime`). Same path as `chat_bridge`. NOT a dedicated-runtime or server-cron-executed lane. (Distinct from the `heavy_work_orders` queue / `HeavyWorkKind='photo_location_enrichment'`, which is a different table/system.)
- **Two independent reasons it can't drain:** (1) the fleet-host CONSUMER for enrichment task types is a **deliberate follow-up** — in-code comment `apps/api/src/routes/raw-signals.ts:1221-1222`; (2) assignment requires a host attesting the **`location` capability** (`task-registry.ts:179` `requiredCapability:'location'`), and **no staging host attests it** (capabilities only populate under `capabilityAttestation='measured-v1'`) → matchmaker returns `no_eligible`, task stays `queued` with `epoch=0` (never assigned).
- **Evidence:** `location_enrichment` has NEVER completed on staging (all-time only cancelled/queued, back to 07-24); `photo_enrichment` same. So it is NOT a symptom of the [[project_incident_runtime_poison_birth_wedge]]-style #2347 dead-on-boot outage, and does NOT self-heal when hosts recover.
- **INN-240 is not the blocker:** enrichment is non-interactive (SLA 120 > 5) so it skips the enqueue→assign NOTIFY fast-path by design; the [[project_inn240_notify_wake_dead_cloudrun]] assign→claim LISTEN only matters after an assignment exists.
- **#3 precondition list:** ship the deferred enrichment consumer; provision+attest `location`/`photo` capability on a ready host; then INN-240 wake for latency. Queue mechanics are otherwise healthy (no orphaned lease-expired in-flight tasks). Related: [[project_enrichment_loops_gtkm_substrate]], [[project_photo_gps_enrichment_loop]], [[reference_fleet_host_capability_provisioning]].
