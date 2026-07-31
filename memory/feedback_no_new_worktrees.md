---
name: feedback_no_new_worktrees
description: "The session's working dir is already a git worktree — do NOT create new worktrees; work in the existing one"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fc2ba994-82af-48e7-b06f-1761486f9af4
---

The session's primary working directory (e.g. `/Users/michaelphillips/Development/ampersand-worktree-2`) is **already a git worktree**. Do **NOT** spin up new worktrees per task (`git worktree add …`) — Michael flagged the proliferation (ampersand-pyk, ampersand-observed, ampersand-ui-cleanup were all unwanted).

**Why:** each new worktree needs its own `pnpm install` (slow, disk) and clutters `/Development`; the existing worktree already has deps and is where work should happen.

**How to apply:** to work on a different branch, switch branches **in the existing worktree** (`git switch`/`checkout -b`), honoring the [[git-operations]] branch-boundary rule (summarize + reset context before switching). Reuse the already-checked-out sibling worktrees (`git worktree list`) if one is already on the branch you need. Only create a worktree if the user explicitly asks. `gh`/Linear API operations (PR create/merge, tags) don't depend on which worktree you're in — run them from the current one.
