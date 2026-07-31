---
name: architecture_agent_runtimes_model
description: "agent_runtimes is a durable per-andee identity ANCHOR, not a compute process; fleet hosts are fungible; durable storage is runtime-agnostic"
metadata: 
  node_type: memory
  type: reference
  originSessionId: af12b89a-19f9-4d06-a1bd-e0fbd3015a54
---

**`agent_runtimes` is NOT a compute process** — it's a control-plane *descriptor* / durable per-andee logical-runtime **identity anchor**. The `rt_…` id and "runtime" naming are dedicated-era legacy (when the row was ~1:1 with an always-on VM). A row can exist with `status=revoked`, `checkout_*` empty, `runtime_auth_token_hash` null and NO compute running anywhere.

**Fleet model = fungible compute + durable identity:**
- `fleet_hosts` = pooled, stateless VMs (shared across andees over time; `bound_andee_id` is transient).
- `agent_runtimes` = durable per-andee identity (keyed `andee_id`/`tag_id`; persists across host churn).
- Cardinality: N hosts : 1 runtime over time; 1:1 ONLY during an active checkout. The host↔runtime link (`checkout_host_id`/`checkout_epoch`) is a lease, not identity.
- A chat turn: **hydrate → run → capture → wipe**. The fungible host locks the andee's runtime row, stamps its VM identity, mints a per-checkout credential, restores the andee's workspace (`workspace_runner.py: restore_hydrate_bundle`), *becomes* that andee for the turn, then `capture_checkout` snapshots the workspace back and the host is wiped/returned. It does NOT forward to a separate live runtime. Per-checkout hydrate-then-wipe is a deliberate tenant-isolation boundary.

**Where an idle andee's runtime "lives": nowhere as compute** — zero per-andee idle VM. At rest it's just durable state: identity in Postgres (`agent_runtimes` + `runtime_recipient_keys` + `trusted_hosts` + digests `skills_digest`/`config_digest`/`user_md_generation`) and workspace in the durable store (`workspace_generations`/`task_workspace_commits`, opaque `bytea` file generations; skills → content-addressed GCS).

**The row conflates two natures in one table** (the design smell behind [[project_fleet_chat_runtime_anchor_gap]]): durable identity (id, andee, keys/digests) vs live-instance state (`gcp_instance_name`, `checkout_*`, heartbeat, `gateway_restart_count`, oom/kill pointers). A process-level failure (dedicated VM create) nuking the identity anchor is what bricks a fleet andee.

**Durable storage (Kevin Manase, #2249/#2257) is runtime-agnostic** — it has NO dependency on `agent_runtimes`. `workspace_generations`/`task_workspace_commits`/`andee_workspaces` are keyed by `andee_id`+`task_id`+`writer_fence` (no `runtime_id`). Single-writer guarantee lives on `andee_workspaces` (`writer_fence`+`active_task_id/epoch`), authenticated by the **task lease token**; `inspectCheckoutPrincipal` (`agent-tasks.ts:1404`) never touches `agent_runtimes`. Two coupling seams only: (1) claim mints the lease (currently requires a runtime bind), (2) `commitFinalWorkspaceAndCompleteTask` co-locates the runtime unbind (lock order `agent-tasks.ts:1611`). So decoupling the runtime anchor needs no rework of durable storage. Caveat to confirm: finalize tolerance when the runtime row is revoked mid-checkout.
