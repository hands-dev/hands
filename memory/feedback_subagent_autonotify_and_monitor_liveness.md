---
name: feedback_subagent_autonotify_and_monitor_liveness
description: "Launched Agents/Tasks auto-notify on completion (yield, don't sleep-poll); Monitors don't appear in TaskList (check liveness with pgrep, not TaskList); deferred tools need ToolSearch first"
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-31
  sourceBranch: feature/eng-1064
  written: 2026-07-31
  originSessionId: 59d62976-f144-4600-b3ce-a7895be41e42
---

Waiting on async work has three recurring traps distinct from the CI-poll case in [[feedback_ci_wait_loop_monitor]]:

- **A launched Agent (subagent) or background Task auto-notifies you the instant it finishes** — its completion wakes you. The correct move is to **yield / STOP (or do other work), not poll.** A foreground `sleep N` to "wait for it" is blocked by the harness and wastes turns.
- **Monitors do NOT appear in `TaskList`** (that lists the TaskCreate system). A "check TaskList before arming my Monitor" guard always reads empty and **double-arms**. Verify a Monitor is alive with `pgrep -fl "tail -F -n0 .*wtN.notify"`, not TaskList. A TaskList that momentarily reads empty is NOT proof the Monitor dropped — the Monitor that just delivered a notification is by definition alive.
- **Deferred tools (e.g. `Monitor`) need their schema loaded via `ToolSearch` first** — calling with guessed params fails with "This tool's schema was not sent." But for subagent/explore waits a Monitor is usually unnecessary at all (auto-notify covers it).

**Why:** poll-sleeping on work that already auto-notifies, or double-arming a Monitor because TaskList reads empty, silently burns turns and stacks duplicate watchers.
**How to apply:** yield after launching an Agent/Task; check Monitor liveness with `pgrep`, never TaskList; load a deferred tool's schema via ToolSearch before the first call.
