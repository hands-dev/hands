#!/usr/bin/env tsx
/**
 * agent-bus — a local stdio MCP coordination server for foreman/worker Claude
 * Code messaging.
 *
 * One process per Claude Code instance. State is a shared SQLite DB (WAL) under
 * `~/.claude/coordination/<repo-slug>/agent-bus.db` — auto-scoped per git repo,
 * so two projects on one machine never share a bus. No daemon — the DB file is
 * the single source of truth. Identity is derived at runtime from env + cwd
 * (the MCP registration is shared machine-wide): the repo's main checkout is
 * `foreman`, provisioned workers are `worker-<n>`.
 *
 * Known limitation: MCP cannot wake an idle interactive Claude Code. Delivery
 * is: the model calls `agent_bus_receive` at natural checkpoints (optionally a
 * parked long-poll), or a Monitor tails the per-agent `.notify` file. See README.
 */
import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildBoard, computeStateHash, IDLE_THRESHOLD_MS } from "./board.js";
import { type AgentBusConfig, loadConfig } from "./config.js";
import { pollGithub } from "./github.js";
import { isWorker, resolveAgentId, resolveAgentRef } from "./identity.js";
import { notify } from "./notify.js";
import { coordinationDir, dbPath, notifyPath, repoInfo } from "./paths.js";
import { readPriorities, writePriorities } from "./priorities.js";
import { runPublish } from "./publish.js";
import { journalDir, openJournal, readSyncStatus, resolveProject, syncPush } from "./remote.js";
import { type MessageRow, Store } from "./store.js";

const PRIORITIES_STALE_MS = 24 * 60 * 60_000;

const POLL_INTERVAL_MS = 250;
const MAX_WAIT_SECONDS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asToolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function presentMessage(row: MessageRow) {
  return {
    id: row.id,
    from: row.from_id,
    to: row.to_id ?? "*",
    subject: row.subject ?? undefined,
    body: row.body,
    thread: row.thread_id ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function buildServer(store: Store, agentId: string, config?: AgentBusConfig): McpServer {
  const cfg = config ?? loadConfig();
  const principal = cfg.principal.name;
  // Deliver a real wake: append .notify lines AND log them (wake accounting).
  // Every actual wake goes through here so wakesLastHour on the board stays true.
  const deliverWake = (recipients: readonly string[], meta: { from: string; subject?: string | null }) => {
    notify(recipients, meta);
    store.recordWakes(recipients);
    store.markWakePending(recipients);
  };
  const server = new McpServer(
    { name: "roundhouse", version: "0.1.0" },
    {
      instructions:
        `Per-repo agent message bus. You are agent "${agentId}". ` +
        "Refer to teammates by their canonical id (foreman, worker-1, …; see agent_bus_peers). " +
        "Use agent_bus_peers to discover the team, agent_bus_send to message one, and " +
        "agent_bus_receive to read messages addressed to you. Call agent_bus_receive at natural " +
        "checkpoints — MCP cannot wake you unprompted. Never put secrets in message bodies (the " +
        "shared DB stores them in plaintext). When you hit an open question or decision you can't " +
        "resolve alone, escalate it with agent_bus_ask — the foreman (the main checkout) adjudicates " +
        `against the day's priorities or bubbles it to ${principal}. When a PR is ready to merge, ask the ` +
        "foreman for the review-depth (/code-review vs the low variant) + merge (normal vs admin-merge) " +
        "call rather than deciding it yourself." +
        (agentId === "foreman"
          ? " You ARE the foreman / command center: run agent_bus_questions to see open questions, " +
            "agent_bus_priorities to read/set the ranked priorities, agent_bus_answer to resolve, " +
            `agent_bus_escalate to bubble one up to ${principal}. You also self-manage ${principal}'s personal ` +
            "to-do list: agent_bus_todo_add concrete things only they can do (idempotent via dedupKey), " +
            "and agent_bus_todo_update state='done' with a doneSignal when a strong signal (merged PR, " +
            "commit, memory write, answered escalation) shows they finished one."
          : ""),
    },
  );

  server.registerTool(
    "agent_bus_send",
    {
      title: "Send a message to another agent",
      description:
        "Enqueue a message to another agent on this repo's bus. `to` is a peer agent id " +
        `(foreman, worker-2, … — see agent_bus_peers), the principal ("${principal}"), or "*" to ` +
        "broadcast to everyone. Do not include secrets. Waking the recipient costs a full model " +
        "turn — for an FYI / status update that needs no immediate action, pass wake:false so it is " +
        "delivered on their next natural drain instead.",
      inputSchema: {
        to: z.string().describe('recipient agent id, or "*" for broadcast'),
        body: z.string(),
        subject: z.string().optional(),
        thread: z.string().optional(),
        wake: z
          .boolean()
          .optional()
          .describe("false = deliver silently on the recipient's next drain (no wake). Default true."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const to = resolveAgentRef(input.to);
      const broadcast = to === "*";
      // Strict hub-and-spoke: a worker may only address the foreman or the
      // principal. Rejected BEFORE any DB write or notify — a blocked send
      // must never wake anyone (that's the whole point of the topology).
      if (cfg.topology === "strict-hub" && isWorker(agentId)) {
        if (broadcast) {
          return {
            ...asToolResult({
              ok: false,
              error:
                "Only the foreman may broadcast. Send to the foreman instead — it relays what the team needs.",
            }),
            isError: true,
          };
        }
        if (isWorker(to)) {
          return {
            ...asToolResult({
              ok: false,
              error:
                "Direct worker-to-worker messaging is disabled. Route via the foreman — use agent_bus_ask " +
                "for a decision, or agent_bus_send({to:'foreman'}) for a handoff.",
            }),
            isError: true,
          };
        }
      }
      const id = store.insertMessage({
        from: agentId,
        to: broadcast ? null : to,
        body: input.body,
        subject: input.subject ?? null,
        thread: input.thread ?? null,
      });
      const recipients = broadcast
        ? store.listPeers().map((p) => p.id).filter((peerId) => peerId !== agentId)
        : [to];
      // The DB row is unconditional; only the wake (.notify append) is managed:
      //  - wake:false → an FYI, read on the recipient's next natural drain.
      //  - pending-wake suppression → recipient is already behind, so a wake is
      //    already outstanding and one drain returns everything anyway.
      const wake = input.wake ?? true;
      const woken = wake ? recipients.filter((r) => !store.hasPendingWake(r)) : [];
      if (woken.length > 0) deliverWake(woken, { from: agentId, subject: input.subject ?? null });
      return asToolResult({
        ok: true,
        id,
        to: broadcast ? "*" : to,
        delivered: recipients,
        woken,
      });
    },
  );

  server.registerTool(
    "agent_bus_receive",
    {
      title: "Receive messages addressed to me",
      description:
        "Return messages addressed to you (directed + broadcast) since your read cursor. " +
        "Long-polls up to wait_seconds, returning as soon as a message lands. Advances your " +
        "cursor when mark_read is true.",
      inputSchema: {
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional(),
        mark_read: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const waitSeconds = input.wait_seconds ?? 25;
      const markRead = input.mark_read ?? true;
      const deadline = Date.now() + waitSeconds * 1000;
      const cursor = store.getCursor(agentId);
      // Clear the pending-wake flag BEFORE reading: a send racing this drain
      // then wakes afresh (at worst one redundant wake, never a lost one).
      if (markRead) store.clearWakePending(agentId);

      let messages: MessageRow[] = [];
      // Long-poll: return as soon as something lands, else give up at the deadline.
      for (;;) {
        store.touch(agentId);
        messages = store.messagesSince(agentId, cursor);
        if (messages.length > 0 || Date.now() >= deadline) break;
        await sleep(POLL_INTERVAL_MS);
      }

      if (markRead && messages.length > 0) {
        store.setCursor(agentId, messages[messages.length - 1]!.id);
      }
      return asToolResult({
        agent: agentId,
        count: messages.length,
        cursor: markRead && messages.length > 0 ? messages[messages.length - 1]!.id : cursor,
        messages: messages.map(presentMessage),
      });
    },
  );

  server.registerTool(
    "agent_bus_peers",
    {
      title: "List registered worktree agents",
      description:
        "List every agent registered on this machine's bus and whether it is online (heartbeat " +
        "within the last 60s).",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      store.touch(agentId);
      const peers = store.listPeers().map((p) => ({
        id: p.id,
        online: p.online,
        cwd: p.cwd,
        pid: p.pid,
        lastSeenAt: new Date(p.last_seen_at).toISOString(),
        isSelf: p.id === agentId,
      }));
      return asToolResult({ me: agentId, peers });
    },
  );

  server.registerTool(
    "agent_bus_history",
    {
      title: "Read past messages",
      description:
        "Read past messages (audit). Optionally filter by peer (messages to/from that agent) or " +
        "thread id. Returns up to `limit` most-recent messages in chronological order.",
      inputSchema: {
        peer: z.string().optional(),
        thread: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const rows = store.history({
        peer: input.peer,
        thread: input.thread,
        limit: input.limit,
      });
      return asToolResult({ count: rows.length, messages: rows.map(presentMessage) });
    },
  );

  server.registerTool(
    "agent_bus_board",
    {
      title: "Read the standup board",
      description:
        "Snapshot of every agent: who's active (branch + last-active age), recent learnings " +
        "(commits + memory writes), and any file/ticket collisions with you. Always includes a cheap " +
        "`stateHash` fingerprint — if it matches your last pass, nothing moved and you can skip a " +
        "deeper re-scan. Pass full:true to bundle active tasks + open questions + the priorities " +
        "digest into this ONE read (instead of separate tasks/questions/priorities calls).",
      inputSchema: {
        full: z
          .boolean()
          .optional()
          .describe("true = also bundle active tasks, open questions, and the priorities digest"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const now = Date.now();
      const wakes = store.wakeCounts(now);
      const peers = store.listPeers(now).map((p) => {
        const activeAge = p.last_active ? now - p.last_active : null;
        return {
          id: p.id,
          isSelf: p.id === agentId,
          online: p.online,
          branch: p.branch ?? undefined,
          state: activeAge !== null && activeAge <= IDLE_THRESHOLD_MS ? "active" : "idle",
          lastActive: p.last_active ? new Date(p.last_active).toISOString() : undefined,
          // wake accounting: each wake re-processes this agent's whole context,
          // so cost ≈ wakes × context size. Spot the chatty hotspots here.
          wakesLastHour: wakes.get(p.id)?.lastHour ?? 0,
          wakes24h: wakes.get(p.id)?.last24h ?? 0,
        };
      });
      const journal = store.journalSince(0, 20).map((j) => ({
        by: j.agent_id,
        kind: j.kind,
        text: j.text,
        at: new Date(j.created_at).toISOString(),
      }));
      // Reuse the delta builder purely to surface current collisions (no advance).
      const board = buildBoard(store, { agentId, since: now, advance: false, now });
      const base = {
        me: agentId,
        stateHash: computeStateHash(store, now),
        peers,
        recentJournal: journal,
        collisions: board.collisions,
      };
      if (!input.full) return asToolResult(base);

      // full:true — the foreman's bundled pass: one read instead of four.
      const activeTasks = store.listTasks({ active: true }).map((t) => ({
        id: t.id,
        title: t.title,
        assignee: t.assignee ?? "queue",
        state: t.state,
        priority: t.priority_ref ?? undefined,
        updatedAt: new Date(t.updated_at).toISOString(),
      }));
      const openQuestions = store.listQuestions({ state: "open" }).map((q) => ({
        id: q.id,
        asker: q.asker,
        question: q.question,
        context: q.context ?? undefined,
        askedAt: new Date(q.created_at).toISOString(),
      }));
      const p = readPriorities();
      const confirmedRaw = store.getWatermark("*", "priorities_confirmed_at");
      const confirmedAt = confirmedRaw ? Number(confirmedRaw) : null;
      return asToolResult({
        ...base,
        activeTasks,
        openQuestions,
        priorities: {
          items: p.items,
          set: p.items.length > 0,
          stale: confirmedAt == null || now - confirmedAt > PRIORITIES_STALE_MS,
        },
      });
    },
  );

  server.registerTool(
    "agent_bus_paths",
    {
      title: "Where does this agent resolve? (paths + identity + journal health)",
      description:
        "Your canonical identity and this repo's bus locations: agentId, coordinationDir, db, your " +
        ".notify file (arm your Monitor on it), repo root/slug, and the durable-journal sync health. " +
        "The bus is scoped per repo — always read paths from here, never guess them.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      store.touch(agentId);
      return asToolResult(pathsReport(agentId, cfg));
    },
  );

  // --- foreman / questions ---

  server.registerTool(
    "agent_bus_ask",
    {
      title: "Escalate an open question to the foreman",
      description:
        "Raise an open question or decision you can't resolve alone. The foreman (main checkout) " +
        `adjudicates against the day's priorities or bubbles it up to ${principal}. Include enough ` +
        "context to decide; propose options if you have them.",
      inputSchema: {
        question: z.string(),
        context: z.string().optional().describe("what's blocked, options, your lean"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const id = store.askQuestion({ asker: agentId, question: input.question, context: input.context ?? null });
      deliverWake(["foreman"], { from: agentId, subject: "question" });
      return asToolResult({ ok: true, id, routedTo: "foreman" });
    },
  );

  server.registerTool(
    "agent_bus_questions",
    {
      title: "List questions on the bus",
      description:
        "List questions. Foreman inbox = state 'open'. States: open | needs_human | answered. " +
        "Omit state for all recent.",
      inputSchema: {
        state: z.enum(["open", "needs_human", "answered"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const rows = store.listQuestions({ state: input.state, limit: input.limit });
      return asToolResult({
        count: rows.length,
        questions: rows.map((q) => ({
          id: q.id,
          asker: q.asker,
          question: q.question,
          context: q.context ?? undefined,
          state: q.state,
          answer: q.answer ?? undefined,
          resolvedBy: q.resolved_by ?? undefined,
          priority: q.priority_ref ?? undefined,
          recommendation: q.recommendation ?? undefined,
          askedAt: new Date(q.created_at).toISOString(),
        })),
      });
    },
  );

  server.registerTool(
    "agent_bus_answer",
    {
      title: "Answer a question (resolve it)",
      description:
        "Resolve a question and route the answer back to the asker. Set by='human' when relaying " +
        `${principal}'s decision, 'foreman' when you auto-resolved it. Cite which priority it mapped to.`,
      inputSchema: {
        id: z.number().int(),
        answer: z.string(),
        by: z.enum(["foreman", "human"]).optional(),
        priority: z.string().optional().describe("the priority this maps to"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const q = store.getQuestion(input.id);
      if (!q) return { ...asToolResult({ ok: false, error: "no such question" }), isError: true };
      store.answerQuestion({
        id: input.id,
        answer: input.answer,
        resolvedBy: input.by ?? "foreman",
        priorityRef: input.priority ?? null,
      });
      deliverWake([q.asker], { from: "foreman", subject: "answer" });
      return asToolResult({ ok: true, id: input.id, asker: q.asker });
    },
  );

  server.registerTool(
    "agent_bus_escalate",
    {
      title: "Bubble a question up to the principal",
      description:
        `Mark a question as needing ${principal}'s decision (shows in the dashboard 'Needs you' lane). ` +
        "Include your recommendation and the priority it touches. Then present it to him and, once " +
        "he decides, call agent_bus_answer with by='human'.",
      inputSchema: {
        id: z.number().int(),
        recommendation: z.string().optional(),
        priority: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const q = store.getQuestion(input.id);
      if (!q) return { ...asToolResult({ ok: false, error: "no such question" }), isError: true };
      store.escalateQuestion({
        id: input.id,
        recommendation: input.recommendation ?? null,
        priorityRef: input.priority ?? null,
      });
      return asToolResult({ ok: true, id: input.id });
    },
  );

  server.registerTool(
    "agent_bus_rec_outcome",
    {
      title: "Record a recommendation's hindsight outcome (foreman self-audit)",
      description:
        "The foreman's introspection. After one of your recommendations has played out, record whether it " +
        "HELD UP ('validated') or was OVERTURNED by a later finding ('contradicted'), with a short " +
        `reason. This grades YOUR OWN judgment in hindsight — not whether ${principal} accepted the advice ` +
        "— and feeds the foreman-effectiveness score on the dashboard. Run it as part of your routine: " +
        "revisit recent recommendations, and when a worker's later finding overturns a call you made, " +
        `mark it 'contradicted' honestly (that is the signal ${principal} wants to see degrade the score).`,
      inputSchema: {
        id: z.number().int().describe("the question/recommendation id to grade"),
        outcome: z.enum(["validated", "contradicted"]),
        note: z.string().optional().describe("short reason the call held up or was overturned"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const q = store.getQuestion(input.id);
      if (!q) return { ...asToolResult({ ok: false, error: "no such question" }), isError: true };
      store.setQuestionOutcome({ id: input.id, outcome: input.outcome, note: input.note ?? null });
      return asToolResult({ ok: true, id: input.id, outcome: input.outcome });
    },
  );

  server.registerTool(
    "agent_bus_priorities",
    {
      title: "Read or set the foreman's ranked priorities",
      description:
        "No args: read the current ranked priorities (+ whether they're stale/unset). Pass `set` to " +
        "replace them (ranked, most-important first). Pass confirm=true to mark the existing list " +
        `still-current. If items is empty/unset, ask ${principal} for today's priorities.`,
      inputSchema: {
        set: z.array(z.string()).optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const now = Date.now();
      if (input.set) {
        writePriorities(input.set);
        store.setWatermark("*", "priorities_confirmed_at", String(now));
        // priorities live in a file, not the DB — journal them explicitly
        store.journal("priorities.set", { items: input.set, at: now });
      } else if (input.confirm) {
        store.setWatermark("*", "priorities_confirmed_at", String(now));
      }
      const p = readPriorities();
      const confirmedRaw = store.getWatermark("*", "priorities_confirmed_at");
      const confirmedAt = confirmedRaw ? Number(confirmedRaw) : null;
      const stale = confirmedAt == null || now - confirmedAt > PRIORITIES_STALE_MS;
      return asToolResult({
        items: p.items,
        set: p.items.length > 0,
        confirmedAt: confirmedAt ? new Date(confirmedAt).toISOString() : null,
        stale,
        needsInput: p.items.length === 0,
      });
    },
  );

  // --- delegation (foreman → worktree tasks) ---

  server.registerTool(
    "agent_bus_delegate",
    {
      title: "Delegate a task to a worker",
      description:
        "Hand a unit of real work to a worker (foreman use). `to` = a worker agent id " +
        '(worker-1, worker-2, …), or omit for the unassigned queue ("any available worker"). The ' +
        "first step for a fresh priority is usually a plan. Include enough detail to act; cite the priority.",
      inputSchema: {
        title: z.string(),
        body: z.string().optional(),
        to: z.string().optional(),
        priority: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      // Strict hub-and-spoke: delegation flows downward from the hub only.
      if (cfg.topology === "strict-hub" && isWorker(agentId)) {
        return {
          ...asToolResult({
            ok: false,
            error:
              "Workers don't delegate tasks. Hand work upward instead: agent_bus_ask for a decision, or " +
              "agent_bus_send({to:'foreman'}) to propose the task — the foreman delegates it.",
          }),
          isError: true,
        };
      }
      const assignee = input.to ? resolveAgentRef(input.to) : null;
      const id = store.createTask({
        createdBy: agentId,
        assignee,
        title: input.title,
        body: input.body ?? null,
        priority: input.priority ?? null,
      });
      if (assignee) deliverWake([assignee], { from: agentId, subject: "task" });
      return asToolResult({ ok: true, id, assignedTo: assignee ?? "queue" });
    },
  );

  server.registerTool(
    "agent_bus_tasks",
    {
      title: "List delegated tasks",
      description:
        "List tasks. A worktree checks its own with assignee=<me>; the foreman omits filters or uses " +
        "active=true. States: open | assigned | in_progress | returned | done | cancelled.",
      inputSchema: {
        state: z.enum(["open", "assigned", "in_progress", "returned", "done", "cancelled"]).optional(),
        assignee: z.string().optional(),
        active: z.boolean().optional().describe("only open/assigned/in_progress/returned"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const rows = store.listTasks({
        state: input.state,
        assignee: input.assignee,
        active: input.active,
        limit: input.limit,
      });
      return asToolResult({
        count: rows.length,
        tasks: rows.map((t) => ({
          id: t.id,
          title: t.title,
          body: t.body ?? undefined,
          from: t.created_by,
          assignee: t.assignee ?? "queue",
          state: t.state,
          result: t.result ?? undefined,
          priority: t.priority_ref ?? undefined,
          updatedAt: new Date(t.updated_at).toISOString(),
        })),
      });
    },
  );

  server.registerTool(
    "agent_bus_task_update",
    {
      title: "Advance a delegated task",
      description:
        "Move a task through its lifecycle. Worker: 'in_progress' when you start (claims an unassigned one), " +
        "'returned' with result when you report back. Foreman: 'done' to accept, 'cancelled' to drop.",
      inputSchema: {
        id: z.number().int(),
        state: z.enum(["in_progress", "returned", "done", "cancelled"]),
        result: z.string().optional().describe("the artifact/summary when returning"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const task = store.getTask(input.id);
      if (!task) return { ...asToolResult({ ok: false, error: "no such task" }), isError: true };
      // Claiming an unassigned task on start.
      const claim = input.state === "in_progress" && !task.assignee ? agentId : null;
      store.updateTaskState({
        id: input.id,
        state: input.state,
        assignee: claim,
        result: input.result ?? null,
      });
      if (input.state === "returned") {
        deliverWake([task.created_by], { from: agentId, subject: "task returned" });
      }
      return asToolResult({ ok: true, id: input.id, state: input.state });
    },
  );

  // --- todos (foreman-managed personal to-do list for the principal) ---

  server.registerTool(
    "agent_bus_todos",
    {
      title: "Read the principal's to-do list",
      description:
        `List the personal to-do items the foreman is tracking for ${principal}. No args: everything ` +
        "(open first). Pass state to filter: open | done | dismissed. Read-only — the foreman " +
        "manages the list via agent_bus_todo_add / agent_bus_todo_update.",
      inputSchema: {
        state: z.enum(["open", "done", "dismissed"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const rows = store.listTodos({ state: input.state, limit: input.limit });
      // Open items surface first; then most-recently-touched.
      const rank = (s: string) => (s === "open" ? 0 : 1);
      rows.sort((a, b) => rank(a.state) - rank(b.state) || b.updated_at - a.updated_at);
      return asToolResult({
        count: rows.length,
        open: rows.filter((t) => t.state === "open").length,
        todos: rows.map((t) => ({
          id: t.id,
          title: t.title,
          detail: t.detail ?? undefined,
          state: t.state,
          source: t.source,
          origin: t.origin_ref ?? undefined,
          priority: t.priority_ref ?? undefined,
          doneSignal: t.done_signal ?? undefined,
          updatedAt: new Date(t.updated_at).toISOString(),
        })),
      });
    },
  );

  server.registerTool(
    "agent_bus_todo_add",
    {
      title: "Add an item to the principal's to-do list",
      description:
        `Add a concrete thing only ${principal} can personally do (a decision, a merge/review click, a ` +
        "reply he owes) to his to-do list. Foreman-managed. Idempotent while open: pass a stable " +
        "`dedupKey` (e.g. the PR#, question id, or a normalized title) so re-deriving the same item " +
        "each pass never duplicates it — an existing open match is returned untouched. Set " +
        "`origin` (what surfaced it) and `priority` (which ranked priority it maps to) for provenance.",
      inputSchema: {
        title: z.string(),
        detail: z.string().optional(),
        dedupKey: z.string().optional().describe("stable identity to prevent re-adds while open"),
        origin: z.string().optional().describe("what spawned it — PR#, question id, priority text"),
        priority: z.string().optional(),
        source: z.enum(["foreman", "human"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const { id, isNew } = store.createTodo({
        title: input.title,
        detail: input.detail ?? null,
        dedupKey: input.dedupKey ?? null,
        originRef: input.origin ?? null,
        priority: input.priority ?? null,
        source: input.source ?? "foreman",
      });
      return asToolResult({ ok: true, id, isNew });
    },
  );

  server.registerTool(
    "agent_bus_todo_update",
    {
      title: "Cross off / dismiss / re-open a to-do",
      description:
        "Change a to-do's state. 'done' crosses it off — pass `doneSignal` describing HOW you " +
        "inferred completion (e.g. 'PR #2354 merged', 'commit abc123', 'escalation #7 answered') so " +
        "the auto-cross-off stays transparent and reversible. 'dismissed' drops an item that's no " +
        "longer relevant; 'open' re-opens one.",
      inputSchema: {
        id: z.number().int(),
        state: z.enum(["open", "done", "dismissed"]),
        doneSignal: z.string().optional().describe("how completion was inferred (for 'done')"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const todo = store.getTodo(input.id);
      if (!todo) return { ...asToolResult({ ok: false, error: "no such todo" }), isError: true };
      store.updateTodoState({ id: input.id, state: input.state, doneSignal: input.doneSignal ?? null });
      return asToolResult({ ok: true, id: input.id, state: input.state });
    },
  );

  // --- foreman-only: team-awareness GitHub poll + digest notes ---
  if (agentId === "foreman") {
    server.registerTool(
      "agent_bus_digest_note",
      {
        title: "Add a prose note to today's journal digest (foreman only)",
        description:
          "Record a short narrative note (2–5 lines) into the durable journal's daily digest — " +
          "the end-of-day wrap-up a human reads when browsing the journal repo. Renders under " +
          "'Notes' in journal/<project>/<handle>/<date>.md on the next sync. No-op guidance: " +
          "requires remote journaling (config remote.url); notes are plaintext in the journal repo.",
        inputSchema: { text: z.string().min(1).max(2000) },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (input) => {
        store.touch(agentId);
        if (!cfg.remote.url?.trim()) {
          return {
            ...asToolResult({ ok: false, error: "remote journaling is not configured (remote.url)" }),
            isError: true,
          };
        }
        store.journal("digest.note", { text: input.text, at: Date.now() });
        return asToolResult({ ok: true, rendersOn: "next journal sync" });
      },
    );

    server.registerTool(
      "agent_bus_gh_poll",
      {
        title: "Poll GitHub for other engineers' PRs (foreman only)",
        description:
          "Record what OTHER engineers are shipping (open + recently-merged PRs on this repo, " +
          "excluding the principal's) for the dashboard team lane and per-worker relevance matching. " +
          "Network call — run once every few passes, not every tick" +
          (cfg.gh.poll ? "." : ". NOTE: gh.poll is disabled in this repo's config — skip it."),
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async () => {
        store.touch(agentId);
        const r = pollGithub(store, { cwd: process.cwd() });
        if (!r.ok) return asToolResult({ ok: false, error: r.error }); // best-effort, not isError
        return asToolResult({
          ok: true,
          repo: r.repo,
          fromOthers: r.fromOthers,
          new: r.new,
          updated: r.updated,
        });
      },
    );
  }

  // --- foreman-directed scaling (spins up/retires local worker sessions) ---
  // Registered ONLY for the foreman, and only when the config opts in — these
  // launch local processes, so they're off unless explicitly enabled.
  if (agentId === "foreman" && cfg.workers.allowForemanScaling) {
    const presentPlans = (plans: import("./provision.js").LaunchPlan[]) =>
      plans.map((p) => ({
        id: p.id,
        model: p.model,
        launched: p.launched,
        launcher: p.launcher,
        // when not auto-launched, this is the command to hand to the principal
        pasteCommand: p.launched ? undefined : p.command,
      }));

    server.registerTool(
      "agent_bus_worker_add",
      {
        title: "Spin up more workers (foreman only)",
        description:
          "Provision and launch `count` new worker sessions for this repo. Use when the ranked " +
          "priorities are under-staffed. Each worker appears on the board as worker-<n> once its " +
          "session takes its first turn. If the launcher is manual, relay the pasteCommand to " +
          `${principal} to start the pane.`,
        inputSchema: { count: z.number().int().min(1).max(12).optional() },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (input) => {
        store.touch(agentId);
        const { addWorkers } = await import("./provision.js");
        try {
          return asToolResult({ ok: true, added: presentPlans(addWorkers(input.count ?? 1)) });
        } catch (err) {
          return { ...asToolResult({ ok: false, error: String(err) }), isError: true };
        }
      },
    );

    server.registerTool(
      "agent_bus_worker_remove",
      {
        title: "Retire a worker (foreman only)",
        description:
          "Stop a worker's session and remove its managed workspace. Refuses if the worker has " +
          "uncommitted work unless force:true. Idempotent.",
        inputSchema: {
          id: z.string().describe("worker-<n>"),
          force: z.boolean().optional().describe("true = discard uncommitted work"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async (input) => {
        store.touch(agentId);
        const { removeWorker } = await import("./provision.js");
        try {
          return asToolResult({ ok: true, ...removeWorker(input.id, { force: input.force }) });
        } catch (err) {
          return { ...asToolResult({ ok: false, error: String(err) }), isError: true };
        }
      },
    );

    server.registerTool(
      "agent_bus_scale",
      {
        title: "Scale the worker pool (foreman only)",
        description:
          "Reconcile the pool to exactly `target` workers — adds or retires as needed (highest " +
          "index retired first; refuses to discard uncommitted work unless force:true).",
        inputSchema: {
          target: z.number().int().min(0).max(12),
          force: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async (input) => {
        store.touch(agentId);
        const { scaleWorkers } = await import("./provision.js");
        try {
          const res = scaleWorkers(input.target, { force: input.force });
          return asToolResult({ ok: true, added: presentPlans(res.added), removed: res.removed });
        } catch (err) {
          return { ...asToolResult({ ok: false, error: String(err) }), isError: true };
        }
      },
    );
  }

  return server;
}

/** Resolve this process's agent id (config foreman.basename included). */
function resolveSelf(): string {
  return resolveAgentId({ foremanBasename: loadConfig().foreman.basename });
}

/**
 * Where does this process resolve? Shared by the `paths` CLI subcommand, the
 * `roundhouse paths` CLI, and the agent_bus_paths MCP tool — the one authority
 * agents consult instead of guessing per-repo paths.
 */
export function pathsReport(agentId: string, cfg: AgentBusConfig) {
  const info = repoInfo();
  const enabled = Boolean(cfg.remote.url?.trim());
  const journal = enabled ? readSyncStatus(journalDir()) : null;
  return {
    cwd: process.cwd(),
    agentId,
    repoRoot: info?.repoRoot ?? null,
    isMainWorktree: info?.isMainWorktree ?? null,
    slug: info?.slug ?? "_global",
    coordinationDir: coordinationDir(),
    db: dbPath(),
    notify: notifyPath(agentId),
    journalProject: enabled ? resolveProject(cfg) : null,
    journalSync: journal
      ? { ...journal, at: new Date(journal.at).toISOString() }
      : enabled
        ? "never-synced"
        : "disabled",
  };
}

function runCli(subcommand: string, argv: string[]): number {
  if (subcommand === "paths") {
    // Debug: where does this cwd resolve? (isolation check — no DB touch)
    process.stdout.write(`${JSON.stringify(pathsReport(resolveSelf(), loadConfig()), null, 2)}\n`);
    return 0;
  }
  const agentId = resolveSelf();
  const store = new Store();
  const journal = openJournal({ agentId });
  if (journal) store.setJournal(journal.append);
  try {
    if (subcommand === "publish") {
      runPublish(store, { agentId, cwd: process.cwd() });
      // Durable-journal push rides the turn-end publish (debounced inside).
      if (journal) syncPush(journal);
      return 0;
    }
    if (subcommand === "board") {
      const sinceArg = argv.find((a) => a.startsWith("--since="));
      const since = sinceArg ? Number(sinceArg.slice("--since=".length)) : undefined;
      const advance = !argv.includes("--peek");
      const { text } = buildBoard(store, { agentId, since, advance });
      if (text) process.stdout.write(`${text}\n`);
      return 0;
    }
    if (subcommand === "gh-poll") {
      const r = pollGithub(store, { cwd: process.cwd() });
      if (!r.ok) {
        process.stdout.write(`gh-poll: ${r.error}\n`);
        return 0; // best-effort — not a hard failure
      }
      process.stdout.write(
        `gh-poll: ${r.repo} — ${r.fromOthers} PRs from others (${r.new} new, ${r.updated} updated)\n`,
      );
      return 0;
    }
    process.stderr.write(`[agent-bus] unknown subcommand: ${subcommand}\n`);
    return 2;
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  if (
    subcommand === "publish" ||
    subcommand === "board" ||
    subcommand === "gh-poll" ||
    subcommand === "paths"
  ) {
    process.exit(runCli(subcommand, process.argv.slice(3)));
  }
  if (subcommand === "serve") {
    const { serve } = await import("./serve.js");
    const handle = await serve();
    process.stdout.write(`roundhouse dashboard → ${handle.url}\n(Ctrl-C to stop)\n`);
    if (!process.argv.includes("--no-open") && process.platform === "darwin") {
      const { spawn } = await import("node:child_process");
      try {
        spawn("open", [handle.url], { detached: true, stdio: "ignore" }).unref();
      } catch {
        // opening the browser is a nicety, not a requirement
      }
    }
    return; // the http server keeps the process alive
  }
  const agentId = resolveSelf();
  const store = new Store();
  const journal = openJournal({ agentId });
  if (journal) store.setJournal(journal.append);
  store.registerAgent({ id: agentId, cwd: process.cwd(), pid: process.pid });
  const server = buildServer(store, agentId);
  await server.connect(new StdioServerTransport());
}

// Only run when executed directly (not when imported by tests). Compare as
// URLs with realpath'd sides — a raw string compare breaks on spaces
// (percent-encoding) and symlinks, both possible in plugin install paths.
// The plugin bundle runs behind a version-gate wrapper (argv[1] = wrapper,
// not this module), which signals through AGENT_BUS_FORCE_MAIN instead.
const invokedDirectly = (() => {
  if (process.env.AGENT_BUS_FORCE_MAIN === "1") return true;
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    const entry = pathToFileURL(fs.realpathSync(argv1)).href;
    const self = pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;
    return entry === self;
  } catch {
    return import.meta.url === pathToFileURL(argv1).href;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    // stderr is safe — stdout is the MCP protocol channel.
    console.error("[agent-bus] fatal:", err);
    process.exit(1);
  });
}
