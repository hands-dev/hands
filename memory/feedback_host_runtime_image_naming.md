---
name: host-runtime-image-naming
description: "Fleet-host upgrade lanes are named \"Host images\" and \"Runtime images\" in all copy; keep OTA/boot/manifest jargon out."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6642906b-371e-4789-b088-43112a05d247
---

Fleet hosts have **two upgrade lanes**; name them consistently everywhere (UI copy, labels, docs):

- **Host image** — what a *new* fleet host starts with (cold-boot / GCE instance-template lane).
  Version stamp `flh-<openclaw>-b<digest>`; reported as `fleet_hosts.image_version`. Carries
  everything baked at boot (base image, node, openclaw, runner, the stager, policy, startup script).
  Changed via a destructive Terraform apply that reprovisions hosts.
- **Runtime image** — swapped onto a *running* host in place. Version stamp `ocr-<version>-<hash8>`;
  reported as `fleet_hosts.runtime_manifest_version` (+ `staged_manifest_version` mid-flight).
  Carries engine + runner/skills/policy archives. Changed via a signed desired-release manifest push.

**Why:** the two lanes were repeatedly conflated (see `docs/infrastructure/fleet-host-upgrade-runbook.md`),
and the product owner standardized the admin **Fleet Host Images** dashboard on this vocabulary
(ENG-1390, PR #2341/#2343).

**How to apply:** In any user-facing text use "Host image(s)" / "Runtime image(s)". Do NOT surface
implementation terms — **no "OTA", "boot baseline", "boot image", "OTA manifest", "cold-boot",
"desired-release", or "`fleet_upgrade`"** in copy; they're mechanism, not the concept. Say "current"
(not "target") for the active one. Internal code identifiers (`kind: 'boot-baseline' | 'runtime-manifest'`,
`fleet_host_desired_release`, the `fleet_upgrade` task) keep their existing names — this is about
displayed naming. Prefer this same split in new fleet-host tooling and docs. Related: [[reference_staging_fleet_debug]].
