---
name: web-activity-enrichment
description: "& Autofill Chrome-extension web-activity → identity-signal enrichment loop — status, gates, and how to drive/verify it"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2a7358cb-75a2-4589-8906-7de1462fcc80
---

The & Autofill Chrome extension captures scrubbed page-visits → the server drafts durable web-interest identity signals. Full loop (ENG-1364, PR #2246):

**Pipeline:** extension `content/activity.ts` (capture, sensitive hosts dropped on-device, `WEB_ACTIVITY_ENABLED` default on) → `POST /v1/developer/web-activity` → `ingestRawSignalBatchCore({kind:'web_activity'})` → raw-signal drain cron (every 5 min, `raw_signal_drain_cron_enabled=true` on staging AND prod) → `extractRawSignal` → `draftFromWebActivityWindow` (aggregates recent `web_activity` blobs, 30-day window) → `web-activity-aggregate` → `web-interest-map` → `web-identity-inference` → `insertSignalSuggestion(source:'web_activity')` → fires `notifySuggestionsReady`.

**Drafting gates (why enrichment often produces nothing):**
- `web-interest-map.ts` is a ~31-domain HIGH-PRECISION curated map (github/strava/imdb/letterboxd/goodreads/seriouseats/chess.com/…). `// unmapped domains never draft`. github.com → `{topic:'software', hdsCode:'5.1', draft:'I work in software.'}`.
- Durability floor (`web-activity-aggregate.ts`): a domain needs **≥3 qualifying visits across ≥2 distinct UTC days** (`WEB_MIN_VISITS=3`, `WEB_MIN_DISTINCT_DAYS=2`). Qualifying = engaged OR dwell ≥8s. `distinctDays` = `dayKey(event.capturedAt)` from the blob, NOT ingest time.

**Status (2026-07-27):** built + validated end-to-end on **STAGING ONLY**. NOT on main/prod — it's in the 19-commit staging→main gap (which also carries the ENG-1353 birth-enqueue regression + workspace-durability #2249). Prod distribution IS built (ENG-1359: prod build workflow → `and-dev-89990`/prod `chrome-extension-artifacts` GCS bucket → admin.and.com → Tools → Chrome Extension → Download → Load unpacked, NOT CWS) but the July-24 prod artifact predates the feature. Extension `config.ts` defaults `VITE_API_BASE` to staging. Server events land in Mixpanel 3993101 (prod-server); no `web_activity` in prod (90d).

**Seed recipe (how I drove a draft on staging for `&michael.phillipszz` = `andee_1772749836721_20j256u`):** upload a gzipped 1-event blob to `gs://and-dev-89990.firebasestorage.app/raw-signals/{andeeId}/web_activity/{ms}.json.gz` (event: `{host:'github.com',path:'/',title:'GitHub',capturedAt:<yesterday_ms>,dwellMs:200000,engaged:true}`), then `INSERT` a `raw_signals` row (kind=web_activity, gcs_object_path, unique content_digest, extraction_status='pending', created_at=now). `downloadRawSignalPayload` gunzips on magic bytes, so upload gzipped with no content-encoding. Drain picks it up within 5 min → drafted "I work in software." suggestion. (Left a synthetic row `rsig_seedyday...` + blob + suggestion `sgs_aar_...` — clean up if needed.)

**Review-surface gap (fixed by ENG-1371, merged to staging):** drafted suggestions (`identity_signal_suggestions`, `status='draft'`, live TTL) surface via `GET /v1/signals/suggestions` / `listLiveSuggestionsForAndee` (no source filter). Photo/location/web are ALL draft — nothing auto-accepts except GTKM `chat` source (DES-63). The app had no reachable review surface (`suggestions_ready` dead-ended on Loops; `/pending-review` formSheet orphaned). See [[cycle-gate-first-ticket-ref]] for the PR that fixed it.
