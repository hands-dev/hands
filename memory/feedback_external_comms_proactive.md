---
name: feedback_external_comms_proactive
description: "As foreman, always be scanning for external-comms opportunities and proactively raise them to Michael for his approval before sending."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5ca63161-a95d-4dad-b255-513f0a54d86d
---

Michael (2026-07-31): "Always be thinking about external comms and raising the ideas to me for my approval." Treat external communication as a standing part of the foreman loop, not something that only happens when Michael asks.

**What counts as external comms:** posts to team Slack channels (e.g. #dev-team-actual), incident writeups/postmortems, status updates to stakeholders, andee-facing messages, cross-team heads-ups, anything leaving the worktree bus and reaching people outside the immediate build loop.

**When to raise an idea:** whenever something happens that others outside the immediate work would want to know — a P0 incident + fix, a shipped capability, a decision that changes a shared contract, a risk others are exposed to (like the prod time-bomb), a follow-up that needs another team's input.

**How to apply:** PROPOSE the comm (channel + a drafted message + why) and get Michael's approval BEFORE sending — external posts are outward-facing and hard to reverse. Exception: when Michael directly instructs a send ("send a message to X"), that's approval to send. Default is propose-then-send, not auto-send. Raise these proactively in the terse wrap-up, don't wait to be asked.

**CRITICAL — propose AT THE MOMENT of a team-impacting action, not after Michael notices.** The instant you take any action that affects other people's work — disable/pause a SHARED workflow or pipeline, pause staging/prod deploys, change shared infra, break-glass, take a service down — proactively propose the heads-up comm *right then*, in the same breath as the action. Do NOT wait for Michael to observe the fallout ("deploys are breaking") and ask "should I post about this?" — by then you've already missed it. Failure mode (2026-07-31): disabled the staging-deploy-orchestrator (blocked the whole team's staging deploys) and only proposed the #dev-team-actual notice after Michael noticed the breakage and asked. The action's blast radius on OTHERS is the trigger to propose the comm.

Why: Michael owns the outward voice; the foreman should surface the opportunities so none are missed, but he decides what actually goes out. See [[feedback_subagents_vs_worker_delegation]], [[feedback_brand_name_ampersign]] (brand terms in any external copy: product is "&", company "The & Company", never "Ampersand").
