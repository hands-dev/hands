# BOOTSTRAP — restore the foreman/worker setup on a new laptop

**Runbook for Claude Code to execute** on a fresh Mac (Warp installed). Steps 1–7 are
automatable; **Step 0 (auth) must be done by the human** — no repo can carry credentials.
Work top to bottom; verify each step before the next.

---

## Step 0 — HUMAN must do first (auth; cannot be automated)
These establish identity the repo can't hold. Ask Michael to run each and confirm:
- `gh auth login` — GitHub (account `and-michael`). Verify: `gh auth status`.
- `claude` is signed in (the CLI you're running in). Verify: it's running.
- `gcloud auth login && gcloud auth application-default login` — for staging/prod GCP work later.
- Node 20+ present: `node --version` (install via `brew install node` or `corepack`).
Do NOT proceed to Step 1 until `gh auth status` shows `Logged in ... account and-michael`.

## Step 1 — Build the agent-bus MCP tool
```bash
cd agent-bus
npm install
npm run build          # src/ -> dist/  (dist/ is gitignored; MUST build)
npm test               # optional sanity
```
Record the absolute path: `AGENTBUS="$(cd agent-bus && pwd)"`.

## Step 2 — Register agent-bus as a user-scope MCP server
```bash
claude mcp add agent-bus --scope user -- node --no-warnings "$AGENTBUS/dist/server.js"
```
Verify: `claude mcp list` shows `agent-bus`.

## Step 3 — Install the ~/.claude config pieces
Copy the hook + statusline scripts and the skills into place:
```bash
mkdir -p ~/.claude/hooks ~/.claude/skills
cp claude-config/hooks/memory-autocommit.py ~/.claude/hooks/
cp claude-config/statusline-command.sh      ~/.claude/
chmod +x ~/.claude/statusline-command.sh
cp -R skills/foreman ~/.claude/skills/foreman
cp -R skills/worker  ~/.claude/skills/worker
```

## Step 4 — Merge settings into ~/.claude/settings.json
`claude-config/settings.reference.json` is the OLD machine's settings. Do NOT copy it
wholesale — **merge** these keys into the new machine's `~/.claude/settings.json`, fixing
the absolute node path for THIS machine (`which node` — old one was `/opt/homebrew/bin/node`):

- `hooks.PostToolUse` → `python3 ~/.claude/hooks/memory-autocommit.py`
- `hooks.Stop` → `<node> --no-warnings <AGENTBUS>/dist/server.js publish` (async, timeout 30)
- `hooks.UserPromptSubmit` → `<node> --no-warnings <AGENTBUS>/dist/server.js board` (timeout 10)
- `statusLine` → `bash ~/.claude/statusline-command.sh`
- also carry over: `theme`, `model`, `effortLevel`, `permissions.defaultMode`, `enabledPlugins`.

(No secrets are in the reference file — it's pure config. Paths are the only thing to fix.)

## Step 5 — Restore the memory store (the foreman's context)
```bash
MEM=~/.claude/projects/-Users-michaelphillips-Development-ampersand/memory
mkdir -p "$MEM"
cp memory/*.md "$MEM/"
```
154 files — this is what makes the foreman non-amnesiac (all the ENG-1449 clean-sheet
context, feedback, conventions). MEMORY.md is the index it reads each session.
NOTE: the memory path is keyed to the repo dir `/Users/<you>/Development/ampersand`.
If the new machine uses a different home/username, the dir segment changes — put the
memory under the matching `-Users-<you>-Development-ampersand/memory` path.

## Step 6 — Get the code back + the worktrees
```bash
bash resume-clean-sheet.sh        # clones theandcompany/ampersand + in-flight worktrees
```
(Needs the org access from Step 0's gh login.)

## Step 7 — Warp pane layout
`warp/ampersand-fleet-split.yaml` is the foreman+workers tab/pane layout.
```bash
mkdir -p ~/.warp/launch_configurations
cp warp/ampersand-fleet-split.yaml ~/.warp/launch_configurations/
```
Open it in Warp: Command Palette → "Launch Configuration" → ampersand-fleet-split.
⚠️ Edit the `cwd:` paths inside the yaml first if your worktree dirs differ from the
old machine's (`~/Development/ampersand`, `-worktree-N`). resume-clean-sheet.sh uses
descriptive suffixes (`-cs2-spine`, etc.) — reconcile the yaml's cwds to match, or
rename the worktrees to the old `-worktree-N` scheme.

## Step 8 — Re-auth the OTHER MCP servers (human, as needed)
The foreman/workers also use these (not in this repo — re-add + OAuth per server):
`linear`, `sentry`, `mixpanel`, `and-staging`, `and-preview`, `figma`, `context7`, `asc-mcp`, `github`.
Add with `claude mcp add ...` (see each server's docs) and complete the OAuth prompts.
agent-bus (Step 2) is the only one REQUIRED for the foreman/worker loop itself; the
rest are for the actual engineering work.

## Step 9 — Run it
- Main checkout pane: `/foreman` (or `/loop /foreman`).
- Each worktree pane: `/loop /worker`.
- Dashboard: `cd agent-bus && npm run dashboard` → http://localhost:4319
- Confirm the bus works: the peer/board status line should appear on your next prompt,
  and `agent_bus_priorities` should return the seeded list (Step: `cp coordination/priorities.example.md ~/.claude/coordination/priorities.md`).

---
### What could NOT be carried (do fresh)
- **All auth** (gh, claude, gcloud, every OAuth MCP) — Step 0 + Step 8.
- **Live runtime message data** (`agent-bus.db`, `*.notify`) — regenerated on first run.
- **The worker panes' running sessions** — you restart them with `/loop /worker`.

### Where the work stands (from memory/project_clean_sheet_fleet_host_image.md)
POC validated end-to-end (real gpt-5.5 turn served on the clean-sheet overlay). Next:
CS2 (on `feat/eng-1450-ephemeral-checkout-fs`) needs `/code-review high` → merge; ref-gate
PR #2386 merge → re-enable staging-deploy-orchestrator → whole-pool destructive reprovision
→ your staging &tag chat lands on a clean-sheet host.
