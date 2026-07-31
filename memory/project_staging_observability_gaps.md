---
name: project_staging_observability_gaps
description: Two staging observability gaps (ENG-1132) — openclaw runtime ships no app logs to Cloud Logging; photo_scan_runs never written
metadata: 
  node_type: memory
  type: project
  originSessionId: 00214d03-412c-4636-92e5-443f638447cf
---

Tracked as **ENG-1132** (cycle 22, filed 2026-07-01). Two staging observability gaps found while tracing an enrichment failure ([[project_enrichment_blocked_raw_read_scope]]):

- **Gap A — openclaw runtime has no app logs in Cloud Logging.** The per-andee enrichment VM (`openclaw-rt-staging-*`, project `and-dev-89990`) only emits `GCEGuestAgent` lifecycle logs; serial console is systemd/rsyslog noise. The agent's reasoning was only recoverable from the `runtime_channel_messages` DB table. Ask: ship openclaw stdout/stderr to Cloud Logging labeled with `runtime_id`/`andee_id`.
- **Gap B — `photo_scan_runs` never written on staging.** The ENG-1123 per-walk run-record table is empty for the andee AND globally over 24h despite live scans shipping `raw_signals`. No server record of `walked`/`reached_end`/counts, so client-reported walk counts can't be confirmed. Ask: confirm the write path is deployed/reachable on staging; fix if gated or silently failing.

Plan: work on fixing these next (per Michael, 2026-07-01, after control-plane investigation).
