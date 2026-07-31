---
name: reference_staging_fleet_debug
description: "How to inspect + reset the staging fleet/task/runtime state (tables, api-server checkout logs, leaked-host decommission)"
metadata: 
  node_type: memory
  type: reference
  originSessionId: af12b89a-19f9-4d06-a1bd-e0fbd3015a54
---

Debugging the fleet chat / checkout pipeline on staging (project `and-dev-89990`). Connect: [[reference_staging_gcp_access]] — Cloud SQL proxy on :5433, DB creds from `gcloud secrets versions access latest --secret=database-url-staging` (parse user/pass from the URL; the classifier blocks printing the secret, so pipe it straight into `psql -h 127.0.0.1 -p 5433 -U ampersand -d ampersand`). NOTE zsh doesn't word-split, so a `PSQL="psql …"` var then `$PSQL -c` fails — use a shell function `q(){ psql … -c "$1"; }`.

**Key tables (actual names — there is no `users` table):** `andees` (id, `primary_tag`; tag via `tags.claimed_by_andee_id`), `agent_runtimes` (per-andee identity; `revoked_at IS NULL` = active; `checkout_task_id/host_id/epoch`), `agent_tasks` (the single work queue post-INN-228; `type` incl `chat_bridge`; status enum = queued/claimed/running/completed/failed/cancelled — NO "active"; `target_andee_id`,`target_host_id`,`epoch`,`session_id`=convId,`terminal_code`), `fleet_hosts` (fungible VMs; status ready/booting/assigned/quarantined; `bound_andee_id`,`gcp_instance_name`), `host_sessions` (checkout + client MCP/Chrome sessions), `andee_workspaces`+`workspace_generations`+`task_workspace_commits` (durable workspace, keyed andee+task, see [[architecture_agent_runtimes_model]]).

**Checkout lifecycle logs are in the api-server Cloud Run service, NOT on the VMs** (openclaw ships no app logs to Cloud Logging — ENG-1132). Query:
`gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="api-server" AND jsonPayload.event="checkout.claim"' --project=and-dev-89990 --format=json` — payload fields: `event` (checkout.claim/bind/evict), `hostId`, `outcome` (success/empty/rejected), `reason` (`ok`/`no_work`/`bind_failed`/`stale_epoch`/…). A `bind_failed` storm + hosts flipping to `quarantined` = the [[project_fleet_chat_runtime_anchor_gap]] wedge (andee has 0 active runtime rows).

**Stop a chat_bridge churn loop:** cancel the stuck task — `update agent_tasks set status='cancelled', terminal_at=now(), terminal_code='manual_stop_...', claim_token_hash=null, lease_expires_at=null, last_heartbeat_at=null, updated_at=now() where id='task_…' and status='queued'` (guard on status so you never clobber an in-flight claim). Matchmaker only assigns `queued`, so this halts reassignment.

**Decommission a leaked host** (stuck `assigned`/unbound — reconcile won't drain it because it's alive; flipping it to `ready` bypasses the INN-212 readiness/wipe gate). Do what `reconcileFleetHostPool` does to stale hosts: first verify no live refs (0 non-terminal tasks with that `target_host_id`, 0 `agent_runtimes.checkout_host_id`, 0 active `host_sessions.checkout_host_id`), then `gcloud compute instances delete <gcp_instance_name> --zone=us-central1-a`, then `delete from fleet_hosts where id='fleethost_…' and coalesce(bound_andee_id,'')=''`. The warm allocator (scheduled reconcile) re-provisions to target — a steady staging baseline is ~1 `ready` host + 0 in-flight tasks.

`gcloud` auth expires mid-session (secret fetch returns empty) → ask the user to run `! gcloud auth login`. See [[feedback_gcloud_auth_expiry]].
