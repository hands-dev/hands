---
name: project_fleet_host_bootlog_ops_agent_gap
description: Fleet-host boot/onboard logs never reach Cloud Logging (no ops-agent); fix rides the template lane; prod omits FLEET_HOST_DESIRED_IMAGE_VERSION
metadata: 
  node_type: memory
  type: project
  originSessionId: 9bffabc8-0525-43ea-a80c-f88f20253683
---

Why a dead-on-boot fungible fleet host requires SSH/serial to diagnose (ENG-1132/ENG-1448), diagnosed on task 73 (2026-07-31). Extends [[project_staging_observability_gaps]].

- **No logging agent installed anywhere** — repo-wide grep for ops-agent/google-cloud-ops-agent/fluent-bit/google-fluentd = 0 hits; both fleet-host + runtime templates boot stock Ubuntu (`apps/infra/environments/production/main.tf:1212`). Agent ABSENT, not misconfigured.
- **Fleet-host startup script → serial only**: `apps/infra/modules/openclaw-fleet-host/templates/startup-fleet-host.sh.tftpl` has NO output redirection, so every `BOOTSTRAP_STAGE` line + the terminal `AMPERSAND_FLEET_BOOTSTRAP_ERROR <stage> <code>` (:159-160) and the inline `openclaw onboard && openclaw models set` (:398-424, the #2347 death point) go to the metadata-script stdout → serial. And `serial-port-enable="FALSE"` (main.tf:1227) → serial isn't even retained. systemd units (gateway/watcher/heartbeat/stager) default to journald (local). Fleet-host is worse than the runtime module, which at least tees to file+journald (`startup-openclaw-runtime.sh.tftpl:14` — the reusable `exec > >(tee -a $LOG | logger -t …) 2>&1` idiom).
- **No IAM work needed**: the fleet SA already holds `roles/logging.logWriter` (main.tf:1007-1013) + cloud-platform scope (:1219-1222); the role was provisioned for an agent never installed. An Ops Agent dropped on the host ships immediately.
- **Fix = template lane, additive**: add the tee/logger redirect + a FAIL-OPEN `opsAgentInstall` bootstrap stage + a net-new `/etc/google-cloud-ops-agent/config.yaml` (systemd_journald receiver, labels image_version/host/stage). Then canary-boot-verify = a `gcloud logging read` by image_version+stage, not an SSH. An OTA (`ocr-` lane) CANNOT deliver it (baked at boot) — see [[feedback_host_runtime_image_naming]] / `docs/infrastructure/fleet-host-upgrade-runbook.md`. Only verifiable by a real canary cold-boot; best folded into a swap/template roll rather than a standalone reprovision.
- **PROD FOOTGUN**: staging sets `FLEET_HOST_DESIRED_IMAGE_VERSION` (`staging/main.tf:1380`) so it auto-drains image_version-mismatched hosts to the new template; **production OMITS it** (`production/main.tf:1348-1358`) → a new prod template only reaches NEWLY-created hosts unless you wire that env like staging or force the destructive template replace. Consumed by `fleet-host-provisioner.ts:87,160-215`.
