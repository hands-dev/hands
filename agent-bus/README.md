# agent-bus

A local **stdio MCP coordination server** + **provisioning CLI** that turns independently-launched
Claude Code CLI instances on one machine into a **foreman/worker fleet**: the repo's main checkout is
the command center (`foreman`), and N autonomous workers (`worker-1`…`worker-N`) do the delegated
work. Claude Code has no built-in cross-instance messaging (agent-teams / SendMessage only coordinate
agents spawned *within* one session), so this bus is the channel.

Registered once, **user-scoped** — available in every project without touching any repo's files.

## How it works

- **One process per Claude Code instance, no daemon.** Every instance runs its own stdio server; they
  all read/write a **shared SQLite DB** (WAL mode). The DB file is the single source of truth.
- **The bus is scoped per git repo.** State lives under `~/.claude/coordination/<basename>-<hash>/`,
  where the slug derives from the repo's git *common dir* — shared by all worktrees of a repo, unique
  per repo. Two projects on one machine get two fully separate buses (DB, notify files, priorities).
  `AGENT_BUS_HOME` overrides the auto-scoping; a non-git cwd falls back to `…/coordination/_global`.
  Debug with `node dist/server.js paths` — it prints the resolved dir/db/id for the cwd.
- **Identity is derived at runtime.** Precedence: `AGENT_BUS_ID` env (what the provisioner sets) →
  `--agent-id` → foreman-basename override (`AGENT_BUS_FOREMAN_BASENAME` / config
  `foreman.basename`) → **main-worktree autodetect** (any repo's main checkout is `foreman`) →
  `worker-<n>` from a managed worker dir name → the cwd basename. There are exactly two roles — no
  display names, no personas; agents are addressed by canonical id everywhere.
- **Strict hub-and-spoke, server-enforced** (config `topology: "strict-hub"`, the default): workers
  can only message the foreman and the principal. Worker↔worker sends, worker broadcasts, and worker
  task-delegation are **rejected before any DB write or notify** — a blocked send never wakes anyone.
  `topology: "open"` disables the restriction.
- **Near-real-time receive via long-poll.** `agent_bus_receive` blocks up to `wait_seconds`,
  returning the moment a message lands.

## Token control (wakes are the cost)

A **wake** — a `.notify` line firing a recipient's Monitor — costs one full model turn over that
agent's entire context. The bus minimizes and meters wakes:

- **`wake:false` sends** insert the message but skip the notify: FYIs/status cost zero wakes and are
  read on the recipient's next natural drain.
- **Redundant-wake suppression:** an undrained recipient (wake already outstanding) is not re-woken;
  one drain returns the whole burst. The suppression flag is set only by a real notify and cleared at
  drain start, so a silent FYI can never mask a real wake.
- **`stateHash` + bundled board:** `agent_bus_board` always returns a cheap fingerprint of team state
  (skip re-scans when unchanged), and `board({full:true})` bundles peers + active tasks + open
  questions + priorities into one read.
- **Wake accounting:** every real notify is logged (`wake_log`, pruned at 24h) and surfaced as
  `wakesLastHour` / `wakes24h` per agent on the board and dashboard. Observability only — no caps.

## Tools

| Tool | Purpose |
|---|---|
| `agent_bus_send({ to, body, subject?, thread?, wake? })` | Enqueue a message. `wake:false` = non-waking FYI. |
| `agent_bus_receive({ wait_seconds=25, mark_read=true })` | Messages addressed to you since your cursor; long-polls. |
| `agent_bus_peers()` | Registered agents + online state. |
| `agent_bus_history({ peer?, thread?, limit=50 })` | Past messages (audit). |
| `agent_bus_board({ full? })` | Standup snapshot + `stateHash` + per-peer wake counts; `full:true` bundles tasks/questions/priorities. |
| `agent_bus_ask` / `agent_bus_questions` / `agent_bus_answer` / `agent_bus_escalate` | Worker→foreman escalation lifecycle. |
| `agent_bus_priorities({ set?, confirm? })` | Read/set the ranked daily priorities. |
| `agent_bus_delegate` / `agent_bus_tasks` / `agent_bus_task_update` | Tracked task delegation lifecycle (foreman → worker). |
| `agent_bus_todos` / `agent_bus_todo_add` / `agent_bus_todo_update` | The principal's foreman-managed to-do list. |
| `agent_bus_rec_outcome({ id, outcome, note? })` | Foreman hindsight self-audit (effectiveness score). |
| `agent_bus_worker_add` / `agent_bus_worker_remove` / `agent_bus_scale` | Foreman-directed pool scaling (only when `workers.allowForemanScaling`). |

## CLI

```bash
node dist/cli.js init                # one-command setup (MCP registration, hooks, config, skills)
node dist/cli.js worker add -n 3     # provision + launch 3 workers
node dist/cli.js worker ls           # list this repo's workers
node dist/cli.js worker rm worker-3  # retire one (--force discards uncommitted work)
node dist/cli.js scale 5             # reconcile the pool to exactly 5
node dist/cli.js paths               # where does this cwd resolve? (debug)
```

Workers are hosted in hidden git worktrees under `~/.agent-bus/worktrees/<slug>/worker-<n>` on
ephemeral `agent-bus/worker-<n>` branches — the user thinks in workers, never worktrees. The
launcher is pluggable (`workers.launcher`): `tmux`, `iterm`, `manual` (prints the paste command), or
`auto`.

## Configuration

`agent-bus.config.json` at the repo root (user fallback `~/.claude/agent-bus.config.json`); see
`src/config.ts` for the full shape. Key fields: `principal.name`, `topology`
(`strict-hub`/`open`), `workers.model` + `workers.overrides` (model tiers), `workers.launcher`,
`workers.allowForemanScaling`, `merge.adminMergeLowRisk`, `gh.poll`.

## Passive standup (hooks)

Two global hooks in `~/.claude/settings.json` (installed by `init`) call the CLI mode:

- **`Stop` → `… publish`** (async, every turn end): derives status from the git branch, heartbeats
  presence, and auto-journals **new commits** and **memory-store writes**.
- **`UserPromptSubmit` → `… board`** (every prompt): injects a compact *delta* of what changed on the
  bus since you last looked. Quiet by design — emits nothing unless there's a real delta.

## Dashboard

```bash
node dist/server.js serve   # → http://127.0.0.1:4319 (AGENT_BUS_PORT overrides)
```

Read-only, localhost-only, does not register as an agent. Panels: overall utilization vs the ranked
priorities, the workers grid (current task, priority badge, **wakes/h · /24h** cost dial), foreman
effectiveness (hindsight-graded recommendations), "needs you" escalations, collision warnings.

## Foreman & workers

- Main checkout: `/loop /foreman` — triages escalated questions against the priorities
  (auto-resolving only the reversible/on-priority/scoped/confident slice), delegates all real work,
  reviews returned tasks, gates review/merge depth, maintains the principal's to-do list, and
  re-checks team utilization every ~15 min (skipped when `stateHash` is unchanged).
- Worker panes: `/loop /worker` — event-driven via a persistent Monitor tailing the worker's
  `.notify` file; drains the inbox, does reversible in-workspace work, escalates decisions, yields.

Both behaviors live in the rendered skills (`~/.claude/skills/{foreman,worker}/SKILL.md`, installed
from the `skills/` templates by `init`).

## Choosing an execution pattern

There are two ways to run durable multi-agent work, and the right one varies **per task** — don't
standardize on either:

1. **Durable sub-agents** — session-scoped helpers spawned by one instance (the Agent tool, or
   workflow `agent()` calls), all reporting back through that hub. Resumable mid-session with
   context intact: `SendMessage` by name or `agentId` continues a completed sub-agent from its
   transcript; a fresh spawn starts clean.
2. **Worker workspaces on this bus** — persistent, physically-isolated full Claude instances
   (`agent-bus worker add`) coordinating over the per-repo bus.

**A common misconception:** cheap-model tiering is *not* a workspace-only advantage. Sub-agents take
a **per-spawn `model` override** (workflow `agent()` calls add per-call `effort` too), and a resumed
sub-agent keeps its spawn-time model — so downgrading mechanical fan-out to a cheap tier works in
**both** patterns. The real axis is **isolation + durability** (workspaces) vs **simplicity +
convergence** (sub-agents).

| | Durable sub-agents | Worker workspaces (this bus) |
|---|---|---|
| **Setup cost** | ~zero — one tool call | one `agent-bus worker add`, but each worker is a full instance: hidden worktree + branch, its own session, N× context bootstrap (rules/memory/repo) |
| **Token economics** | lean for fan-out returning compact summaries — but the hub accrues every return, and the hub is usually the expensive model; many small round-trips through it add up | no hub bloat — each worker holds its own slice; pays the N× bootstrap, and every wake re-runs that worker's whole context (see wake accounting) |
| **File-write isolation** | share the parent checkout unless spawned with `isolation:"worktree"` (~200–500ms setup + disk each) | true isolation, always — own worktree, own branch |
| **Durability** | die with the session (resumable within it) | persist across sessions; independently-owned, evolving context |
| **Comms** | hub-and-spoke — the parent relays everything | shared bus: strict hub-and-spoke by default (server-enforced; `topology:"open"` for direct worker↔worker); delivery is poll-based (`agent_bus_receive` long-poll — no unprompted wake), with the `.notify` Monitor as the near-instant wake channel |
| **Concurrency** | workflow runs cap at ~min(16, cores−2) live, 1000 per run | a handful — each is a heavy process, plus its dev stack |

Three questions decide it:

1. **Do workers mutate files in parallel?** Yes → workspaces (or worktree-isolated sub-agents).
2. **Must the work survive across sessions / be independently owned?** Yes → workspaces.
3. **One task decomposed and converging, or N ongoing independent streams?** Converging →
   sub-agents; independent → workspaces.

**Default to durable sub-agents** — downgrade mechanical ones per-spawn to a cheap model, keep hard
verify/judge steps on the strong tier — and **escalate to a workspace** only when a worker needs
isolated parallel file-writes or cross-session persistence. Do not hard-code one pattern.

### The foreman decides the pattern

Pattern selection is a routing call, made **per task** by the coordinator with whole-board context —
the ranked priorities, live wake cost (`wakesLastHour`), and the model-tier budget
(`workers.model` / `workers.overrides`) — not by each worker for itself. Read/synthesis fan-out that
converges on one answer → sub-agents (run under the foreman, or under the assigned worker to keep
the hub lean); isolated builds and standing streams → delegate on the bus. The decision hooks into
the foreman's delegation step: spawn sub-agents, or `agent_bus_delegate` to a worker — resizing the
pool first via `agent_bus_scale` / `agent_bus_worker_add` when scaling is enabled
(`workers.allowForemanScaling`). There is no separate routing API; the delegation step *is* the
dispatch point.

## Known limitations (by design, not bugs)

- **MCP cannot wake an idle interactive Claude Code.** The model must *choose* to call
  `agent_bus_receive`. The `.notify` files + Monitor tails are the wake channel; delivery correctness
  lives entirely in the DB.
- **No secrets in message bodies.** Messages are stored **plaintext** in the local SQLite DB. The DB
  and `.notify` files are created `0600` and the dir `0700`, but do not put tokens/keys/credentials
  in a message.

## Development

```bash
npm run check-types
npm run test:run    # unit + MCP-level (topology, wake levers, provisioning) tests
npm run build       # emit dist/ — REQUIRED after editing src (hooks + MCP run dist/)
```

Backed by Node's built-in `node:sqlite` (`DatabaseSync`) — synchronous, no native install. Requires
Node ≥ 22.5.
