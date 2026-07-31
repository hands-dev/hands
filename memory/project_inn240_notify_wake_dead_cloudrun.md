---
name: project_inn240_notify_wake_dead_cloudrun
description: INN-240 — INN-227 notify-woken long-poll/fast-path is dead on deployed api-server because Cloud Run cpu-throttling + scale-to-zero kills LISTEN/NOTIFY; fix = cpu_idle=false + min_instances=1
metadata: 
  node_type: memory
  type: project
  originSessionId: b81e25b1-3731-481e-9684-94121d4281d8
---

**INN-240** (filed 2026-07-30, High, branch `feature/inn-240` off staging). Found live-debugging a per-turn `chat_bridge` attach for michael.phillipszz on staging: "connecting to agent" sat ~23s.

**The finding:** [[project_fleet_claim_longpoll_probecache]]'s (INN-227 #2322) notify-woken wake is NON-FUNCTIONAL on the deployed api-server, even though the code shipped to BOTH sides. The long-poll TRANSPORT works (empty `/v1/fleet/hosts/claim` holds a steady 25.03s→204) but the `pg_notify` WAKE never fires — so every assign falls back to the slow batch-sweep backstop.

**How it was proven:**
- Baked runner HAS INN-227 (decoded the host's own `ampersand-startup-script-gzip` metadata → the runner source is embedded base64 in the startup script; it sends `{"waitMs":25000}` + reads `X-Fleet-Long-Polled`). So "never made it to the fleet image" was WRONG.
- Server HAS it (redeployed today; claim route long-polls on `body.waitMs`, no gating flag — `didLongPoll = !claim && waitMs>0`).
- App-log `checkout.claim latencyMs:10` is ONLY the DB probe; the TRUE latency is the Cloud Run **request** log (`httpRequest.latency` = 25.03s). Use the request log, not the app log, to measure long-poll holds.
- Matchmaker fast-path event `orchestrator.assign_on_enqueue` fired **0 times in 45min** → the `task_work_queued` LISTEN never receives.

**Root cause:** both wakes ride `sqlClient.listen()` (postgres.js LISTEN) with an in-process per-instance registry (`apps/api/src/services/task-matchmaker-wakeup.ts` boot-armed at `index.ts:245`; `fleet-host-wakeup.ts` lazy per-waiter). The staging api-server Cloud Run runs `cpu_idle=true` (cpu-throttling) + `minScale=0` + `maxScale=3`. CPU-throttle means the background LISTEN callback can't run once the HTTP response returns; scale-to-zero reaps the instance and drops the LISTEN. So pg_notify reaches no live listener. **Code correct; deploy env is the bug.**

**Fix (this branch):** `apps/infra/environments/staging/main.tf` `module "api_server"` → `cpu_idle=false`; `variables.tf` `api_server_min_instances` default `0→1`. `terraform validate` passes. NOT a fleet-host template change — normal api-server TF apply rolls it (no destructive template dispatch). **Verify:** re-fire chat → `assign_on_enqueue` starts appearing, attach drops ~23s→~1s.

**Prod also affected** (`grounded-access-142814` api-server has same `cpu_idle=true`+`minScale=0`) — do NOT touch prod until staging is verified. Longer-term: LISTEN/NOTIFY fan-out across scale-to-zero multi-instance Cloud Run is inherently fragile (a NOTIFY only reaches instances holding an open listener) → consider a dedicated always-on matchmaker worker. See [[reference_staging_fleet_debug]], [[reference_hosted_runtime_machine_type_cost]].
