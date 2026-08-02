# BOOTSTRAP — restore the foreman/worker setup on a new machine

**Runbook for Claude Code to execute** on a fresh Mac. Steps 1–5 are automatable; **Step 0 (auth)
must be done by the human** — no repo can carry credentials. Work top to bottom; verify each step
before the next.

Placeholders (fill for your setup — the old machine's values are in the examples):

- `<REPO_SSH>` — the project repo you're orchestrating (e.g. `git@github.com:theandcompany/ampersand.git`)
- `<REPO_DIR>` — where its main checkout lives (e.g. `~/Development/ampersand`)
- `<PRINCIPAL>` — the human the foreman reports to (e.g. `Michael`)

## Step 0 — HUMAN must do first (auth; cannot be automated)

These establish identity the repo can't hold. Ask the principal to run each and confirm:

- `gh auth login` — GitHub, with access to the project repo. Verify: `gh auth status`.
- `claude` is signed in (the CLI you're running in). Verify: it's running.
- Any cloud auth the project's actual work needs (e.g. `gcloud auth login`).
- Node ≥ 22.5 present: `node --version` (`brew install node`).

## Step 1 — Clone the repos

```bash
git clone <this agent-bus-workflow repo>          # the mechanism
git clone <REPO_SSH> <REPO_DIR>                   # the project to orchestrate
bash resume-clean-sheet.sh                        # optional: restore in-flight branches (edit its vars first)
```

## Step 2 — One-command install

```bash
cd agent-bus-workflow/agent-bus && npm install && npm run build
cd <REPO_DIR>
node path/to/agent-bus-workflow/agent-bus/dist/cli.js init --principal "<PRINCIPAL>"
```

`init` registers the MCP server (user scope, `~/.claude.json`), merges the two hooks into
`~/.claude/settings.json` (`Stop → publish`, `UserPromptSubmit → board`), scaffolds
`agent-bus.config.json` in the repo root, and renders + installs the `/foreman` + `/worker` skills.
Verify: `claude mcp list` shows `agent-bus`, and `node …/dist/server.js paths` (from `<REPO_DIR>`)
prints `agentId: "foreman"` with a per-repo coordination dir.

Also install the optional extras from this repo:

```bash
mkdir -p ~/.claude/hooks
cp claude-config/hooks/memory-autocommit.py ~/.claude/hooks/       # memory auto-commit (PostToolUse)
cp claude-config/statusline-command.sh ~/.claude/ && chmod +x ~/.claude/statusline-command.sh
```

(`claude-config/settings.reference.json` shows where those wire into `~/.claude/settings.json` —
merge the `PostToolUse` + `statusLine` keys and carry over `theme`/`model`/`effortLevel` to taste.
Fix the `ABS_PATH…` placeholders it uses.)

## Step 3 — Restore the memory store (the foreman's context)

Project memory is keyed to the repo's main-checkout path:

```bash
MEM=~/.claude/projects/$(echo "<REPO_DIR abs path>" | tr '/.' '--')/memory
mkdir -p "$MEM"
cp memory/*.md "$MEM/"        # if this repo carries a memory snapshot
```

(The bus derives the same path automatically — `memoryDir` in `agent-bus/src/memory.ts` — so memory
journaling works as soon as the files are in place. MEMORY.md is the index read each session.)

## Step 4 — Seed priorities (optional)

```bash
cp coordination/priorities.example.md "$(cd <REPO_DIR> && node …/dist/server.js paths | jq -r .coordinationDir)/priorities.md"
```

## Step 5 — Run it

- Main checkout pane: `/foreman` (or `/loop /foreman`).
- Workers: `node …/agent-bus/dist/cli.js worker add -n <N>` — sessions launch via the configured
  launcher (or paste the printed commands). No `git worktree` commands needed, ever.
- Dashboard: `node …/agent-bus/dist/server.js serve` → http://localhost:4319
- Confirm the bus: the board status line appears on your next prompt, and `agent_bus_peers` lists
  the foreman + workers.

## Step 6 — Re-auth the OTHER MCP servers (human, as needed)

The foreman/workers may also use project-specific MCP servers (Linear, Sentry, etc. — not in this
repo). Add with `claude mcp add …` and complete each OAuth prompt. agent-bus is the only one
REQUIRED for the foreman/worker loop itself.

---

### What could NOT be carried (do fresh)

- **All auth** (gh, claude, cloud, every OAuth MCP) — Steps 0 + 6.
- **Live runtime message data** (`agent-bus.db`, `*.notify`) — regenerated on first run, per repo.
- **The worker sessions** — recreated by `agent-bus worker add`.
