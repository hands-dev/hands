# BOOTSTRAP — restore the fleet on a new machine

**Runbook for Claude Code to execute** on a fresh machine. Step 0 (auth) must be done by the
human; the rest is automatable. The durable journal makes this short: coordination state
(tasks, questions, todos, priorities, history) restores from the journal repo — sessions are
disposable by design.

Placeholders: `<REPO_SSH>` = the project repo (e.g. `git@github.com:org/project.git`);
`<REPO_DIR>` = its main checkout path.

## Step 0 — HUMAN (auth)

- `gh auth login` (access to the project repo AND the journal repo). Verify: `gh auth status`.
- `claude` signed in.
- Node ≥ 22.5 on PATH: `node --version`.
- Any project-specific cloud auth.

## Step 1 — Install the plugin

```
/plugin marketplace add heymichaelp/hands
/plugin install yc@hands
```

## Step 2 — Clone the project + configure

```bash
git clone <REPO_SSH> <REPO_DIR>
cd <REPO_DIR>
hands init           # scaffold config (or restore your committed hands.config.json)
```

If `hands.config.json` is committed in the project repo, init leaves it alone — the journal
url + handle come back with the clone.

## Step 3 — Restore coordination state from the journal

```bash
cd <REPO_DIR>
hands restore        # pulls the journal repo, replays your handle's events
hands paths          # verify: agentId "expo", journalSync healthy
```

## Step 4 — Restore project memory (optional, if this repo carries a snapshot)

Claude Code project memory is keyed to the main-checkout path:

```bash
MEM=~/.claude/projects/$(echo "<REPO_DIR abs path>" | tr '/.' '--')/memory
mkdir -p "$MEM" && cp memory/*.md "$MEM/"
```

## Step 5 — Run

- Main checkout: `/hands:expo` (or `/loop /hands:expo`).
- Stations: `hands station add -n <N>` — no `git worktree` commands, ever.
- Dashboard: `hands serve` → http://localhost:4319

## Step 6 — Re-auth other MCP servers (human, as needed)

Project-specific MCP servers (Linear, Sentry, …) re-add with `claude mcp add …` + OAuth. The
hands plugin is the only piece the fleet itself needs.

---

### What does NOT carry over

- Auth (Step 0/6).
- Live station sessions — recreate with `hands station add`.
- Claude session context — by design; the books restore *state*; the expo rehydrates from
  board + tasks + priorities on its first pass.
