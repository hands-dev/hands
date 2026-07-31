#!/usr/bin/env python3
"""
memory-autocommit hook  (PostToolUse: Write|Edit|MultiEdit)

Deterministic guardrails for the file-system memory store, per the
context-engineering talk:
  * VERSIONING   - every write becomes one git commit -> full history + rollback
  * PROVENANCE   - commit trailers record branch, session, tier, timestamp
  * CONCURRENCY  - a lock-retry loop + atomic per-write commits let many
                   worktrees share one store without clobbering each other
  * PERMISSION   - curated-tier writes are tagged [curated] so they are easy
                   to audit/revert; learned/scratch writes pass silently

Reads the PostToolUse JSON payload on stdin. Never blocks the session:
exits 0 no matter what. Only acts when the edited file lives under the
memory store; otherwise returns immediately.
"""
import json
import os
import subprocess
import sys
import time

MEM = os.path.expanduser(
    "~/.claude/projects/-Users-michaelphillips-Development-ampersand/memory"
)

# type -> tier (talk's permission tiers). curated = durable truth (audit on
# change); learned = accrued from experience; scratch handled by subdir.
CURATED_TYPES = {"reference", "user"}


def read_payload():
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def git(args, cwd):
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=20
    )


def frontmatter_type(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            head = f.read(1500)
    except Exception:
        return None
    for line in head.splitlines():
        s = line.strip()
        if s.startswith("type:"):
            return s.split(":", 1)[1].strip()
    return None


def branch_of(cwd):
    if not cwd or not os.path.isdir(cwd):
        return "unknown"
    r = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
    return r.stdout.strip() or "unknown" if r.returncode == 0 else "unknown"


def main():
    payload = read_payload()
    tool_input = payload.get("tool_input") or {}
    path = tool_input.get("file_path") or tool_input.get("path")
    if not path:
        return
    path = os.path.abspath(path)
    # Only act on writes inside the memory store, and never on the .git dir.
    if not path.startswith(MEM + os.sep) or "/.git/" in path:
        return
    if not os.path.isdir(os.path.join(MEM, ".git")):
        return

    mem_type = frontmatter_type(path) or "?"
    tier = "curated" if mem_type in CURATED_TYPES else "learned"
    if "/scratch/" in path:
        tier = "scratch"
    branch = branch_of(payload.get("cwd", ""))
    session = (payload.get("session_id") or "")[:8] or "unknown"
    rel = os.path.relpath(path, MEM)

    curated_tag = " [curated]" if tier == "curated" else ""
    msg = (
        f"memory: {rel}{curated_tag}\n\n"
        f"Provenance-Branch: {branch}\n"
        f"Provenance-Session: {session}\n"
        f"Provenance-Tier: {tier}\n"
        f"Provenance-Tool: {payload.get('tool_name', '?')}\n"
        f"Provenance-Epoch: {int(time.time())}\n"
    )

    # Concurrency: retry through a peer worktree's index.lock.
    for attempt in range(6):
        add = git(["add", "-A"], MEM)
        if add.returncode != 0 and "index.lock" in (add.stderr or ""):
            time.sleep(0.25 * (attempt + 1))
            continue
        # Nothing staged (e.g. no net change) -> done.
        if git(["diff", "--cached", "--quiet"], MEM).returncode == 0:
            return
        c = git(["commit", "-q", "-m", msg], MEM)
        if c.returncode == 0:
            return
        if "index.lock" in (c.stderr or ""):
            time.sleep(0.25 * (attempt + 1))
            continue
        return  # some other git error -> give up silently, never block


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
