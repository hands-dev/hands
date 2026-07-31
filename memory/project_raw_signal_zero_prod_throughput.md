---
name: project_raw_signal_zero_prod_throughput
description: Raw-signal pipeline has ZERO prod throughput (ENG-1091) — no photo_gps or location dwells ever reach the durable store
metadata: 
  node_type: memory
  type: project
  originSessionId: d4ee228e-b896-4ed1-8a16-ae8762766330
---

**UPDATE 2026-07-03: dwell rail is now ALIVE in prod too.** Ground-truthed against prod DB: `raw_signals` = 36 photo_gps + 52 location_ping + 21 photo_labels; `place_affinities` = 316 photo_scan + **24 `origin='dwell'`** (newest dwell today). So the CLVisit dwell rail DOES land + resolve venues in prod fleet-wide now (supersedes the "location_ping = 0 all-time / dwell never resolves" finding below). BUT it's per-device: an andee whose iOS location auth isn't "Always" (or whose visit background task isn't running) emits **0 location_ping** while the fleet works — saw exactly this for prod &michael (`4DHFDJ8Uccv8nmGr8nG7Yj9nm9zS`): 0 location_ping all-time, all his venues are photo_scan-origin. Separately his photo scans still truncate hard (walked 200/61,616, truncated=t, reached_end=f) = [[project_photo_labels_mlkit]]-adjacent ENG-1093, so recent photos (a new coffee shop) never get walked. Diagnostic recipe (prod DB, per-andee): raw_signals by kind/status, place_affinities origin, signal_suggestions status (his were all `accepted`, 0 pending → home "new signals" empty), photo_scan_runs truncated/reached_end.

**RESOLVED 2026-06-26 (ENG-1091): root cause was a server-side gzip bug; pipeline now verified end-to-end in prod.** Watching a live 61k rescan on TestFlight build 66: ingestion WORKED (row landed), but extraction failed 100% on `downloadRawSignalPayload` (`storage.ts:170`) — blobs stored `contentEncoding:'gzip'` are GCS-transcoded/auto-decompressed, then `gunzipSync` threw `Z_DATA_ERROR` (Sentry AMPERSAND-API-20). Fix PR #1888 (`download({decompress:false})` + magic-byte guard), shipped **v1.42.2** (api-server-00126-zhd). After deploy the drain cron re-extracted the failed row → `status=done` + **3 real `signal_suggestions`** ("Visited United States/Brooklyn Heights/Mount Hood Village"). **No new mobile build needed — build 66 ships correctly.** The earlier "Request failed (404)" ship errors were transient (hit the api-server during the v1.42.1 deploy window 17:28–17:32), not a routing bug. Remaining: large-iCloud-library completeness (scan truncates ~15k, watermark doesn't advance) = **ENG-1093**; gzip fix still needs porting to staging (went straight to main).

---

(original finding, for history) the new dumb-shipper raw-signal pipeline (ENG-1026/1029/1031) had **zero throughput in production** — ground-truthed against the prod DB, not telemetry.

- `raw_signals` = **0 rows, all kinds, all-time** (both `photo_gps` AND `location_ping`).
- `place_affinities` = 40, **all `origin='photo_scan'`, 0 `dwell`**, newest `2026-06-18` → these are all from the **legacy** `/v1/photos/venues/resolve` path (`routes/photos.ts`, device "no longer calls" per ENG-1031), now tapering. No live location dwell has EVER resolved a venue in prod.
- Control (same query session, real prod): andees 657, signal_suggestions 93, place_affinities 40.
- Mixpanel corroboration: `visit_task.fired`=0 and `raw_signal.ingested`=0 over 60d (prod project 3993101); `photos.scan_completed`=14/30d (scans complete on-device but GPS never lands). The 28 `location.ping_received` are the LEGACY neutered movement-ping path (ENG-1024 made `location-task.ts` a no-op), NOT the current CLVisit dwell rail.

**Implication:** the drain cron (ENG-1089) + dead-letter hygiene (ENG-1090) + agent enrichment all run on an empty table in prod. The real gap is **upstream ingestion** — devices aren't landing anything at `/v1/raw-signals/{photo-gps,location}` in prod. Most likely: prod mobile build doesn't yet ship to the new endpoints (version/gate), OR a silent ship failure. Triage steps in ENG-1091.

**Prod DB read-only access recipe (reusable):**
- Instance `grounded-access-142814:us-central1:ampersand-production` (POSTGRES_16). Secret `database-url-production` holds `postgresql://ampersand:<pw>@localhost/ampersand?host=<socket>`.
- `CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.12`; `cloud-sql-proxy --port 5433 grounded-access-142814:us-central1:ampersand-production` (ADC auth, michael@and.com has Cloud SQL Client); then `PGPASSWORD=<parsed> psql -h 127.0.0.1 -p 5433 -U ampersand -d ampersand`. Kill the proxy PID when done.

Related: [[project_prod_drain_cron_activated]], [[reference_staging_gcp_access]]. The enrichment trigger is ON in prod (ENG-1055) but has no raw input to enrich.
