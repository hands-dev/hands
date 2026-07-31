#!/usr/bin/env bash
# resume-clean-sheet.sh — get back to the clean-sheet fleet-host work on a fresh laptop.
# Run on the OTHER laptop (needs: git + access to the theandcompany GitHub org).
#
#   bash resume-clean-sheet.sh [BASE_DIR]
#
# BASE_DIR defaults to ~/Development. Creates BASE_DIR/ampersand (main clone) +
# parallel worktrees for the in-flight branches, matching the foreman/worker layout.
set -euo pipefail

BASE="${1:-$HOME/Development}"
REPO_SSH="git@github.com:theandcompany/ampersand.git"
REPO_HTTPS="https://github.com/theandcompany/ampersand.git"
MAIN="$BASE/ampersand"

mkdir -p "$BASE"

# 1. Clone (SSH first, fall back to HTTPS) or reuse an existing clone.
if [ ! -d "$MAIN/.git" ]; then
  echo "==> cloning ampersand into $MAIN"
  git clone "$REPO_SSH" "$MAIN" 2>/dev/null || git clone "$REPO_HTTPS" "$MAIN"
else
  echo "==> reusing existing clone at $MAIN"
fi

cd "$MAIN"
echo "==> fetching all branches"
git fetch origin --prune

# 2. Recreate worktrees for the in-flight clean-sheet branches.
#    branch  ->  worktree dir suffix
add_wt() {
  local branch="$1" dir="$BASE/ampersand-$2"
  if git worktree list --porcelain | grep -q "branch refs/heads/$branch"; then
    echo "    (worktree for $branch already exists)"
  elif [ -e "$dir" ]; then
    echo "    (dir $dir already exists — skipping)"
  else
    echo "==> worktree: $branch  ->  $dir"
    git worktree add "$dir" "$branch"
  fi
}

echo "==> setting up in-flight worktrees"
add_wt feat/eng-1450-ephemeral-checkout-fs          cs2-spine        # C.J. — CS2 / Pillar-A (the critical branch)
add_wt feat/eng-1449-ws4-rollout-harness            ws4-harness      # Sam — canary/isolation harness
add_wt eng1449-fleet-host-image-module-extraction   image-module     # Toby — Shape-B versioned-image module
add_wt eng1441-staging-tf-ref-gate                  ref-gate         # ref-gate (PR #2386)

# 3. Install root deps so the app runs (pnpm monorepo).
if command -v pnpm >/dev/null 2>&1; then
  echo "==> pnpm install (root)"
  (cd "$MAIN" && pnpm install)
else
  echo "!! pnpm not found — install it (corepack enable && corepack prepare pnpm@latest) then run: pnpm install"
fi

cat <<'DONE'

============================================================
 Resumed. Layout under BASE_DIR:
   ampersand/               main clone (staging tip)
   ampersand-cs2-spine/     feat/eng-1450  <- THE critical in-flight branch (CS2 mid-assembly)
   ampersand-ws4-harness/   feat/eng-1449-ws4-rollout-harness
   ampersand-image-module/  eng1449-fleet-host-image-module-extraction
   ampersand-ref-gate/      eng1441-staging-tf-ref-gate  (PR #2386)

 Run the app / dev stack from the main clone: see CONTRIBUTING.md
   (pnpm dev — Web :3001, App :3003, Admin :3002).

 NOT in this repo (they live in ~/.claude on the old laptop):
   - foreman/worker skills: ~/.claude/skills/{foreman,worker}
   - agent-bus coordination: ~/.claude/coordination/  (priorities, todos, agent-bus.db)
   Copy those over separately only if you want the multi-pane orchestration back.
   You do NOT need them to work on the code.
============================================================
DONE
