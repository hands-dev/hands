---
name: feedback_runtime_reboot_vs_reprovision
description: "Recovering a wedged/stale hosted-runtime VM: a reboot (`gcloud compute instances reset`) preserves the disk — OpenClaw session, cached MCP tool list, and provision-time USER.md all survive, so a poison-loop resumes and stale tool descriptions persist. The reliable fix is operator reprovision (fresh filesystem)."
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-30
  written: 2026-07-30
  originSessionId: 7b873103-83a1-4ead-bd48-645f0023d07c
---

Generalized recovery recipe (recurred in a prod incident AND a staging test):
**rebooting a hosted-runtime VM is not enough.** `gcloud compute instances reset`
keeps the same disk, so the OpenClaw session, the cached MCP tool list, and the
provision-time `USER.md` all survive the reboot — a wedged worker resumes its
poison-message loop, and a stale runtime keeps serving the OLD MCP tool
descriptions.

The reliable fix is the **operator reprovision** endpoint
(`POST /v1/runtimes/cohort/reprovision` with the `runtime-reprovision-operator-token`,
scoped to the single runtime id): it revokes the old runtime and mints a fresh VM
with a **new filesystem** — regenerated `USER.md`, no old session, freshly-fetched
tools (verified: `USER.md` regenerated, old session gone, new `ask_question`
description present). See [[project_incident_runtime_poison_birth_wedge]] for the
prod poison-birth mechanics and the exact request shape.

**Why:** reboot looks like the obvious recovery but silently preserves the exact
state you're trying to clear.
**How to apply:** for a wedged worker OR a runtime serving stale tools, reprovision
(fresh FS) — don't reset the VM.
