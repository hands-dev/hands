---
name: feedback_ci_wait_loop_monitor
description: "Waiting on CI/deploys — foreground `sleep N` is blocked (use a Monitor until-loop or run_in_background), and long blocking poll loops hit the 2-minute Bash timeout"
metadata: 
  node_type: memory
  type: feedback
  sourceDream: 2026-07-29
  sourceRun: 2026-07-29-1335
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

When waiting for CI checks or a deploy to finish, a foreground `sleep N` inside a Bash call is **blocked by the harness** (`Blocked: sleep 60 followed by: gh pr checks …`), and a long blocking poll loop also trips the **2-minute Bash timeout** (`Command timed out after 2m 0s`, exit 143).

Use a **Monitor until-loop** (or `run_in_background`) to wait on the condition instead of sleeping in the foreground. Pairs with the `status` read-only var gotcha in [[feedback_local_shell_env_gotchas]] (poll loops must not assign to a variable named `status`).

**Why:** the harness blocks foreground sleeps and caps Bash at 2 minutes, so naive polling loops fail.
**How to apply:** wait via Monitor with an until-condition (or `run_in_background`), never `sleep N && <check>` in the foreground.
