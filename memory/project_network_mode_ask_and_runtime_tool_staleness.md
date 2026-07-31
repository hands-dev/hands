---
name: network-mode-ask-and-runtime-tool-staleness
description: Network-mode ask_question shipped for agent chat (ENG-1368/1369); the runtime tool-list staleness gotcha + reprovision recipe that fixed it
metadata: 
  node_type: memory
  type: project
  originSessionId: 8fb23e2a-1965-4789-b113-0ec030cce54a
---

Shipped (2026-07-27) network-mode `ask_question` for the agent-chat surface (extension + app): asking "who of my people would find this interesting?" now ranks the caller's connections instead of punting.

- **ENG-1368** (API): per-contract `guidance` field on the `agent-chat` contract, carried verbatim in the per-turn engine-request envelope (`composeEngineRequest`, fixed skeleton). Agent-chat-only scope; loops untouched. Per-turn, so it reaches runtimes on API deploy — no runtime refresh needed.
- **ENG-1369** (agent-tools + mcp): taught the `ask_question` canonical description + `participants` field that omitting participants ranks the whole network. Server capability was ENG-1366 (`POST /v1/ask` network branch).
- **ENG-1370**: deleted the dead `apps/api/src/lib/agent-tools/` in-app chat tool layer (orphaned ENG-856 prototype, route removed by ENG-932) + the `'chat'` surface in `@ampersand/agent-tools`. `describeFor` is now mcp-only.

**KEY GOTCHA → [[eng1374-runtime-tool-list-staleness]] (ENG-1374, High):** a change to an MCP tool's DESCRIPTION or input-schema does NOT reach a running hosted runtime after the MCP deploys. OpenClaw snapshots the MCP tool list when its agent session is created and RESUMES that session across restarts. A 26-day-old runtime kept reading the old description. Neither a VM `reset`, a `systemctl restart openclaw-gateway`, nor `ampersand-runtime-updater.service` (OTA release converger — logs `decision: none`, wrong layer) refreshes it. Only a **full reprovision** forces a fresh session → fresh `list_tools` → new description. Per-turn envelope guidance (ENG-1368) is exempt — it's composed fresh each turn, not part of the cached tool list.

**Reprovision recipe (destructive, not retry-safe):** `POST https://api.staging.and.com/v1/runtimes/cohort/reprovision` with header `authToken: <runtime-reprovision-operator-token secret>` and body `{runtimeIds:[...], reason, idempotencyKey}`. Deletes VM + revokes grant + re-mints a NEW runtime id (fresh disk, USER.md regenerates, new session). ~60s + a few min to `online` (pending_bootstrap → provisioning → online). Admin UI wraps it at `apps/admin/.../runtimes/[andeeId]/reprovision`. A non-2xx = UNKNOWN partial state; reconcile from audit lines, never blind-retry.

**Runtime forensics:** SSH via `gcloud compute ssh <gcp_instance_name> --zone --project --tunnel-through-iap`. Runtime home `/var/lib/ampersand-runtime/`: `workspace/USER.md` (the rendered runtime principal, regenerated only on provision), `.openclaw/agents/main/sessions/*.jsonl` (conversation transcripts — grep for the envelope `guidance` + `ask_question` tool calls/args), `.openclaw/agents/main/agent/codex-home/logs_2.sqlite` (tool defs fetched from MCP). Verified the fix: fresh session called `ampersand.ask_question` with a question and NO `participants` → ranked answer.

Staging agent for [[local-dev-phone-auth]] work is &michael.phillipszz (andee_1772749836721_20j256u); prod is &michael. See [[staging-gcp-access]] for the Cloud SQL proxy recipe (proxy drops often — restart `cloud-sql-proxy ... --port=5433`).
