# roundhouse — a foreman/worker fleet for Claude Code

Turn independently-launched Claude Code instances on one machine into a coordinated fleet: the
repo's main checkout is the **foreman** (command center), and N autonomous **workers** do the
delegated work over a local, per-repo message bus. You think in *workers* — the tool manages the
isolation underneath; you never touch `git worktree` yourself.

Distributed as a **Claude Code plugin** (this repo is its own marketplace).

## Install

```
/plugin marketplace add and-michael/agent-bus-workflow
/plugin install roundhouse@roundhouse
```

That registers everything: the MCP server (`agent_bus_*` tools), the two passive-standup hooks
(`Stop → publish`, `UserPromptSubmit → board`), the `/roundhouse:foreman` + `/roundhouse:worker`
skills, and the `roundhouse` CLI on your Bash PATH. Requires Node ≥ 22.5 on PATH (`node:sqlite`).

Then, per repo (from its main checkout):

```bash
roundhouse init        # scaffolds agent-bus.config.json; cleans up any pre-plugin install
```

## Run it

```bash
/roundhouse:foreman            # main checkout — or /loop /roundhouse:foreman for always-on
roundhouse worker add -n 3     # provision + launch 3 workers (tmux/iTerm/paste-command)
roundhouse serve               # live dashboard → http://localhost:4319
```

Workers register on the foreman's board as `worker-<n>`. Manage the pool with
`roundhouse worker ls`, `roundhouse scale <N>`, `roundhouse worker rm worker-<n>` — or let the
foreman scale it itself (`workers.allowForemanScaling`).

## How it stays cheap (wakes are the cost)

A **wake** — a `.notify` line firing a worker's Monitor — costs one full model turn over that
worker's entire context. The bus minimizes and meters wakes structurally:

- **Strict hub-and-spoke, server-enforced:** workers can only message the foreman and the
  principal; worker↔worker sends and broadcasts are rejected *before* any write — a blocked send
  never wakes anyone. (`topology: "open"` opts out.)
- **Non-waking FYIs:** `agent_bus_send({ wake: false })` delivers on the recipient's next natural
  drain — status updates cost zero wakes.
- **Burst suppression:** an undrained recipient isn't re-woken; one drain returns everything.
- **`stateHash` + bundled board:** the foreman's 15-minute utilization review short-circuits when
  nothing changed, and `board({ full: true })` is one read instead of four.
- **Wake accounting:** every real wake is logged and surfaced as `wakesLastHour` per worker on the
  board and dashboard. Visibility, not throttles.

## Durable journal (opt-in) — restarts, machine moves, multiplayer

Point the bus at a **separate, private** git repo and every state-changing action (messages,
tasks, questions, todos, priorities, cursors) mirrors to an NDJSON event log there:

```jsonc
"remote": { "url": "git@github.com:you/roundhouse-state.git", "handle": "michael" }
```

- Pushes ride the turn-end hook (debounced ~1/min, offline-tolerant, never fails a bus action).
- `roundhouse restore` rebuilds the whole coordination state on a restart or a new machine.
- **The repo's shape is validated, not assumed:** an empty repo initializes itself
  (`agent-bus.json` layout marker) on first sync; a repo with other content is refused until an
  explicit `roundhouse sync --adopt`; a journal written by a newer roundhouse fails loudly. The tool
  only ever touches `agent-bus.json` + `log/` — anything else in the repo is left alone.
- **Multiplayer:** two fleets pointed at one shared journal repo each write only under their own
  `handle`, so writers never conflict. (Peer visibility on the board/dashboard builds on this log —
  next phase.)
- **Plaintext:** message bodies are stored as-is. Private repo only; never put secrets on the bus.

Why a separate repo (not the project repo): journal pushes are frequent small commits — history
that belongs next to the coordination data, not in your project's git log.

## Configuration

`agent-bus.config.json` at the repo root (user-level fallback `~/.claude/agent-bus.config.json`):

```jsonc
{
  "principal": { "name": "Michael" },        // the human decider
  "topology":  "strict-hub",                 // or "open"
  "foreman":   { "basename": null },         // null = main-worktree autodetect
  "workers": {
    "model": "sonnet",                       // default tier for workers
    "overrides": { "worker-4": "opus" },     // per-worker tier
    "launcher": "auto",                      // auto | tmux | iterm | manual
    "worktreeRoot": null,                    // null = ~/.agent-bus/worktrees/<slug>
    "baseBranch": null,                      // null = current HEAD of the main checkout
    "allowForemanScaling": true
  },
  "merge":  { "adminMergeLowRisk": false },  // may the foreman admin-merge low-risk PRs
  "remote": { "url": null, "handle": null }, // opt-in durable journal (separate private repo)
  "gh":     { "poll": true }
}
```

Each git repo gets its own isolated bus automatically (state under
`~/.claude/coordination/<repo>-<hash>/`); two projects never cross-talk. `agent_bus_paths` (or
`roundhouse paths`) shows where any directory resolves, including journal sync health.

## Choosing an execution pattern

Two ways to run durable multi-agent work — the foreman picks **per task**, never by habit:

1. **Durable sub-agents** — session-scoped helpers spawned by one instance, reporting back through
   that hub; resumable mid-session with context intact. ~Zero setup; per-spawn cheap-model
   overrides; hub accrues every return.
2. **Workers on this bus** — persistent, physically-isolated full instances. True file-write
   isolation, cross-session durability, independent ownership; N× context bootstrap.

Three questions decide: parallel file mutation? → workers (or worktree-isolated sub-agents).
Survives across sessions / independently owned? → workers. Decomposed-and-converging vs ongoing
independent streams? → sub-agents vs workers. **Default to sub-agents; escalate to a worker** for
isolated parallel writes or cross-session persistence. (Long form: `agent-bus/README.md`.)

## Upgrading from a pre-plugin install

If you previously ran the old `init` (user-scope MCP registration + hand-merged hooks + copied
skills): install the plugin, then **immediately** run `roundhouse init` — it removes the old
registrations so you don't get duplicate board injections and two MCP servers. Note the fully-
qualified MCP tool prefix changes to `mcp__plugin_…` — update any `permissions.allow` rules.

## Repo layout

```
plugin/          the Claude Code plugin (manifest, .mcp.json, hooks, skills, bin, committed bundles)
agent-bus/       the TypeScript source + tests (bundled into plugin/dist by `npm run bundle`)
SETUP.md         manual/dev setup and internals pointers
BOOTSTRAP.md     restore-a-machine runbook
```

Development: `cd agent-bus && npm install && npm run test:run`. After changing `src/`, run
`npm run bundle` — the committed plugin bundles are what installs actually execute, and
`bundle.test.ts` fails if they go stale.
