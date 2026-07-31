# Project Memory

## About Michael
- [Plan mode is collaborative iteration](user_michael_plan_mode_iteration.md) — plans are revisable drafts; ExitPlanMode often rejected to refine.

## Stashed Plans
- [Firestore→PostgreSQL migration](project_firestore_to_postgres.md) — Drizzle + CloudSQL, 9 phases; branch `firestore-to-postgres`.
- [Subdomain standardization + cookie scoping](project_subdomain_plan.md) — `{app}.{env}.and.com`, per-env cookies.
- [Auth migration and-api-server → apps/api](project_auth_api_migration.md) — Hono + PG, SMS-verify.
- [Feature API Cloud Run deploy](project_feature_api_deploy.md) — isolated `api-mobile-feature` staging Cloud Run.
- Paused branch plans: Mixpanel admin dashboard (`.claude/plans/luminous-bubbling-oasis.md`, `feat/admin-mixpanel-analytics`); Entity items sub-collection mgmt (`.claude/plans/valiant-juggling-robin.md`, `feat/admin-entity-subcollections`).

## App Routing
- Next.js uses `proxy.ts` not middleware.ts (`apps/app/src/proxy.ts`); `/&tag`→`/event/tag`, `/&&tag` w/ `x-pathname`; proxy injects `x-andee-session`.
- Non-entity routes (`/profile`,`/blend`) auth-gate→login; all `/&` on :3003. Dev stack `pnpm dev`: Web :3001 App :3003 Admin :3002.
- [Staging sandbox worktree](project_staging_sandbox_worktree.md) — main checkout points mobile at staging.
- [This worktree ports/DB/mobile env](project_worktree_env_ports_db.md) — +20 ports (Admin :3022); shares wt-1 Postgres.

## Architecture
- [Signals & Perspectives privacy model](architecture_signals_perspectives.md) — zero-knowledge; key-gated perspectives, TOFU.
- [NFC ephemeral perspectives](architecture_nfc_ephemeral_perspectives.md) — time-limited signal sharing; TTL, per-tap anonymity.
- [agent_runtimes model](architecture_agent_runtimes_model.md) — durable per-andee identity ANCHOR, not compute; fleet hosts fungible.

## Active Initiatives
- [Fleet naming contest artifact](project_fleet_naming_contest_artifact.md) — RCV-voting artifact backed by Google Drive.
- [ENG-1385 identity deep-search loop](project_eng1385_identity_deepsearch_loop.md) — BACKLOG: onboarding "Be You" web search.
- [Network-mode ask + tool staleness](project_network_mode_ask_and_runtime_tool_staleness.md) — chat ranks connections; runtime tool-list staleness.
- [Feature registry scenario↔ticket links](project_feature_registry_scenario_tickets.md) — @eng-tickets + resolved-by-PR.
- [Feature-maturity rubric](project_feature_maturity_rubric.md) — `docs/feature-maturity-rubric.md`; Miro Eng-Readiness; three 0–4 ladders (Working/Observed/Operated, ENG-1281) in [project_maturity_three_ladders.md](project_maturity_three_ladders.md).
- [Provision-on-login live in prod](project_provision_on_login_prod.md) — always-on since 06-23; watch Mixpanel 3993101 + CPUS quota.
- [INCIDENT runtime poison-birth wedge](project_incident_runtime_poison_birth_wedge.md) — 07-27 birth lease-expiry → worker poison-loop.
- [Prod-deploy ordering risk](project_prod_deploy_ordering_risk.md) — migrations run BEFORE smoke-gated deploy.
- [Mixpanel telemetry architecture](project_mixpanel_telemetry_architecture.md) — one prod-only project, event de-dup.
- [Engineering Cost & Ops Cleanup](project_eng_cost_cleanup.md) — 9-pillar (ENG-513–543); `scripts/scan-org-costs.sh`.
- [Google Play API access](project_google_play_api_access.md) — Android Publisher API.
- [ENG-1014 cpu_quota alert gated OFF](project_eng1014_cpu_quota_alert_gated_off.md) — prod alert disabled; needs re-enable.
- [INCIDENT bootstrap AND-CLI-token skew](project_incident_bootstrap_andcli_token_skew.md) — 06-24 "Preparing agent" token API skew.
- [ENG-1055 capability-skill paved path](project_eng1055_capability_skill_paved_path.md) — publish skills to VMs via `scripts/fleet/pub…`.
- [Rideshare GCP build](project_rideshare_gcp_tickets.md) — INN-184/185/186 orchestrator/bootstrap/durable-storage.
- [Raw-signal prod pipeline (ENG-1091)](project_raw_signal_zero_prod_throughput.md) — photo_gps + location_ping + dwell fleet-wide; no "Always" auth.
- [Venue lens = skill-owned pick](project_venue_lens_enrichment_skill.md) — drop Google 50-type pre-filter.
- [Enrichment raw_read scope RESOLVED](project_enrichment_blocked_raw_read_scope.md) — ENG-1133 self-heal converged; staging cohort carries signals:raw_read.
- [Dwell rail re-arm gap (ENG-1177)](project_eng1177_dwell_rearm_gap.md) — CLVisit re-arm fix merged staging.
- [Staging observability gaps (ENG-1132)](project_staging_observability_gaps.md) — openclaw ships no app logs to Cloud Logging.
- [Runtime web-RAG capability](project_runtime_web_rag_capability.md) — runtimes fetch arbitrary URLs, ground on live content.
- [INCIDENT birth-enqueue regression (ENG-1353)](project_incident_birth_enqueue_regression_eng1353.md) — 07-24 connect loops stuck, dropped birth.
- [Loop 2 unlock false-lock on archived GTKM](project_loop2_unlock_archived_gtkm_bug.md) — archiving GTKM re-locks Loop 2.
- [& Autofill web-activity enrichment (ENG-1364)](project_web_activity_enrichment.md) — capture→ingest→drain→web-interest; STAGING only.
- [Related andees on the page (ENG-1376)](project_related_andees_on_page.md) — reverse profile-link lookup → sash + iframe.
- [ENG-1383 chat cutover to fleet hosts](project_eng1383_chat_cutover.md) — per-andee chat_bridge canary.
- [ENG-1384 fleet chat attach-on-send](project_eng1384_fleet_chat_open_attach.md) — PIVOTED 07-30 open→send (type-ahead); attach-on-open retired.
- [Task-queue cutover (INN-219)](project_task_queue_cutover.md) — retire `runtime_channel_messages`; `agent_tasks` single queue.
- [Two signal review queues](project_signal_review_queues.md) — enrichment drafts vs identity_signal_suggestions.
- [Warm allocator + deferred-task primitive](project_warm_allocator_deferred_tasks.md) — INN-233/234 merged; warm allocator flag-OFF.
- [Sentry distributed tracing (wt-4)](project_sentry_distributed_tracing_worktree4.md) — fleet-host chat-ready latency surface; host-span per-turn trace MERGED (ENG-1389 #2337) via [project_host_span_beats_tracing.md](project_host_span_beats_tracing.md).
- [Photo-GPS enrichment loop](project_photo_gps_enrichment_loop.md) — ENG-1418 umbrella; Phase-2 profiling #2356 MERGED; Phase-1 heavy_work lane SUPE…
- [Enrichment loops → GTKM substrate](project_enrichment_loops_gtkm_substrate.md) — per-family self-perpetuating loops (most-recent-N-unprocessed → enrich).
- [OPT-3 warm engine pool](project_opt3_warm_engine_pool.md) — chat cold-attach ~54s fix; epic ENG-1424; idle openclaw ≈330MB → ~15-20 pinned.
- [Fleet claim long-poll + probe cache (INN-227)](project_fleet_claim_longpoll_probecache.md) — `/hosts/claim` NOTIFY-woken long-poll.
- [INN-240 NOTIFY-wake dead on Cloud Run](project_inn240_notify_wake_dead_cloudrun.md) — cpu-throttle+scale-to-zero kills LISTEN; fix `cpu_idle`; staging fixed, prod residual.
- [INN-235 checkout-watcher cold-boot backoff](project_inn235_checkout_watcher_backoff.md) — not-ready path backs off + exit 0.
- [Fleet-chat runtime-anchor gap](project_fleet_chat_runtime_anchor_gap.md) — no fleet-path agent_runtimes minter; fleet-blind reset revokes anchor.
- [Staging fleet debug runbook](reference_staging_fleet_debug.md) — inspect tables + checkout.* logs; stop chat loop; decommission leaked host.
- [INN-237 fleet-upgrade task admin](project_inn237_fleet_upgrade_task.md) — ungate #2338 + runner #2339 + policy #2340 + docs #2335; ratchet gotcha. Held-task gate + `releaseHeldTask` MERGED #2342 ([project_held_task_and_release_orchestrator.md](project_held_task_and_release_orchestrator.md)).
- [Chat ~60s cold-reattach latency](project_chat_cold_reattach_latency.md) — ENG-1422; INN-238 per-turn detach → cold re-attach; fix = INN-185 + warm alloc.
- [Enrichment lane consumer deferred](project_enrichment_lane_consumer_deferred.md) — agent_tasks location/photo_enrichment never drain on staging: consumer deferred + no host attests `location` cap.
- [Fungible cold-claim capability lag](project_fungible_cold_claim_capability_lag.md) — multi-min cold-claim = cold-boot capability-attestation flap + no matchmaker re-trigger; waits */5min drain tick. Not affinity.
- [Fleet-host boot-log ops-agent gap](project_fleet_host_bootlog_ops_agent_gap.md) — no ops-agent → boot/onboard logs serial-only; fix = template-lane ops-agent; prod omits FLEET_HOST_DESIRED_IMAGE_VERSION footgun. ENG-1132/1448.
- [ENG-1440 queue-wait host-ready re-trigger](project_eng1440_queue_wait_host_ready_retrigger.md) — matchmaker re-run on host-ready heartbeat; #2377 MERGED to staging.
- [Clean-sheet fleet-host image (ENG-1449)](project_clean_sheet_fleet_host_image.md) — structural isolation replacing wipe-as-boundary; 3 pillars, CS2 atomic flip + crash-reaper; STAGING-only.

## References
- [agent-bus cross-worktree MCP](reference_agent_bus_cross_worktree_mcp.md) — personal user-scoped MCP at `~/.claude/tools/agent-bus`; send/receive/peers.
- [Hosted-runtime machine type & cost](reference_hosted_runtime_machine_type_cost.md) — e2-standard-2 ~$50/mo; one shared knob.
- [Fleet-host capability provisioning](reference_fleet_host_capability_provisioning.md) — give fungible hosts a capability + 6 gotchas.
- [Staging GCP access](reference_staging_gcp_access.md) — project `and-dev-89990`; `CLOUDSDK_PYTHON`; Cloud SQL proxy :5433.
- [Fleet runner rollout + api-build-skip footgun](reference_fleet_runner_rollout_and_staging_api_build_skip.md) — runner baked in template startup script.
- [Staging runs NODE_ENV=production](project_staging_node_env_production.md) — dev-only routes 404 on staging.
- [Firestore→PG migration runbook](reference_firestore_to_pg_runbook.md) — per-env migration ops guide.
- [HDS taxonomy location](reference_hds_taxonomy.md) — `packages/db/src/constants/hds.ts`.
- [agentkit CLI repo](reference_agentkit_cli_repo.md) — github.com/theandcompany/agentkit; Santiago-owned.
- [GCP project IDs](reference_gcp_projects.md) — prod `grounded-access-142814`.
- [Local dev phone auth](reference_local_dev_phone_auth.md) — `+1816555XXXX` + code `267735`.
- Local DB: `postgresql://ampersand:ampersand_local@localhost:5432/ampersand` — for `pnpm -F @ampersand/db test:integration`.

## Feedback
- [Foreman cost-aware mode](feedback_foreman_cost_aware_mode.md) — on credits: trim verification (trust returned artifacts, wider auto-resolve, fewer round-trips), keep irreversible gates.
- [Foreman-followup Linear backlog](feedback_foreman_followup_backlog.md) — file for-later follow-ups under `foreman-followup` label (Michael, Backlog); pull top unblocked when a worker's idle.
- [Direct sub-agents vs worker delegation](feedback_subagents_vs_worker_delegation.md) — foreman names the mechanism: in-instance sub-agents for read-only synth, cross-worktree delegation for isolated builds.
- [Foreman: rebase before every delegation](feedback_foreman_rebase_before_delegation.md) — enforce `git fetch && rebase origin/staging` in each delegated task.
- [Foreman proactive whole-board cross-check](feedback_foreman_proactive_board_crosscheck.md) — cross-check each worktree's scope vs known initiatives/migrations/deprecations.
- [Foreman delegates even env/config tasks](feedback_foreman_delegates_even_env_tasks.md) — never hand-do execution (statusline/Warp/colors); route it.
- [Foreman reviews zoomed out](feedback_foreman_reviews_zoomed_out.md) — PR gate = priority/scope/board-fit/blast-radius, NOT line-level; /code-review high only for destructive-rollout.
- [Staging risk isn't urgent](feedback_staging_risk_not_urgent.md) — don't halt-a-roll/ping for staging-only latent issues; escalate for prod or actively-firing breakage.
- [On-host measurement cleanup + confirm](feedback_onhost_measurement_cleanup.md) — remove anything written during on-host/staging measurements + CONFIRM cleanup.
- [Native todo: delete on complete](feedback_native_todo_delete_on_complete.md) — DELETE native Claude Code tasks when crossed off; agent-bus list stays the audit trail.
- [Host vs Runtime image naming](feedback_host_runtime_image_naming.md) — two lanes: "Host images" (`flh-`, cold-boot) + "Runtime images".
- [Worktree conventions](feedback_worktree_home_branch_convention.md) — persistent `wtN/home`, PR work on ephemeral branches; [no new worktrees](feedback_no_new_worktrees.md); [worktrees share one branch namespace](feedback_worktrees_share_branch_namespace.md) — never mass-delete local branches.
- [Brand name in copy is "&"](feedback_brand_name_ampersign.md) — not "Ampersand".
- [E2E tests use data attributes](feedback_e2e_data_attributes.md) — assert `data-testid`, never text/styling.
- Linear: [ticket defaults](feedback_linear_ticket_defaults.md) (assign user, current cycle, Todo); [sub-issue cascade on parent Done](feedback_linear_subissue_cascade.md); [strict MCP field names](feedback_linear_mcp_strict_field_names.md) (`blockedBy` not `addBlockedBy`).
- Cycle-gate/CI: [gotchas](feedback_ci_merge_gotchas.md) (commitlint lowercase; cycle-gate needs current-cycle ticket); [reads FIRST ticket ref](feedback_cycle_gate_first_ticket_ref.md); [INN passes w/o cycle](feedback_cycle_gate_inn_tickets.md).
- Deploy/release: [hotfix straight to main/prod](feedback_hotfix_straight_to_main.md) (`break-glass`, `--squash --admin`); [prod TF Apply gates images](feedback_prod_deploy_tf_gates_images.md); [Green Deploy ≠ live canary](feedback_deploy_canary_not_live.md); [tag on staging-merge commit](feedback_tag_on_staging_merge.md); [release tag number race](feedback_release_tag_number_race.md); [git tags not GitHub Releases](feedback_use_git_tags_not_releases.md); [prod deploy SA logging role](feedback_prod_deploy_sa_logging_metrics.md).
- Merge discipline: [done means merged to staging](feedback_done_means_merged.md); [verify ticket merge status before starting](feedback_verify_ticket_merge_status.md); [in-branch label](feedback_in_branch_label.md); [deprecate old paths as you ship](feedback_deprecate_old_paths.md).
- Migrations: [no manual migrations](feedback_no_manual_migrations.md) (run through CI); [local DB migration drift](feedback_local_db_migration_drift.md); [Drizzle migration + rebase hazards](feedback_drizzle_migration_rebase.md).
- Mobile: [no EAS push without ask](feedback_no_eas_push_without_ask.md); [mobile-deploy --ref must match env](feedback_mobile_deploy_ref.md); [Expo plugin perm strings](feedback_expo_plugin_perm_strings.md); [local Expo Modules gitignore](feedback_local_expo_modules_gitignore.md); [NativeWind silently drops classes](feedback_nativewind_silent_drop_classes.md) (brand green #219f55).
- Pre-commit/build: [biome not pre-commit gated](feedback_biome_not_precommit_gated.md); [check-types sibling drift](feedback_precommit_checktypes_sibling_drift.md); [read before Edit on barrels](feedback_read_before_edit_barrel.md); [stale test mocks on sink/arg change](feedback_stale_test_mocks_on_sink_or_arg_change.md); [monorepo dev commands](feedback_monorepo_dev_commands.md).
- Local env: [shell/env gotchas](feedback_local_shell_env_gotchas.md) (zsh globs, BSD sed); [Cloud SQL proxy flaky](feedback_cloud_sql_proxy_flaky.md) (`:5434` prod); [python3.12 known-good interpreter](feedback_python312_known_good_interpreter.md); [scratchpad outside repo breaks tooling](feedback_scratchpad_outside_repo_breaks_tooling.md); [GH_TOKEN shadows gh keyring](feedback_gh_token_env_shadows_auth.md); [gcloud auth expires mid-session](feedback_gcloud_auth_expiry.md).
- Ops: [GCP CPUS-quota alerting](feedback_gcp_quota_alerting.md); [Data Classification Ratchet gate](feedback_data_classification_ratchet.md); [reboot vs reprovision a runtime](feedback_runtime_reboot_vs_reprovision.md); [smoke flake prevention](feedback_smoke_flake_prevention.md) (ENG-864); [`.warp/` artifacts pollute git](feedback_warp_artifacts_pollute_git.md).
- Loop/agents: [CI wait loops](feedback_ci_wait_loop_monitor.md) (no foreground `sleep`); [subagent auto-notify + Monitor liveness](feedback_subagent_autonotify_and_monitor_liveness.md); [agent-bus worker-pane tool gaps](feedback_agentbus_worker_pane_tool_gaps.md); [autonomous-pane cloud MCP OAuth-gated](feedback_autonomous_pane_cloud_mcp_oauth_gated.md); [runtime claim loop = OpenClaw not agentkit](feedback_runtime_claim_loop_openclaw_not_agentkit.md); [Mixpanel Get-Business-Context ordering](feedback_mixpanel_get_business_context.md).

## Admin Dashboard Architecture
- Next.js 16 + Shadcn at `apps/admin/`, Recharts; dashboards `/dashboards/*` (Firestore via `use-dashboard-data.ts`).
- Auth: admin→web API (`VITE_WEB_APP_URL`→`/api/admin/auth/login`); `verifyAdminRequest` (`apps/web/src/lib/admin-auth/verify-admin.ts`); CORS in `cors.ts`.
- Chrome-extension prod: admin download route proxies per-env GCS `CHROME_EXTENSION_ARTIFACT_BUCKET`; built by `build-chrome-extension-prod.yml` (ENG-1359).
- [Admin/web prod deploy footguns](feedback_admin_prod_deploy_env_and_storage.md) — preview→prod image bakes build-time env wrong; read runtime.
