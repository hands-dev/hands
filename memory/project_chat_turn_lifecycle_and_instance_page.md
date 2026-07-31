---
name: project_chat_turn_lifecycle_and_instance_page
description: Fleet-host chat-turn lifecycle (2 state machines) + admin per-instance task detail page (ENG-1387); the observability gaps to close before optimizing.
metadata: 
  node_type: memory
  type: project
  originSessionId: e8843cd4-6848-4068-a18c-841fc6aa6cfc
---

ENG-1387 shipped to staging (PR #2320, 2026-07-29): admin **per-instance agent-task detail page** at `/dashboards/tasks/instances/[id]` with a lifecycle **waterfall**. Ledger rows now link instance→`/instances/[id]` (new Instance column on `TasksTable`) while the type cell keeps →`/types/[type]` (definition). Built as prep for chat-turn latency **optimization** — the user's next step.

**Fleet-host chat turn = TWO parallel state machines** (traced on `origin/staging`):
- **Message ledger** `runtime_channel_messages` (`packages/db/src/schema/agent-runtime.ts`): `queued→claimed→streaming→responded`; timestamps `createdAt`,`claimedAt`,`respondedAt`.
- **Dispatch task** `agent_tasks` type `chat_bridge` (`schema/agent-tasks.ts`): `queued→claimed→running→completed`; `createdAt`,`claimedAt`,`terminalAt`; linked via `sessionId`(=conversationId).
- Flow: `POST /v1/chat/open` (`openAgentChatForAndee`, conversations.ts) enqueues `chat_bridge` (canary) → `pg_notify('task_work_queued')` → `task-matchmaker-wakeup.ts` immediate assign (interactive) → host claims message → `POST /v1/runtimes/:id/messages` send → client adaptive poll `GET .../messages` (1.2s streaming / 5s / 10→20s idle, `apps/mobile/lib/agent-runtime-polling.ts`).

**Observability BLIND SPOTS (call out before optimizing):** no first-token/streaming-start timestamp (generation is one opaque `claimed→responded` block); no persisted client delivery/round-trip time; host-internal bring-up (`agent_runtimes` supervisor/runner ready) not instance-scoped; **Mixpanel is prod-only, fails closed on staging** (`packages/analytics/src/client.ts` — the staging turn emits ZERO analytics); Sentry has only point `latencyMs` on `task.enqueue`/`orchestrator.assign*`, no end-to-end trace.

New reusable code: `getAgentTaskById`, `listConversationTurnTimeline` (`@ampersand/db/queries`); pure `buildTaskInstanceLifecycle` (`apps/admin/src/lib/tasks/lifecycle.ts`, unit-tested via `pnpm -F admin test:lifecycle`). Related: [[project_eng1383_chat_cutover]], [[project_eng1384_fleet_chat_open_attach]], [[project_task_queue_cutover]].

**ENG-1388 chat-turn distributed tracing SHIPPED to staging (PR #2321, 2026-07-29)** — chose Sentry over GCP Cloud Trace (already installed 10% on api/mcp/web; Cloud Trace = from-scratch OTel + the deep host-loop span is blocked on the external openclaw pkg either way). One trace/turn: `chat.send → task.enqueue → host.queue_wait/ttft/generation → & MCP tool calls`. Carrier = new nullable `runtime_channel_messages.trace_context` col (migration 0161, + `first_token_ms`/`total_ms`): written at send (`serializeTraceContext`), returned in the claim payload, `continueTrace`'d in the `/response` handler to emit backdated host spans (pure `computeHostSpanWindows` in `apps/api/src/lib/observability.ts`). MCP tool calls join via the fleet-host Python runner (`apps/infra/modules/openclaw-fleet-host/runner/checkout_executor.py`) exporting `sentry-trace`/`baggage` through the same env→header map as `X-Ampersand-Run-Id`. `tracesSampler` force-samples chat hops on staging, base-rate prod. Span attrs = stable ids only (no content). Admin instance page: waterfall splits ttft/generation + "View trace in Sentry" link (org `and-com`). **DEFERRED:** mobile client→API hop (reverses app's deliberate tracing-off); dedicated-runtime shell-template MCP-header parity; openclaw internal per-model-call spans (external). **Runtime-software-update caveat:** the fleet-host runner change reaches existing staging hosts only on reprovision/rollout — not on merge. Gotcha: `and`/agentkit CLI is NOT in the turn path (it's runtime-ops); the & MCP (hosted `apps/mcp`) is where andee tool calls land, and the host auths as the andee via a checkout-fenced `hosted-runtime-mcp` OAuth bearer (`authorizeHostedRuntimeMcpSession`).
