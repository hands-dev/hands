---
name: project_inn237_fleet_upgrade_task
description: INN-237 fleet-upgrade task admin — ungate + runner publisher merged to staging 2026-07-30; deployment path
metadata: 
  node_type: memory
  type: project
  originSessionId: a126ef35-44d5-4fe5-9954-eac19ef1486d
---

INN-237 = OTA `fleet_upgrade` task administration for the fungible fleet hosts
(the in-place OTA lane, distinct from the cold-boot template lane — see
[[architecture_agent_runtimes_model]] and the runbook `docs/infrastructure/fleet-host-upgrade-runbook.md`).

Core mechanism landed earlier (PR #2328). On **2026-07-30** two blockers merged to
staging so worktree-5 could drive an end-to-end `fleet_upgrade` against a canary
(and fix poison-looping chat_bridge hosts):

- **#2338 (`8b243a2a`)** — ungate the runner's upgrade poll from the task-type
  capability probe. `_try_staged_upgrade_cutover` (guarded by staged != applied)
  runs at the not-ready + capability gates too, so an unhealthy/poison-looping
  host can still cut over. Host-baked runner code → reaches existing hosts only
  via a **template-lane reprovision** (destructive TF apply) or a runner-lane OTA.
- **#2339 (`7849be71`)** — `POST /v1/fleet/hosts/runner-archive` producer door
  (`fleet-host-runner-archive.ts` + publisher), the runner-lane analog of the
  skills-archive producer. Packs `checkout-executor.py` + `workspace-runner.py`
  **at 0755** (host runs them via systemd `ExecStart=…` shebang — 0644 → EACCES).
  Member names bound to `_UPGRADE_RUNNER_FILES` by a cross-language test. `manifest_stager.py`
  is NOT shipped (template-baked). api code → deploys with the next api build.
- **#2335 (`63032193`)** — runbook + `.claude/rules/fleet/fleet-upgrade-publish.md`.

Closed loop: producer → signer `--runner-digest/--runner-archive` → `artifacts.runner`
→ desired-release door → stager `slot/runner/` → `upgrade` verb.

Gotcha hit: touching an api/lib file trips the **Data Classification Ratchet**
full scan, which then flags any pre-existing unregistered sink (allocator.ts was
worktree-2's). Register your new GCS `.save()` as a `store:` sink in
`packages/db/src/security/data-classification-register.ts` + regen the snapshot;
the snapshot regen aborts at the `missing` assertion, so temporarily register the
sibling sink to let `-u` run, then revert. See [[feedback_data_classification_ratchet]].

Follow-ons MERGED to staging on **2026-07-30**:
- **#2340 (`0ffa2e17`)** — policy-lane producer (`POST /v1/fleet/hosts/policy-archive`,
  `fleet-host-policy-archive.ts`, packs `managed-path-policy.json` + `wipe-manifest.json`
  at 0644, member names bound to `_UPGRADE_POLICY_FILES`) + real-Postgres integration
  tests for the `fleet_upgrade` claim/complete/quarantine + reaper transitions.
- **#2342 (`edc277c1`)** — the **held (assigned-but-not-released) task primitive**;
  see [[project_held_task_and_release_orchestrator]].

All 3 whole-runtime OTA lanes now have producers (engine/runner/policy); skills
still fails closed on the host. Local DB integration tests run against
`postgresql://ampersand:ampersand_local@localhost:5432/ampersand`.

Still open (deferred, NOT built): A/B multi-candidate manifests (dropped for now);
the capacity-gated release orchestrator (see [[project_held_task_and_release_orchestrator]]);
minor: runbook nested-base64 verify gotcha + INN-238 vestigial cleanup (idle_timeout_seconds,
inn-215-chat-idle-gap-evidence script). Related: [[project_fleet_chat_runtime_anchor_gap]],
[[reference_fleet_host_capability_provisioning]].
