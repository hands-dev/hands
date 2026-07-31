---
name: reference_hosted_runtime_machine_type_cost
description: "Hosted-runtime VM sizing + cost: dedicated agent runtimes AND fleet hosts share one machine-type knob (e2-standard-2, ~$50/mo each); bumped from e2-small (~$14/mo) on 2026-07-10 for an 8GB OOM floor. Spot math + why the $14-vs-$50 confusion."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 0ee1a26f-3205-407d-ab1f-29c9b9c19ce2
---

**Dedicated agent runtimes and fungible fleet hosts are the SAME VM shape**, driven by one shared Terraform local `openclaw_runtime_fleet_machine_type = "e2-standard-2"` (both the dedicated `openclaw_runtime_fleet` template AND the fungible fleet template read it, in `apps/infra/environments/{staging,production}/main.tf`; module default in `apps/infra/modules/openclaw-runtime/variables.tf`). So a dedicated runtime and a fleet host cost the same.

**Cost per host (e2-standard-2, us-central1, on-demand/STANDARD, 20GB pd-balanced, IAP-only no external IP):** ~$48.91 compute (0.067006/hr × 730) + $2.00 disk = **~$50.90/mo**. Spot (`provisioningModel=SPOT`) ≈ $0.0201/hr compute → ~$14.67 + $2 disk = **~$16.67/mo** (~67% off total; disk not discounted). E2 gets NO sustained-use discount.

**The $14-vs-$50 confusion:** dedicated runtimes USED to be `e2-small` (2 vCPU burstable, 2GB RAM) ≈ **$14.23/mo** — that's the remembered number. Commit `2a71b77e` "feat(runtime): add memory containment guardrails (#2044)" on **2026-07-10** bumped e2-small→e2-standard-2 for ALL hosted runtimes to enforce an **8 GB memory floor** (agents were OOM-ing at 2GB). Added a hard TF validation: "Production hosted runtime factory must use e2-standard-2 as the 8 GB floor." Evidence still visible: the 2 oldest prod dedicated VMs (June, pre-bump) are still e2-small; everything from ~2026-07-17 on is e2-standard-2. So the perceived "fleet is 4× dedicated" is a false compare — it's today's fleet ($50) vs. a pre-July-10 dedicated runtime ($14); today's dedicated runtimes are also ~$50.

**Pool sizes (as of 2026-07-29):** staging fleet `FLEET_HOST_READY_TARGET=2` / max 4 (~$102/mo steady); prod fleet target 10 / max 20 (~$509/mo steady, ~$1,018 peak). Prod ALSO runs ~55 dedicated e2-standard-2 runtimes (~$2.7k/mo, all RUNNING, some 6+ weeks old). The fleet-checkout architecture (INN-193/195/219) exists to retire those always-on dedicated VMs and amortize ~10 shared hosts across many andees.

**Downsizing caveat:** can't just revert to e2-small — the 8GB floor is a deliberate OOM guardrail with TF validation. Options are a custom 2-vCPU/lower-RAM shape (after fixing memory footprint) or Spot (keeps 8GB, ~70% off compute) — see the Spot tradeoffs (preemption vs. checkout-fence/poison-loop recovery) in [[reference_fleet_host_capability_provisioning]]. Related: [[project_eng_cost_cleanup]], [[reference_staging_gcp_access]], [[reference_gcp_projects]].
