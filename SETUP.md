# agent-bus workflow — foreman / worker setup

Multi-agent orchestration for Claude Code: a **foreman** (command center) in your repo's main
checkout directs N autonomous **workers** over a local message bus. You think in *workers* — the tool
manages the isolation underneath (each worker gets its own hidden workspace); you never touch
`git worktree` yourself.

Each git repo gets its **own isolated bus** automatically (state lives under
`~/.claude/coordination/<repo>-<hash>/`), so two projects on one machine never cross-talk. Topology
is **strict hub-and-spoke, server-enforced**: workers talk only to the foreman and to you.

## What's here

```
agent-bus/                 the stdio MCP server + `agent-bus` CLI (init / worker add / scale / dashboard)
skills/foreman/            /foreman skill template — the command-center loop
skills/worker/             /worker skill template — the autonomous responder
coordination/priorities.example.md   seed for your ranked daily priorities
claude-config/             reference hook/statusline config (installed by init)
```

## 1. One-command install

Needs Node ≥ 22.5 and git. From **your repo's main checkout**:

```bash
cd path/to/agent-bus-workflow/agent-bus
npm install
node_modules/.bin/tsc -p tsconfig.build.json   # or: npm run build
cd /path/to/YOUR/repo
node path/to/agent-bus-workflow/agent-bus/dist/cli.js init
```

`init` does everything (merge-not-overwrite, with `.agent-bus.bak` backups):

1. builds the package (`src/ → dist/`),
2. registers the MCP server user-scope in `~/.claude.json` (absolute node + `dist/server.js` paths),
3. merges the two hooks into `~/.claude/settings.json`
   (`Stop → server.js publish` for the heartbeat/journal, `UserPromptSubmit → server.js board` for
   the ambient status line),
4. scaffolds `agent-bus.config.json` in your repo root (asks for the **principal** — the human the
   foreman reports to),
5. renders + installs the `/foreman` and `/worker` skills into `~/.claude/skills/`,
6. offers to migrate a legacy (pre-isolation) `~/.claude/coordination` dir into the repo's new bus.

Non-interactive: `… init --yes --principal "Ada"`. Verify with
`node dist/server.js paths` — it prints the resolved per-repo coordination dir, DB, and agent id.

## 2. Configure (optional)

`agent-bus.config.json` in the repo root (user-level fallback: `~/.claude/agent-bus.config.json`):

```jsonc
{
  "principal": { "name": "Michael" },        // the human decider
  "topology":  "strict-hub",                 // or "open" (no routing restrictions)
  "foreman":   { "basename": null },         // null = main-worktree autodetect
  "workers": {
    "model": "sonnet",                       // default tier for all workers
    "overrides": { "worker-4": "opus" },     // per-worker tier, by canonical id
    "launcher": "auto",                      // auto | tmux | iterm | manual
    "worktreeRoot": null,                    // null = ~/.agent-bus/worktrees/<slug>
    "baseBranch": null,                      // null = current HEAD of the main checkout
    "allowForemanScaling": true              // may the foreman spin workers up/down itself
  },
  "merge": { "adminMergeLowRisk": false },   // may the foreman admin-merge low-risk PRs
  "gh": { "poll": true }
}
```

## 3. Run it

```bash
# main checkout — the command center:
/foreman                # or /loop /foreman for the always-on cadence

# add workers (from anywhere inside the repo):
node …/agent-bus/dist/cli.js worker add -n 3
```

`worker add` provisions each worker and launches its session via the configured launcher (tmux pane,
iTerm window, or — with `manual` — it prints the exact command to paste into a new terminal). Each
worker session runs `/loop /worker` and registers on the foreman's board as `worker-<n>`.

Manage the pool:

```bash
… worker ls             # list this repo's workers
… scale 5               # reconcile to exactly 5 (retires highest indices first)
… worker rm worker-3    # retire one (--force discards uncommitted work)
```

The foreman can also scale the pool itself via `agent_bus_scale` /
`agent_bus_worker_add` / `agent_bus_worker_remove` (disable with
`workers.allowForemanScaling: false`).

## 4. Seed priorities (optional)

```bash
cp coordination/priorities.example.md "$(node …/dist/server.js paths | jq -r .coordinationDir)/priorities.md"
```

Or just answer the foreman when it asks for the day's ranked priorities.

## 5. Dashboard (optional)

```bash
node …/agent-bus/dist/server.js serve    # → http://localhost:4319
```

Utilization vs priorities, per-worker current task + **wakes/hour** (the live token-cost dial), the
"needs you" lane, and foreman effectiveness.

## Token control (how this stays cheap)

A **wake** — a `.notify` line firing a worker's Monitor — costs a full model turn over that worker's
whole context. The system minimizes wakes structurally:

- workers can't wake each other (strict hub-and-spoke, rejected server-side before any notify),
- FYIs are non-waking (`agent_bus_send({ wake: false })` delivers on the next natural drain),
- bursts collapse (an undrained recipient isn't re-woken; one drain returns everything),
- the foreman's 15-min utilization review short-circuits on an unchanged board `stateHash`,
- every real wake is counted (`wakesLastHour` per worker on the board + dashboard) so hotspots are
  visible. No caps or throttles — visibility + your intervention.

## Two repos side by side

Run `init` in each repo (steps 2–6 are per-repo; the MCP/hook registration is shared). Each gets its
own coordination dir, board, foreman, and workers. `AGENT_BUS_HOME` overrides the auto-scoping if you
ever need to pin a bus location explicitly.
