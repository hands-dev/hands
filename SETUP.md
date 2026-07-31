# agent-bus workflow — foreman / worker setup

> ⚠️ **Use BOOTSTRAP.md** as the authoritative step-by-step runbook (this file is a quicker overview; BOOTSTRAP.md has the correct hook events + memory/warp/auth steps).


Bootstrap the multi-pane Claude Code orchestration (foreman + workers over a local
message bus) on a fresh laptop. This repo holds the **mechanism**, not the runtime
message data (that's regenerated locally).

## What's here
```
agent-bus/                 the stdio MCP server (send/receive/peers/board/priorities/dashboard)
skills/foreman/            /foreman skill — the command-center loop
skills/worker/             /worker skill — the autonomous per-worktree responder
coordination/priorities.example.md   seed for your ranked daily priorities
resume-clean-sheet.sh      pulls the in-flight CODE branches from theandcompany/ampersand
```

## 1. Build the agent-bus tool
Needs Node 20+ (the old machine used `/opt/homebrew/bin/node`).
```bash
cd agent-bus
npm install
npm run build          # compiles src/ -> dist/  (dist/ is gitignored, must be built)
npm test               # optional sanity check
```

## 2. Register it as an MCP server (user scope)
```bash
claude mcp add agent-bus --scope user -- node --no-warnings "$(pwd)/dist/server.js"
```
(See `agent-bus/README.md` for the authoritative install + any extra flags.)

## 3. Wire the two hooks in ~/.claude/settings.json
These publish your pane's heartbeat + inject the peer/board status line each turn.
Replace `ABS_PATH` with the absolute path to this repo's `agent-bus`.
```jsonc
// under "hooks":
"UserPromptSubmit": [
  { "hooks": [ {
    "type": "command",
    "command": "/opt/homebrew/bin/node --no-warnings ABS_PATH/dist/server.js publish",
    "timeout": 30, "async": true
  } ] }
],
"SessionStart": [
  { "hooks": [ {
    "type": "command",
    "command": "/opt/homebrew/bin/node --no-warnings ABS_PATH/dist/server.js board",
    "timeout": 10
  } ] }
]
```
(Adjust the node path for the new machine — `which node`.)

## 4. Install the skills
```bash
mkdir -p ~/.claude/skills
cp -R skills/foreman ~/.claude/skills/foreman
cp -R skills/worker  ~/.claude/skills/worker
```

## 5. Seed priorities (optional)
```bash
mkdir -p ~/.claude/coordination
cp coordination/priorities.example.md ~/.claude/coordination/priorities.md
```
The bus recreates its own `agent-bus.db` + `*.notify` files on first run — nothing
to copy. (Those were deliberately left OUT of this repo: they hold plaintext
cross-worktree message history.)

## 6. Get the code back
```bash
bash resume-clean-sheet.sh            # clones theandcompany/ampersand + the in-flight worktrees
```

## 7. Run it
- Main checkout: `/foreman` (or `/loop /foreman`) — the command center.
- Each worktree pane: `/loop /worker` — autonomous responder.
- Dashboard (optional): `cd agent-bus && npm run dashboard` → http://localhost:4319

---
### The in-flight work this was orchestrating (on theandcompany/ampersand)
- `feat/eng-1450-ephemeral-checkout-fs` — **CS2 / Pillar-A spine (POC-validated), the critical branch. CS2 mid-assembly, needs /code-review high before merge.**
- `feat/eng-1449-ws4-rollout-harness` — canary/isolation harness
- `eng1449-fleet-host-image-module-extraction` — Shape-B versioned-image module
- `eng1441-staging-tf-ref-gate` — PR #2386 (ref-gate; unblocks re-enabling the staging orchestrator)

Goal was: ref-gate + CS2 merge → re-enable staging-deploy-orchestrator → whole-pool
destructive reprovision (`force_terraform=true`, `terraform_destroy_intent=APPLY_DESTRUCTIVE_STAGING_PLAN`,
`force_api=true`) → your staging &tag chat lands on a clean-sheet host.
