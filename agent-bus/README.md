# agent-bus

A local **stdio MCP coordination server** that lets multiple independently-launched Claude Code CLI
instances — different Warp panes / git worktrees on the same machine — send structured messages to each
other, discover peers, and read history. Claude Code has no built-in cross-instance messaging (the
agent-teams / SendMessage tools only coordinate agents spawned _within_ one orchestrating session), so
before this the only cross-worktree channels were shared files, Linear comments, or manual paste.

Personal, machine-local tool — **not part of any repo**. Lives at `~/.claude/tools/agent-bus/` and is
registered as a **user-scoped** MCP server, so it's available in every project/worktree without touching
any repo's files. Originally scoped as [INN-239](https://linear.app/and-com/issue/INN-239); built as a
personal tool instead of a monorepo package.

## How it works

- **One process per Claude Code instance, no daemon.** Every instance runs its own stdio server; they all
  read/write a **shared SQLite DB** at `~/.claude/coordination/agent-bus.db` (WAL mode). The DB file is the
  single source of truth.
- **Identity is derived at runtime from the cwd.** A user-scoped server is launched from whatever worktree
  Claude Code started in, so the server derives its own id from that cwd rather than from static config.
  Precedence: `AGENT_BUS_ID` env → `--agent-id <name>` → `wt<n>` from the worktree dir basename
  (`…worktree-3` → `wt3`, matching the ampersand repo's worktree naming) → the cwd basename (main checkout).
- **Near-real-time receive via long-poll.** `agent_bus_receive` blocks up to `wait_seconds`, polling the DB
  and returning the moment a message lands.

## Tools

| Tool | Purpose |
|---|---|
| `agent_bus_send({ to, body, subject?, thread? })` | Enqueue a message. `to` = a peer agent id, or `"*"` to broadcast. |
| `agent_bus_receive({ wait_seconds=25, mark_read=true })` | Return messages addressed to you (directed + broadcast) since your cursor; long-polls; advances the cursor. |
| `agent_bus_peers()` | List registered agents and whether each is online (heartbeat within 60s). |
| `agent_bus_history({ peer?, thread?, limit=50 })` | Read past messages (audit). |
| `agent_bus_board()` | Standup snapshot: who's active (branch + age), recent learnings (commits + memory), collisions. |

## Passive standup (Phase 1)

Ambient cross-worktree awareness with **zero human or model effort**, driven by two global hooks in
`~/.claude/settings.json` that call the tool's CLI mode (`node dist/server.js …`):

- **`Stop` → `… publish`** (async, every turn end): derives status from the git branch, heartbeats
  presence, and auto-journals **new commits** and **memory-store writes**. Nothing to invoke.
- **`UserPromptSubmit` → `… board`** (every prompt): injects a compact *delta* of what changed on the bus
  since you last looked — peer activity, learnings, and **collision warnings** (another worktree touching
  your files / on your ticket). Quiet by design: emits nothing unless there's a real delta, so
  injecting-every-prompt stays cheap.

The board is **delta-based**: the first read per pane baselines silently; subsequent reads show only what's
new. See `DESIGN.md` for the full plan (Phase 2 = delegation/workers).

> Activation is live: Claude Code picks up new `~/.claude/settings.json` hooks in **already-running**
> sessions — no restart needed (observed 2026-07-30).

## Dashboard

A live, Warp-style grid view of the orchestration — one terminal-pane tile per worktree, each with a
status dot (active / idle / offline), its recent commits + learnings + messages, and a status bar
(path · ⎇ branch · files · age). Collisions are flagged in a strip up top and on the involved panes.

```bash
cd ~/.claude/tools/agent-bus && npm run dashboard   # → http://127.0.0.1:4319 (opens your browser)
```

Read-only `node:http` server bound to localhost; it does **not** register as an agent. Port overridable
via `AGENT_BUS_PORT`. The page polls `/api/state` every 2s. Leave it running in a spare pane/tab. The top
**conductor lane** shows the foreman's priorities, the "needs you" queue, in-flight questions, and recent
decisions.

## Foreman (command center)

The **main checkout** (`/Development/ampersand`) registers as agent **`foreman`** and is the interactive
command center. Worktrees escalate open decisions with `agent_bus_ask`; the foreman triages them against
Michael's ranked daily priorities — **auto-resolving only a small safe slice** (reversible · on-priority ·
scoped to the asker · high-confidence) and **bubbling everything else up to Michael** with a recommendation.

Run it in the main pane, ideally on a cadence so it's always-on:

```
/loop /foreman
```

- **Priorities** live in `~/.claude/coordination/priorities.md` (edit directly any time). If unset, the
  foreman asks you; it re-confirms when stale (~a day).
- Tools: `agent_bus_ask` (worktree → foreman), `agent_bus_questions` (inbox), `agent_bus_answer`,
  `agent_bus_escalate`, `agent_bus_priorities`.
- **Delegation (tracked):** the foreman **delegates all real work** and never plans/codes itself.
  `agent_bus_delegate({ to, title, body, priority })` creates a tracked task; the worktree advances it with
  `agent_bus_task_update` (`in_progress` → `returned` with `result`); the foreman reviews returned tasks and
  closes them (`done`) or re-delegates the next step. `agent_bus_tasks` lists them. The dashboard's
  **delegations** lane shows the whole `assigned → in_progress → returned → done` lifecycle live.
- **Team awareness:** `agent-bus gh-poll` (via `gh`) records what *other* engineers are shipping — open +
  recently-merged PRs, excluding yours — into the dashboard **team · github** lane. PRs touching a
  worktree's file or ticket get flagged (`↔ wtN`) and propagated to that worktree.
- **Review / merge gatekeeper:** on a "PR ready" escalation the foreman picks the `/code-review` depth
  itself (low / default / high by complexity — reversible), and for **admin-merge/bypass** it recommends
  but **always escalates** (high blast radius); it never force-merges on its own.
- Escalations fire a **macOS notification** and appear in the dashboard "needs you" lane; you answer by just
  talking to the foreman in the main pane. The behavior is encoded in the `/foreman` skill
  (`~/.claude/skills/foreman/SKILL.md`).
- Can't push into an idle main pane (MCP wake-limit), so the `/loop` self-wake is what keeps it live;
  questions queue durably if it's down.

## Workers (autonomous responders)

Make any pane respond to cross-worktree messages without you touching it:

```
/loop /worker
```

Each pass **long-polls** the inbox (`agent_bus_receive({ wait_seconds: 15 })`) — the model parks cheaply and
returns **the instant** a message lands (measured ~150ms turnaround), with 15s as the idle re-arm ceiling.
It replies to what it can, escalates decisions to the foreman via `agent_bus_ask`, does only
safe/reversible in-worktree work, and yields. Behavior is in the `/worker` skill
(`~/.claude/skills/worker/SKILL.md`).

**Awareness vs handling** are decoupled: the `UserPromptSubmit` board *shows* you incoming messages (by
time window, never consuming them), while a worker *handles* them via the `receive` cursor. So a message
you glance at isn't marked done, and a worker draining its inbox doesn't steal it from your view — dedicate
a pane to `/loop /worker`, keep working in the others.

## Setup

Registered once, user-scoped, so every worktree gets it:

```bash
claude mcp add agent-bus -s user -- \
  ~/.claude/tools/agent-bus/node_modules/.bin/tsx \
  ~/.claude/tools/agent-bus/src/server.ts
```

(Use absolute paths — a user-scoped server is launched from the current worktree's cwd, which is exactly
what the `wt<n>` id derivation wants; the command/script paths must resolve regardless of cwd.) To force an
explicit id for a pane, append `--agent-id myname` or set `AGENT_BUS_ID`.

Verify: `claude mcp get agent-bus` → `Status: ✔ Connected`. Then, in two worktrees, `agent_bus_peers` shows
both; `agent_bus_send({to:"wt<other>", body:"…"})` in one is picked up by `agent_bus_receive` in the other.

Remove with `claude mcp remove agent-bus -s user`.

## Known limitations (by design, not bugs)

- **MCP cannot wake an idle interactive Claude Code.** The model must _choose_ to call
  `agent_bus_receive` — there is no unprompted push into an idle session. Delivery is therefore: call
  `agent_bus_receive` at natural checkpoints, or park a long-poll `receive`. As a companion nudge, every
  `send` also appends a line to each recipient's `~/.claude/coordination/<agent>.notify` file — tail it in
  the target pane (e.g. via a `Monitor` running `tail -f`) so a new line prompts that instance to check its
  inbox.
- **No secrets in message bodies.** Messages are stored **plaintext** in the local SQLite DB. The DB and
  `.notify` files are created `0600` and the dir `0700` (local, same-user only), but do not put tokens,
  keys, or credentials in a message.

## Development

```bash
cd ~/.claude/tools/agent-bus
npm run check-types
npm run test:run    # incl. concurrency + Phase-1 (publish/board/journal/collision) tests
npm run build       # emit dist/ — REQUIRED after editing src, since the hooks run node dist/server.js
npm start           # run the server standalone (stdio)
```

The MCP server runs from `src/` via `tsx` (registered in `~/.claude.json`); the **hooks** run the compiled
`dist/` under plain `node` for speed (~110ms vs ~270ms). So after changing `src/`, run `npm run build` or
the hooks keep running stale code.

Backed by Node's built-in `node:sqlite` (`DatabaseSync`) — synchronous, no native install (no
`better-sqlite3` binary to compile). Requires Node ≥ 22.5.

### Out of scope (follow-ups)

`ack` + per-recipient delivery tracking, thread/history search, TTL cleanup of old messages + stale agents,
and an optional `--http-daemon` (streamable-HTTP + SSE) mode for true multi-client push.
