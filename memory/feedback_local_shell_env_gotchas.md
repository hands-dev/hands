---
name: feedback_local_shell_env_gotchas
description: "Local shell gotchas — zsh aborts on unmatched globs, macOS BSD sed/bash3.2 lack GNU features, Bash cwd persists across calls"
metadata: 
  node_type: memory
  type: feedback
  sourceDream: 2026-07-29
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

This machine's shell is **zsh** with **macOS BSD** tools and **bash 3.2** as the bash fallback:

- **zsh unmatched glob aborts the whole command** with `no matches found` (not an empty expansion like bash). Quote any path containing `[]`/glob chars — Expo routes like `apps/mobile/app/andee-profile/[id].tsx`, wildcards like `/Downloads/*/`, `.prettierrc*`.
- **No bash associative arrays** (`declare -A` → `bad substitution`) and **no `mapfile`** (bash 3.2). Use a `while IFS= read -r` loop instead of `mapfile`.
- **`status` is a read-only variable in zsh** — poll/monitor loops that assign to a var named `status` fail with `read-only variable: status`. Use a different variable name in wait loops (see [[feedback_ci_wait_loop_monitor]]).
- **BSD `sed` ignores `\b` word boundaries** — token renames appear to succeed but silently don't replace. Use `perl -pi -e` for regex renames — but note perl interpolates `${...}` in the replacement, which eats template literals like `${TASK_A}` (escape or use single-quoted `\Q…\E`).
- **Bash cwd behavior differs by thread.** In interactive sessions cwd **persists** across tool calls, so a relative `cd apps/...` fails after a prior command left cwd elsewhere. In **agent/subagent threads the cwd is RESET between Bash calls**, so `cd subdir && …` fails with `no such file or directory` (or silently runs in the wrong dir and swallows a type-check). Either way the remedy is the same: **use absolute paths in every Bash call.**
- **`timeout` is not installed on this macOS machine.** Wrapping a probe in `timeout NN …` (e.g. `timeout 30 gcloud compute ssh …`) fails outright with `command not found`. Drop it and rely on the underlying tool's own timeout — `gcloud`/`ssh` have their own connection timeouts. (Confirmed twice across sessions.)

**Why:** each of these fails silently or aborts unexpectedly, and the failure looks like a code/edit bug rather than a shell-portability issue.
**How to apply:** quote glob-y paths, avoid `mapfile`/`declare -A`, use `perl` (not BSD `sed`) for `\b` renames, prefer absolute paths in every Bash call, and don't wrap commands in `timeout` (not on macOS).
