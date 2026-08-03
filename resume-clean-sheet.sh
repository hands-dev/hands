#!/usr/bin/env bash
# resume-clean-sheet.sh — restore a project clone + its in-flight branch worktrees on a fresh machine.
#
#   REPO_SSH=git@github.com:you/yourrepo.git bash resume-clean-sheet.sh [BASE_DIR]
#
# BASE_DIR defaults to ~/Development. Creates BASE_DIR/<repo> (main clone) and a parallel worktree
# per branch listed in WORKTREES below. Edit REPO_* and WORKTREES for your project — the defaults
# document the original (theandcompany/ampersand clean-sheet) usage as an example.
set -euo pipefail

BASE="${1:-$HOME/Development}"
REPO_SSH="${REPO_SSH:-git@github.com:theandcompany/ampersand.git}"
REPO_HTTPS="${REPO_HTTPS:-https://github.com/theandcompany/ampersand.git}"
REPO_NAME="$(basename "${REPO_SSH%.git}")"
MAIN="$BASE/$REPO_NAME"

# branch<TAB>worktree-dir-suffix — one line per in-flight branch to restore (edit me)
WORKTREES="${WORKTREES:-feat/eng-1450-ephemeral-checkout-fs	cs2-spine
feat/eng-1449-ws4-rollout-harness	ws4-harness
eng1449-fleet-host-image-module-extraction	image-module
eng1441-staging-tf-ref-gate	ref-gate}"

mkdir -p "$BASE"

# 1. Clone (SSH first, fall back to HTTPS) or reuse an existing clone.
if [ ! -d "$MAIN/.git" ]; then
  echo "==> cloning $REPO_NAME into $MAIN"
  git clone "$REPO_SSH" "$MAIN" 2>/dev/null || git clone "$REPO_HTTPS" "$MAIN"
else
  echo "==> reusing existing clone at $MAIN"
fi

cd "$MAIN"
echo "==> fetching all branches"
git fetch origin --prune

# 2. Recreate worktrees for the in-flight branches.
add_wt() {
  local branch="$1" dir="$BASE/$REPO_NAME-$2"
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
while IFS="$(printf '\t')" read -r branch suffix; do
  [ -n "$branch" ] && add_wt "$branch" "$suffix"
done <<EOF
$WORKTREES
EOF

# 3. Install deps if the repo uses pnpm.
if [ -f "$MAIN/pnpm-lock.yaml" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    echo "==> pnpm install (root)"
    (cd "$MAIN" && pnpm install)
  else
    echo "!! pnpm not found — install it (corepack enable && corepack prepare pnpm@latest) then run: pnpm install"
  fi
fi

cat <<DONE

============================================================
 Resumed. Main clone: $MAIN, plus one $REPO_NAME-<suffix>/
 worktree per branch listed in WORKTREES.

 The foreman/worker orchestration is separate — set it up with:
   cd $MAIN && node path/to/agent-bus-workflow/agent-bus/dist/cli.js init
 (see SETUP.md). You do NOT need it to work on the code.
============================================================
DONE
