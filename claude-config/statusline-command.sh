#!/usr/bin/env bash
# Claude Code status line — minimal. Directory / branch / diff-summary are
# intentionally omitted (the pane's agent name from `claude -n` already
# identifies it). The only thing this surfaces is an actionable drift nudge:
# how many commits this branch is BEHIND origin/staging (i.e. needs a rebase).
# Prints nothing when in sync.
input=$(cat)
cwd=$(echo "$input" | jq -r '.cwd // empty')
session=$(echo "$input" | jq -r '.session_id // "default"')
[ -z "$cwd" ] && exit 0

branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -z "$branch" ] && exit 0
upstream=$(git -C "$cwd" rev-parse --abbrev-ref "${branch}@{upstream}" 2>/dev/null)
[ -z "$upstream" ] && exit 0
base=$(echo "$upstream" | sed 's|^origin/||')

# Cached fetch — refresh upstream every 30s in the background
cache_file="/tmp/cc-statusline-fetch-${session}"
now=$(date +%s)
last_fetch=0
[ -f "$cache_file" ] && last_fetch=$(cat "$cache_file")
if [ $((now - last_fetch)) -ge 30 ]; then
  echo "$now" > "$cache_file"
  git -C "$cwd" fetch --no-write-fetch-head --no-tags origin "$base" 2>/dev/null &
  disown 2>/dev/null
fi

behind=$(git -C "$cwd" rev-list --count "HEAD..${upstream}" 2>/dev/null || echo 0)
[ "$behind" -gt 0 ] && printf "↓%s behind %s" "$behind" "$base"
