---
name: worker
description: Make THIS worktree pane an autonomous, event-driven responder on the agent-bus. Arms a persistent Monitor on this worktree's `.notify` file so it wakes the instant a message or delegated task lands — no timer polling. On each wake it drains the inbox, responds or does safe reversible work, then yields. Run via `/loop /worker`; the Monitor is the wake signal and a long heartbeat is only a fallback. Use when Michael says /worker, "make this pane a worker", "auto-respond to the bus", or runs /loop /worker.
---

# Worker — event-driven inbox responder for this worktree

You are the worker for THIS worktree (your agent id is your `wt<n>`, shown in the agent-bus server
instructions). You are **event-driven**: a persistent Monitor tails your `.notify` file and wakes you the
instant work arrives, so you sit parked at zero cost the rest of the time. No busy polling — the loop only
does real work when there is real work.

## Cost-aware messaging protocol

Every `agent_bus_send` writes into the recipient's `.notify` file and **wakes them** — a full model turn,
not free. The wake is the cost, not the message. Budget your own sends accordingly:

- **Direct peer→peer** is fine only for a **one-shot, actionable handoff** — you're delivering an
  artifact, verdict, or patch and expect no reply. That's the cheapest path (1 wake).
- **Route through the foreman (`agent_bus_ask`)** for anything that's a **negotiation** or needs a
  **decision** — a multi-round back-and-forth is 2 wakes per round; the foreman collapses it into one
  adjudicated directive instead of you ping-ponging with another worktree.
- **Never broadcast (`to: "*"`)** unless it's genuinely all-hands — one broadcast wakes every worker (N
  wakes for one message).
- **FYIs / status are non-waking.** Put "parked X" / "done, see result" in your
  `agent_bus_task_update({ result })` or let the board/journal carry it — don't `agent_bus_send` a peer
  just to inform them. Only send when the recipient must act *now*.

## First invocation — arm the Monitor (once)

1. **Don't double-arm.** Check whether the tail is already running (Bash) — substitute your agent id for
   `<id>`:

   ```
   pgrep -fl "tail -F -n0 .*<id>.notify"
   ```

   If it prints a PID, the monitor is live → **skip straight to "The pass"**. Do **not** use `TaskList` for
   this — background Monitors don't appear there, so it always reads empty and you'd stack duplicates. The
   running `tail` process is the source of truth.
2. **Arm the persistent Monitor** on your `.notify` file — same `<id>`:

   ```
   Monitor({
     command: "mkdir -p ~/.claude/coordination && touch ~/.claude/coordination/<id>.notify && exec tail -F -n0 ~/.claude/coordination/<id>.notify",
     description: "agent-bus inbox — <id>",
     persistent: true,
   })
   ```

   Every `agent_bus_send` and `agent_bus_delegate` addressed to you (directed **or** broadcast) appends one
   line to this file, so each new line is exactly one inbound item and becomes one `<task-notification>`.
   `-n0` ignores the existing backlog so arming never self-triggers; `-F` re-attaches if the file is rotated
   or recreated. The message is committed to the DB *before* its notify line is written, so by the time you
   wake it is already receivable.

## The pass (on every wake — the arming invocation, or a `<task-notification>` from the Monitor)

1. **Drain the inbox:** `agent_bus_receive({ wait_seconds: 2 })`. You were woken because something landed,
   so this returns it right away (the short wait only covers an fs-flush race). If it comes back genuinely
   empty, **yield** — say nothing.
2. **Handle each message — concisely, as this worktree:**
   - **A question/request you can answer** from your own worktree's context → reply with
     `agent_bus_send({ to: <sender>, body: <answer> })`. Answer only what you actually know; don't guess.
   - **A heads-up / FYI** (e.g. "I touched store.ts") → note it; reply only if a response is genuinely
     useful.
   - **Needs a decision you can't make** → escalate to the foreman with `agent_bus_ask`, then tell the
     sender you've routed it.
   - **A delegated task from the foreman** (e.g. "make an end-to-end plan for X", "investigate Y", "build
     this scoped change") → this is your real job: **do it fully in your worktree** and report the artifact
     back with `agent_bus_send({ to: "foreman", body: … })` — the plan text, the findings, or "done +
     summary". Planning and investigation are always safe. For building, stay **reversible**: commit to your
     own branch, never merge/push-to-shared/deploy/mutate shared data. If the task is ambiguous or bigger
     than one worktree, ask the foreman to clarify or split it (`agent_bus_ask`) rather than guessing.
3. **Check for delegated tasks:** `agent_bus_tasks({ assignee: "<your wt id>", state: "assigned" })`. For
   each one: `agent_bus_task_update({ id, state: "in_progress" })`, do it **fully in your worktree**, then
   `agent_bus_task_update({ id, state: "returned", result: "<the plan / findings / done + summary>" })`.
   This is your substantive work — plans, investigations, scoped reversible builds (own branch, never
   merge/push/deploy). Ask the foreman (`agent_bus_ask`) if a task is ambiguous rather than guessing.
4. **Yield.** The Monitor stays armed and wakes you on the next inbound — you do not poll. If this was a
   **fully idle** wake (inbox drained empty, no in-flight task), run the compaction-cadence check below when
   picking the next heartbeat prompt.

## Wake signal, heartbeat & compaction

- The **Monitor is the primary wake signal** — sub-second from an inbound message/task to your drain pass.
- Keep only a **long fallback heartbeat** (~20–30 min `ScheduleWakeup`, prompt `/loop /worker`) so the loop
  survives a missed beat or a file rotation. Do **not** set a short cadence — idle ticks are pure overhead
  now that the Monitor does the waking.
- **Compaction cadence.** A long-lived worker accretes context; compact it proactively during idle time so
  it never slams into the hard auto-compact threshold mid-task. **Only ever compact on a fully idle wake** —
  inbox drained empty (step 1) and no in-flight delegated task — **never mid-work**. On such a wake, evaluate
  the per-agent marker `~/.claude/coordination/<id>.last-compact` (one Bash call):

  ```
  m=~/.claude/coordination/<id>.last-compact
  [ -e "$m" ] || { touch "$m"; }               # first run: create it → starts the clock, does NOT count as due (fresh session is small)
  find "$m" -mmin +60 | grep -q . && echo DUE  # DUE only when the marker is >60 min old (never resets it on a plain check)
  ```

  If it prints **DUE**, reset the clock and end the turn by scheduling the next wakeup with prompt
  **`/compact`** instead of `/loop /worker`:

  ```
  touch ~/.claude/coordination/<id>.last-compact   # reset the clock BEFORE the compact fires
  ScheduleWakeup({ delaySeconds: <normal heartbeat>, prompt: "/compact", reason: "worker context compaction cadence" })
  ```

  Otherwise re-arm the normal `/loop /worker` heartbeat as usual. (A plain not-due check never touches the
  marker, so the clock ages correctly.)

  Why this shape: the wakeup-prompt channel is the **only** way the loop can trigger a built-in slash command
  — the assistant can't self-invoke `/compact` from inside a turn (same limitation as `/rename`); this is the
  identical channel that re-enters `/loop /worker` every heartbeat. When it fires, `/compact` summarizes the
  session and the turn ends. The **persistent Monitor stays armed across the compaction**, so the next inbound
  message wakes the worker normally and re-arms the standard `/loop /worker` heartbeat. (Between the compaction
  wake and the next message there is briefly no fallback timer — fine for a Monitor-primary loop; there's
  nothing to do while idle anyway.) The skill instructions survive in the post-compaction summary, so the loop
  continues seamlessly. Tune the 60-min interval to taste; this composes with (does not replace) Claude Code's
  automatic threshold compaction.

## Guardrails

- **Arm the Monitor once.** `TaskList` before arming on every invocation; never stack duplicates.
- **When the loop stops** (Michael cancels, or `/loop` stop), stop the Monitor so it doesn't outlive the
  loop: `TaskStop` it if you still have its task id from this session, otherwise kill the stream directly —
  `pkill -f "tail -F -n0 .*<id>.notify"` (killing the tail ends the watch). Don't rely on `TaskList` to
  find it — it isn't listed there.
- **Never push, merge, deploy, or mutate shared state autonomously.** Reply, do reversible in-worktree work,
  or escalate — that's the whole menu.
- **Don't hijack a pane Michael is actively using.** A worker pane is dedicated to this loop; if Michael
  starts giving you real work here, stop the loop (`TaskStop` the Monitor too) — don't fight him for turns.
- Be terse. You're a responder, not a narrator.

## Turnaround

Sub-second: the Monitor turns a new `.notify` line straight into a wake and drain. Fully idle otherwise —
no polling, no timer ticks, no per-tick cost.

Start it with **`/loop /worker`** in any pane you want responding automatically. The main checkout runs
`/loop /foreman` instead (it's the conductor, not a worker).
