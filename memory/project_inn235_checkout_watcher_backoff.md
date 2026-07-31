---
name: project_inn235_checkout_watcher_backoff
description: INN-235 fleet checkout-watcher cold-boot backoff MERGED to staging; INN-236 tracks the 30-min runtime root cause
metadata: 
  node_type: memory
  type: project
  originSessionId: d44de867-1f15-4884-b60f-1ee1c7024563
---

INN-235: fleet-host `ampersand-fleet-checkout-watcher` burned a full CPU core for ~30 min on cold boot. Root cause (NOT a crash loop despite the ticket title): it's a `Type=oneshot` service re-armed by a systemd timer with `OnUnitInactiveSec=1s`; every exit in `checkout_executor.py`'s `watch_once` routed through the escalating no-work backoff (`NO_WORK_BACKOFF_SECONDS = 2,4,8,16,30`) EXCEPT the two readiness `fail("executor_not_ready")` paths, which exited status=2 immediately → the 1s re-arm re-fired the ~19s/full-core chat model-access probe every ~20s.

Fix (PR #2326, squash `02a23fd1`, MERGED to staging 2026-07-30): both not-ready sites now back off + `return` (exit 0); `INVALIDARGUMENT`/exit-2 reserved for genuine misconfig. Added chat-scoped journald observability: `watcher_not_ready` (reason=runtime|capability + delay) and once-per-flap `watcher_chat_ready` (boot_seconds = time-to-ready, via `/proc/uptime` + a `/run` marker). Timer kept at 1s deliberately (backoff is in-process; don't slow INN-227's warm long-poll). 259/259 runner tests pass.

Two non-obvious things:
- **Fleet-host runner Python tests are NOT in CI** — only Terraform validate covers `apps/infra/modules/openclaw-fleet-host/`. `python3.12 -m unittest tests.test_checkout_executor` (from the `runner/` dir) is local-only. Consider a follow-up CI job gated on that path.
- **Merging does NOT patch live fleet hosts** — this is base64-embedded in the instance-template startup script; existing hosts get it only on next image roll / reprovision. See [[reference_fleet_runner_rollout_and_staging_api_build_skip]] and the "Hosted Runtime Software Updates" CLAUDE.md rule.

Follow-up: **INN-236** (High, Backlog, related-not-child to avoid the [[feedback_linear_subissue_cascade]] auto-complete). **ROOT CAUSE FOUND 2026-07-30 (staging journald investigation): it is NOT slow runtime bring-up.** The openclaw gateway is ready in ~2 min (host 3v9b1: boot 00:40:49 → gateway active/ready 00:42:39, 30s before first `executor_not_ready`). The ~30-min block is the chat model-access preflight (`openclaw models status --check --probe`) failing because the configured model `openai/gpt-5.5` runs via a **Codex subscription that hit its usage limit** → `reason=rate_limit window=cooldown`, `next=none` (no fallback). The ~30 min = the Codex cooldown, and the storm cleared the instant the cooldown did (00:43:02→01:11:36). The pre-fix probe was a **real billable completion** fired every ~20s/host against the shared Codex pool — likely self-inflicting the rate limit, so INN-235's backoff is a partial mitigation of INN-236, not just a CPU fix. Fix directions: dedicated capacity / API-key billing vs shared subscription; configure a fallback model (`next=none`); make the readiness probe non-billable / fleet-shared; treat `rate_limit` distinctly (longer backoff, don't invalidate the positive cache on a throttle). Related: [[project_fleet_claim_longpoll_probecache]] (INN-227). How-to: serial via `gcloud compute instances get-serial-port-output`, host journald via `gcloud compute ssh ... --tunnel-through-iap` → `journalctl -u ampersand-fleet-openclaw-gateway.service`.

**Distinct root cause, same symptom family:** the `bind_failed` pool-drain where a fleet andee is stuck at "Set up agent" with ZERO active runtime rows is NOT this CPU/model-probe issue — it's the runtime-anchor gap in [[project_fleet_chat_runtime_anchor_gap]] (no fleet-path `agent_runtimes` minter). Debug both via [[reference_staging_fleet_debug]].
