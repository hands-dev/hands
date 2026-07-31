# agent-bus — design & build plan

Cross-worktree coordination for Claude Code, as a personal machine-local tool at
`~/.claude/tools/agent-bus/`, registered user-scoped so every worktree/pane gets it with no per-repo or
per-pane setup. Two layers:

1. **Passive standup** — ambient awareness of what every worktree is doing + learning, with *zero* human
   or model effort. Driven entirely by global hooks.
2. **Delegation / workers** — dispatch work to another worktree ("have an available WT dig into this") and
   route results back. Driven by a low-frequency dispatcher loop auto-armed per pane.

Design constraint that shapes everything: **MCP/hooks cannot wake an idle pane.** "Passive" therefore means
*injected when a pane is already doing something* (a turn, a prompt), never *pushed into an idle session*.
Sessions are long-lived (rarely closed), so the automatic events we ride are **per-turn** (`Stop`) and
**per-prompt** (`UserPromptSubmit`), not per-session.

---

## Already built (Phase 0 — done)

- stdio MCP server + shared SQLite (`~/.claude/coordination/agent-bus.db`, WAL, busy_timeout, retry).
- Tools: `agent_bus_send`, `agent_bus_receive` (long-poll), `agent_bus_peers`, `agent_bus_history`.
- Identity from cwd (`wt<n>` from `…worktree-n`), notify files, 0600/0700 hygiene.
- Tests incl. a concurrent multi-connection correctness test. Registered user-scoped, verified from wt2/wt4.

Everything below is additive.

---

## Data model additions

- `agents` — add `branch TEXT`, `activity TEXT`, `state TEXT` (`idle|busy`), `last_active INTEGER`.
  (`last_seen_at` stays the presence heartbeat; `last_active` is stamped every turn by the Stop hook and
  is what the idle-gate reads.)
- `journal(id INTEGER PK AUTOINCREMENT, agent_id, kind TEXT /* commit|memory|note */, ref TEXT, text TEXT, created_at INTEGER)`
- `tasks(id INTEGER PK AUTOINCREMENT, thread_id, created_by, assignee TEXT NULL, state TEXT /* open|claimed|in_progress|done|cancelled */, title TEXT, body TEXT, result TEXT NULL, created_at, claimed_at NULL, completed_at NULL)`
- `watermarks(agent_id, key, value)` — per-agent progress markers (last-journaled commit sha, last-seen
  memory hash, last board-injection timestamp).

---

## CLI mode (same binary, second entrypoint)

Hooks are shell scripts, so they must not do an MCP handshake. `server.ts` gains subcommands (no arg =
MCP stdio server as today):

- `agent-bus publish` — the Stop-hook workhorse, fast (<100ms): read git branch + `diff --stat`/last
  commit in cwd → upsert status + heartbeat + `last_active`; harvest new commits since the watermark →
  `journal(kind=commit)`; detect new/changed memory files → `journal(kind=memory)`; compute collisions →
  stash for the next board.
- `agent-bus board [--since <ts>]` — the UserPromptSubmit-hook workhorse: print a **compact** digest —
  peers (branch · online/idle · age), recent journal deltas, open tasks addressed to me or unassigned, and
  any collision warnings — only what's new since `--since`, capped to a few lines.

Interactive sessions keep using the MCP tools; hooks use the CLI; both hit the one shared DB.

---

## Hooks (global `~/.claude/settings.json`, all worktrees)

- **`Stop` → `agent-bus publish`.** Fires every turn end. Passive publish: status, presence heartbeat,
  commit + memory journaling. Zero model/human action.
- **`UserPromptSubmit` → inject `agent-bus board --since <last>`.** Fires on every message you send.
  Passive consume: injects the delta as additional context so awareness lands exactly when the agent is
  about to act. **Injection-every-prompt is intentionally being trialed** — watch token cost; dedupe hard
  (only genuine deltas) and cap length. Collision warnings ride in this digest (see below).
- **`SessionStart` → inject the worker directive (Option A).** Arms the dispatcher loop. Note: in
  interactive CC the directive executes on the *first prompt* (agent is idle until you type), which also
  coincides with the first board injection.

---

## Passive standup, concretely

- **Status = git-derived, free.** `wt2 · feature/eng-1389 · active 2m ago`. Branch is a strong
  "what I'm working on" proxy; no one posts anything.
- **Journal = commits + memory.** New commit subjects and new memory-store writes are auto-appended, so a
  learning captured in one worktree surfaces to the others. No manual journaling, no `/standup`.
- **Collision nudge (in).** `publish` records each pane's touched files/branch/ticket; `board` surfaces
  overlaps as a highlighted line (`⚠ wt2 is also editing src/store.ts`). Lightweight version = a line in
  the injected board on your next prompt. Optional escalation (later, if wanted): a `Stop` `decision:block`
  that forces an immediate heads-up turn — higher signal, but can add unsolicited turns.

---

## Delegation / workers

Task lifecycle: `open → claimed(assignee) → in-progress → done(result)`, `thread` routes replies home.

**MCP tools:**
- `agent_bus_dispatch({ task, to?, thread? })` — create a task. `to:"wt3"` = assigned; `to` omitted =
  unassigned queue ("any available WT").
- `agent_bus_claim({ task_id? })` — worker takes the next open task (or a specific one); assignee = me.
- `agent_bus_complete({ task_id, result })` — post findings, mark done, route back to `created_by`.
- `agent_bus_tasks({ open?, mine? })` — list (for the loop and board).
- `agent_bus_board()` — one-call read of presence + status + recent journal + open tasks (model-facing
  twin of the CLI `board`).

**Worker loop (Option A — self-arm, idle-gated, low-frequency):**
- `SessionStart` injects a directive; on first prompt the agent arms a self-wake (`ScheduleWakeup`) at a
  long idle interval.
- On each wake: read own `last_active`. If recent → **busy**, reschedule and sleep (never hijack a pane
  you're using). If stale past threshold → **idle** → `claim` the next open task, do it **in this
  worktree**, `complete` with findings, then sleep.
- If self-arm proves flaky or in-pane interleaving annoys → graduate this one hook to a detached headless
  `claude -p` sidecar (Option B); nothing else changes.

**Your two phrasings, end to end:**
- *"Have an available WT dig into this"* → agent `dispatch`es an unassigned task → an idle worker's wake
  claims + works + completes → result injected into your pane on your next prompt.
- *"Respond to WT3 with your findings"* → `complete(task_id, <own context>)` if wt3 dispatched it, else
  `send({to:"wt3", …})`; the board maps "WT3" → `wt3`.
- **Graceful degradation:** even a pane not on the loop sees `1 open task: …` in its injected board and can
  volunteer. Nothing is lost; latency depends on who's watching.

**Guardrails:**
- Singleton worker per worktree (lockfile `~/.claude/coordination/<agent>.worker.lock`).
- Idle-gate every auto-claim (see above).
- Worker claims **one task at a time**, works **only in its own worktree**, and **posts results rather than
  pushing/merging** — so an autonomous loop can't run away.

---

## Build phases

1. **Phase 1 — passive standup (zero-effort).** Data-model + `publish`/`board` CLI + `agent_bus_board`
   tool + collision-in-board + the `Stop` and `UserPromptSubmit` global hooks + commit/memory journaling.
   Ship and live on it; tune injection cost.
2. **Phase 2 — delegation/workers.** `tasks` table + dispatch/claim/complete/tasks tools + the
   `SessionStart` self-arm directive + idle-gated dispatcher loop + guardrails.

Tests extend the existing suite (journal harvest, board delta/dedup, task lifecycle, idle-gate logic,
collision detection). Each phase verified end-to-end across ≥2 worktrees before moving on.

---

## Open risks / tuning knobs

- **Injection token cost** (the main one) — every-prompt board injection; mitigate with strict deltas +
  length cap; revisit if it bloats context.
- **`Stop` is hot** — `publish` must stay sub-100ms.
- **Self-arm reliability** — Option A depends on the model obeying the SessionStart directive; Option B is
  the deterministic fallback.
- **Autonomous execution** — worker panes run real work from a task string; guardrails above + worktree
  isolation are the containment.
