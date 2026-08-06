#!/usr/bin/env tsx
/**
 * hands — a local stdio MCP coordination server for expo/station Claude
 * Code messaging.
 *
 * One process per Claude Code instance. State is a shared SQLite DB (WAL) under
 * `~/.claude/coordination/<repo-slug>/hands.db` — auto-scoped per git repo,
 * so two projects on one machine never share a bus. No daemon — the DB file is
 * the single source of truth. Identity is derived at runtime from env + cwd
 * (the MCP registration is shared machine-wide): the repo's main checkout is
 * `expo` (the expeditor), provisioned stations are `station-<n>`.
 *
 * Known limitation: MCP cannot wake an idle interactive Claude Code. Delivery
 * is: the model calls `hands_receive` at natural checkpoints (optionally a
 * parked long-poll), or a Monitor tails the per-agent `.notify` file. See README.
 */
import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildBoard, computeStateHash, IDLE_THRESHOLD_MS } from "./board.js";
import { type HandsConfig, loadConfig } from "./config.js";
import { pollGithub } from "./github.js";
import { isExpo, isStation, resolveAgentId, resolveAgentRef } from "./identity.js";
import { notify } from "./notify.js";
import { coordinationDir, dbPath, notifyPath, repoInfo } from "./paths.js";
import { readPriorities, writePriorities } from "./priorities.js";
import { runPublish } from "./publish.js";
import {
  craftFiles,
  journalDir,
  openJournal,
  readSyncStatus,
  resolveProject,
  syncPush,
} from "./remote.js";
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

/**
 * The CRAFT a station holds (its focus label), injected into its MCP
 * instructions at connect — this is what makes a rebooted (or machine-moved,
 * when the books carry the files) station come up already knowing its craft.
 * The seat is furniture; the craft is portable. Capped per file so a
 * neglected book can't blow up the context. Instructions are static per
 * connection, so mid-session swaps are delivered by the expo as a waking
 * message + a hands_paths re-read (which resolves from CURRENT focus).
 */
export function craftContext(
  agentId: string,
  store: Store,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  if (!isStation(agentId)) return "";
  const craft = store.getFocus(agentId);
  if (!craft) {
    return (
      "\n\nYou hold no craft yet — the expo assigns one via hands_focus. Until then work " +
      "tickets generically; once assigned, your craft's book + skill arrive via hands_paths."
    );
  }
  const files = craftFiles(craft, env, cwd);
  const read = (file: string, cap = 6000): string | null => {
    try {
      const body = fs.readFileSync(file, "utf8").trim();
      if (!body) return null;
      const points = Array.from(body);
      return points.length <= cap ? body : `${points.slice(0, cap).join("")}\n…(truncated — trim this file)`;
    } catch {
      return null;
    }
  };
  const skill = read(files.skill);
  const book = read(files.book);
  const header =
    `\n\n## Your craft: ${craft}\n` +
    "The craft is portable — if the expo reassigns yours mid-session you'll get a waking " +
    "message; re-read your files via hands_paths (they always resolve from your CURRENT craft). " +
    "If the book's `last held` stamp is not today, READ IN before cooking: what shipped in your " +
    "covered area since then (your station skill's read-in step).";
  if (!skill && !book) {
    return `${header}\nNo book or skill written for this craft yet — you are founding it.`;
  }
  return (
    header +
    (skill ? `\n\n### Craft skill (self-maintained — ${files.skill})\n${skill}` : "") +
    (book ? `\n\n### Prep book (self-maintained — ${files.book})\n${book}` : "")
  );
}

export function buildServer(store: Store, agentId: string, config?: HandsConfig): McpServer {
  const cfg = config ?? loadConfig();
  const principal = cfg.principal.name;
  // Resolve a recipient ref: canonical/legacy ids pass through; anything else
  // tries the focus-label lookup ("developer API" → station-2). Label matches
  // are a live-lookup convenience — ids remain the only durable routing keys.
  const resolveRecipient = (ref: string): { id: string } | { error: string } => {
    const id = resolveAgentRef(ref);
    if (id === "*" || isExpo(id) || isStation(id)) return { id };
    const peers = new Set(store.listPeers().map((p) => p.id));
    if (peers.has(id)) return { id };
    const byFocus = store.findByFocus(id);
    if (byFocus.length === 1) return { id: byFocus[0]! };
    if (byFocus.length > 1) {
      return { error: `focus label "${ref}" is ambiguous — matches: ${byFocus.join(", ")}` };
    }
    return { id }; // unknown ref (e.g. the principal) — passes through as before
  };

  // Deliver a real wake: append .notify lines AND log them (wake accounting).
  // Every actual wake goes through here so wakesLastHour on the board stays true.
  const deliverWake = (recipients: readonly string[], meta: { from: string; subject?: string | null }) => {
    notify(recipients, meta);
    store.recordWakes(recipients);
    store.markWakePending(recipients);
  };
  const server = new McpServer(
    { name: "hands", version: "0.1.0" },
    {
      instructions:
        `Per-repo agent message bus. You are agent "${agentId}". ` +
        "Refer to teammates by their canonical id (expo, station-1, …; see hands_peers). " +
        "Use hands_peers to discover the team, hands_send to message one, and " +
        "hands_receive to read messages addressed to you. Call hands_receive at natural " +
        "checkpoints — MCP cannot wake you unprompted. Never put secrets in message bodies (the " +
        "shared DB stores them in plaintext). When you hit an open question or decision you can't " +
        "resolve alone, escalate it with hands_ask — the expo (the main checkout) adjudicates " +
        `against the day's priorities or bubbles it to ${principal}. When a PR is ready to merge, ask the ` +
        "expo for the review-depth (/code-review vs the low variant) + merge (normal vs admin-merge) " +
        "call rather than deciding it yourself." +
        (isExpo(agentId)
          ? " You ARE the expo — the expeditor at the pass / command center: run hands_questions, " +
            "hands_priorities to read/set the ranked priorities, hands_answer to resolve, " +
            `hands_escalate to bubble one up to ${principal}. You also self-manage ${principal}'s personal ` +
            "to-do list: hands_todo_add concrete things only they can do (idempotent via dedupKey), " +
            "and hands_todo_update state='done' with a doneSignal when a strong signal (merged PR, " +
            "commit, memory write, answered escalation) shows they finished one."
          : "") +
        (isStation(agentId)
          ? " Keep your CRAFT's files current (paths in hands_paths): its PREP BOOK (distilled " +
            "knowledge — rewrite, don't append; ≤150 lines) and its CRAFT SKILL (its operating " +
            "manual). Update them on idle wakes and before any /compact — the craft, not the " +
            "seat, is how expertise survives reboots, machine moves, and reassignment."
          : "") +
        craftContext(agentId, store),
    },
  );

  server.registerTool(
    "hands_send",
    {
      title: "Send a message to another agent",
      description:
        "Enqueue a message to another agent on this repo's bus. `to` is a peer agent id " +
        `(expo, station-2, … — see hands_peers), the principal ("${principal}"), or "*" to ` +
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
      const resolved = resolveRecipient(input.to);
      if ("error" in resolved) {
        return { ...asToolResult({ ok: false, error: resolved.error }), isError: true };
      }
      const to = resolved.id;
      const broadcast = to === "*";
      // Strict hub-and-spoke: a station may only address the expo or the
      // principal. Rejected BEFORE any DB write or notify — a blocked send
      // must never wake anyone (that's the whole point of the topology).
      if (cfg.topology === "strict-hub" && isStation(agentId)) {
        if (broadcast) {
          return {
            ...asToolResult({
              ok: false,
              error:
                "Only the expo may broadcast. Send to the expo instead — it relays what the team needs.",
            }),
            isError: true,
          };
        }
        if (isStation(to)) {
          return {
            ...asToolResult({
              ok: false,
              error:
                "Direct station-to-station messaging is disabled. Route via the expo — use hands_ask " +
                "for a decision, or hands_send({to:'expo'}) for a handoff.",
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
    "hands_receive",
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
    "hands_peers",
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
        focus: p.focus ?? undefined,
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
    "hands_history",
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
    "hands_board",
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
          focus: p.focus ?? undefined,
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

      // full:true — the expo's bundled pass: one read instead of four.
      const activeTasks = store.listTasks({ active: true }).map((t) => ({
        id: t.id,
        title: t.title,
        assignee: t.assignee ?? "queue",
        state: t.state,
        priority: t.priority_ref ?? undefined,
        dish: t.dish ?? undefined,
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
    "hands_paths",
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
      return asToolResult(pathsReport(agentId, cfg, store.getFocus(agentId)));
    },
  );

  // --- expo / questions ---

  server.registerTool(
    "hands_ask",
    {
      title: "Escalate an open question to the expo",
      description:
        "Raise an open question or decision you can't resolve alone. The expo (main checkout) " +
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
      deliverWake(["expo"], { from: agentId, subject: "question" });
      return asToolResult({ ok: true, id, routedTo: "expo" });
    },
  );

  server.registerTool(
    "hands_questions",
    {
      title: "List questions on the bus",
      description:
        "List questions. Expo inbox = state 'open'. States: open | needs_human | answered. " +
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
    "hands_answer",
    {
      title: "Answer a question (resolve it)",
      description:
        "Resolve a question and route the answer back to the asker. Set by='human' when relaying " +
        `${principal}'s decision, 'expo' when you (the expo) auto-resolved it. Cite which priority it mapped to.`,
      inputSchema: {
        id: z.number().int(),
        answer: z.string(),
        by: z.enum(["expo", "human"]).optional(),
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
        resolvedBy: input.by ?? "expo",
        priorityRef: input.priority ?? null,
      });
      deliverWake([q.asker], { from: "expo", subject: "answer" });
      return asToolResult({ ok: true, id: input.id, asker: q.asker });
    },
  );

  server.registerTool(
    "hands_escalate",
    {
      title: "Bubble a question up to the principal",
      description:
        `Mark a question as needing ${principal}'s decision (shows in the dashboard 'Needs you' lane). ` +
        "Include your recommendation and the priority it touches. Then present it to him and, once " +
        "he decides, call hands_answer with by='human'.",
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
    "hands_rec_outcome",
    {
      title: "Record a recommendation's hindsight outcome (expo self-audit)",
      description:
        "The expo's introspection. After one of your recommendations has played out, record whether it " +
        "HELD UP ('validated') or was OVERTURNED by a later finding ('contradicted'), with a short " +
        `reason. This grades YOUR OWN judgment in hindsight — not whether ${principal} accepted the advice ` +
        "— and feeds the expo-effectiveness score on the dashboard. Run it as part of your routine: " +
        "revisit recent recommendations, and when a station's later finding overturns a call you made, " +
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
    "hands_priorities",
    {
      title: "Read or set the menu — the expo's ranked priorities",
      description:
        "No args: read the current ranked priorities (+ whether they're stale/unset). Pass `set` to " +
        "replace them (ranked, most-important first). Pass confirm=true to mark the existing list " +
        `still-current. If items is empty/unset, ask ${principal} for today's menu (ranked priorities).`,
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

  // --- tickets (expo → station delegation) ---

  server.registerTool(
    "hands_delegate",
    {
      title: "Fire a ticket to a station (delegate a task)",
      description:
        "Hand a ticket (a unit of real work) to a station — expo use. `to` = a station agent id " +
        '(station-1, station-2, …), or omit for the unassigned rail ("any available station"). The ' +
        "first step for a fresh priority is usually a plan. Include enough detail to act; cite the priority.",
      inputSchema: {
        title: z.string(),
        body: z.string().optional(),
        to: z.string().optional(),
        priority: z.string().optional(),
        dish: z
          .string()
          .optional()
          .describe('the DISH this ticket helps assemble — external ref ("ENG-1476", "PR #2455")'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      // Strict hub-and-spoke: delegation flows downward from the hub only.
      if (cfg.topology === "strict-hub" && isStation(agentId)) {
        return {
          ...asToolResult({
            ok: false,
            error:
              "Stations don't fire tickets. Hand work upward instead: hands_ask for a decision, or " +
              "hands_send({to:'expo'}) to propose the ticket — the expo delegates it.",
          }),
          isError: true,
        };
      }
      let assignee: string | null = null;
      if (input.to) {
        const resolved = resolveRecipient(input.to);
        if ("error" in resolved) {
          return { ...asToolResult({ ok: false, error: resolved.error }), isError: true };
        }
        assignee = resolved.id;
      }
      const id = store.createTask({
        createdBy: agentId,
        assignee,
        title: input.title,
        body: input.body ?? null,
        priority: input.priority ?? null,
        dish: input.dish ?? null,
      });
      if (assignee) deliverWake([assignee], { from: agentId, subject: "task" });
      return asToolResult({ ok: true, id, assignedTo: assignee ?? "queue" });
    },
  );

  server.registerTool(
    "hands_tasks",
    {
      title: "List delegated tasks",
      description:
        "List tickets (tasks). A station checks its own with assignee=<me>; the expo omits filters or uses " +
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
          dish: t.dish ?? undefined,
          updatedAt: new Date(t.updated_at).toISOString(),
        })),
      });
    },
  );

  server.registerTool(
    "hands_task_update",
    {
      title: "Advance a ticket (fire / plate / serve / 86)",
      description:
        "Move a ticket through its lifecycle. Station: 'in_progress' when you fire it (claims an unassigned one), " +
        "'returned' with result when you plate it back to the pass. Expo: 'done' to serve/accept, 'cancelled' to 86 it.",
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
      const outcome = store.updateTaskState({
        id: input.id,
        state: input.state,
        assignee: claim,
        result: input.result ?? null,
      });
      if (!outcome.ok) {
        return {
          ...asToolResult({
            ok: false,
            error:
              outcome.reason === "terminal"
                ? `task #${input.id} is already ${task.state} — terminal states can't reopen, file a new ticket instead`
                : "no such task",
          }),
          isError: true,
        };
      }
      if (input.state === "returned") {
        deliverWake([task.created_by], { from: agentId, subject: "task returned" });
      }
      return asToolResult({ ok: true, id: input.id, state: input.state });
    },
  );

  // --- todos (expo-managed personal to-do list for the principal) ---

  server.registerTool(
    "hands_todos",
    {
      title: "Read the principal's to-do list",
      description:
        `List the personal to-do items the expo is tracking for ${principal}. No args: everything ` +
        "(open first). Pass state to filter: open | done | dismissed. Read-only — the expo " +
        "manages the list via hands_todo_add / hands_todo_update.",
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
    "hands_todo_add",
    {
      title: "Add an item to the principal's to-do list",
      description:
        `Add a concrete thing only ${principal} can personally do (a decision, a merge/review click, a ` +
        "reply he owes) to his to-do list. Expo-managed. Idempotent while open: pass a stable " +
        "`dedupKey` (e.g. the PR#, question id, or a normalized title) so re-deriving the same item " +
        "each pass never duplicates it — an existing open match is returned untouched. Set " +
        "`origin` (what surfaced it) and `priority` (which ranked priority it maps to) for provenance.",
      inputSchema: {
        title: z.string(),
        detail: z.string().optional(),
        dedupKey: z.string().optional().describe("stable identity to prevent re-adds while open"),
        origin: z.string().optional().describe("what spawned it — PR#, question id, priority text"),
        priority: z.string().optional(),
        source: z.enum(["expo", "human"]).optional(),
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
        source: input.source ?? "expo",
      });
      return asToolResult({ ok: true, id, isNew });
    },
  );

  server.registerTool(
    "hands_todo_update",
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

  server.registerTool(
    "hands_focus",
    {
      title: "Assign a station's craft (set/swap its focus label)",
      description:
        'Assign a station its CRAFT — the named, portable specialization it holds ("saucier", ' +
        '"ordering API"). The craft, not the seat, owns the prep book + craft skill under crafts/, ' +
        "so reassigning moves the whole skillset and history to that station: an existing name " +
        "restores its files, a new name founds fresh ones. Shown on the board and in the books, " +
        "and addressable in hands_send/delegate as a convenience (the station-<n> id stays the " +
        "durable key). Swapping a RUNNING station's craft: set it here, then send a waking message " +
        "so it re-reads via hands_paths. Keep one craft on one active seat at a time — two seats " +
        "writing one book is the same mistake as two machines on one handle. A station may set " +
        "its own; the expo may set anyone's. Pass focus: null to clear.",
      inputSchema: {
        station: z.string().optional().describe("target station id (default: yourself)"),
        focus: z.string().min(1).max(80).nullable(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      store.touch(agentId);
      const target = input.station ? resolveAgentRef(input.station) : agentId;
      if (target !== agentId && !isExpo(agentId)) {
        return {
          ...asToolResult({ ok: false, error: "only the expo may set another agent's focus" }),
          isError: true,
        };
      }
      if (!isStation(target) && !isExpo(target)) {
        return {
          ...asToolResult({ ok: false, error: `not a station id: ${target}` }),
          isError: true,
        };
      }
      store.setFocus(target, input.focus);
      return asToolResult({ ok: true, station: target, focus: input.focus });
    },
  );

  // --- expo-only: team-awareness GitHub poll + digest notes ---
  if (isExpo(agentId)) {
    server.registerTool(
      "hands_digest_note",
      {
        title: "Add a prose note to today's journal digest (expo only)",
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
      "hands_gh_poll",
      {
        title: "Poll GitHub for other engineers' PRs (expo only)",
        description:
          "Record what OTHER engineers are shipping (open + recently-merged PRs on this repo, " +
          "excluding the principal's) for the dashboard team lane and per-station relevance matching. " +
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

  // --- expo-directed scaling (opens/closes local station sessions) ---
  // Registered ONLY for the expo, and only when the config opts in — these
  // launch local processes, so they're off unless explicitly enabled.
  if (isExpo(agentId) && cfg.stations.allowScaling) {
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
      "hands_station_add",
      {
        title: "Open more stations (expo only)",
        description:
          "Provision and launch `count` new station sessions for this repo. Use when the menu " +
          "(ranked priorities) is under-staffed. Each station appears on the board as station-<n> once its " +
          "session takes its first turn. If the launcher is manual, relay the pasteCommand to " +
          `${principal} to start the pane.`,
        inputSchema: { count: z.number().int().min(1).max(12).optional() },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (input) => {
        store.touch(agentId);
        const { addStations } = await import("./provision.js");
        try {
          return asToolResult({ ok: true, added: presentPlans(addStations(input.count ?? 1)) });
        } catch (err) {
          return { ...asToolResult({ ok: false, error: String(err) }), isError: true };
        }
      },
    );

    server.registerTool(
      "hands_station_remove",
      {
        title: "Close a station (expo only)",
        description:
          "Stop a station's session and remove its managed workspace. Refuses if the station has " +
          "uncommitted work unless force:true. Idempotent.",
        inputSchema: {
          id: z.string().describe("station-<n>"),
          force: z.boolean().optional().describe("true = discard uncommitted work"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async (input) => {
        store.touch(agentId);
        const { removeStation } = await import("./provision.js");
        try {
          return asToolResult({ ok: true, ...removeStation(input.id, { force: input.force }) });
        } catch (err) {
          return { ...asToolResult({ ok: false, error: String(err) }), isError: true };
        }
      },
    );

    server.registerTool(
      "hands_scale",
      {
        title: "Scale the station line (expo only)",
        description:
          "Reconcile the line to exactly `target` stations — adds or opens/closes as needed (highest " +
          "index retired first; refuses to discard uncommitted work unless force:true).",
        inputSchema: {
          target: z.number().int().min(0).max(12),
          force: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async (input) => {
        store.touch(agentId);
        const { scaleStations } = await import("./provision.js");
        try {
          const res = scaleStations(input.target, { force: input.force });
          return asToolResult({ ok: true, added: presentPlans(res.added), removed: res.removed });
        } catch (err) {
          return { ...asToolResult({ ok: false, error: String(err) }), isError: true };
        }
      },
    );
  }

  return server;
}

/** Resolve this process's agent id (config expo.basename included). */
function resolveSelf(): string {
  return resolveAgentId({ expoBasename: loadConfig().expo.basename });
}

/**
 * Where does this process resolve? Shared by the `paths` CLI subcommand, the
 * `hands paths` CLI, and the hands_paths MCP tool — the one authority
 * agents consult instead of guessing per-repo paths.
 */
export function pathsReport(agentId: string, cfg: HandsConfig, focus?: string | null) {
  const info = repoInfo();
  const enabled = Boolean(cfg.remote.url?.trim());
  const journal = enabled ? readSyncStatus(journalDir()) : null;
  // Resolved from CURRENT focus on every call — this is what makes mid-session
  // craft swaps observable without a reconnect.
  const craft = focus ?? null;
  const files = craft ? craftFiles(craft) : null;
  return {
    cwd: process.cwd(),
    agentId,
    repoRoot: info?.repoRoot ?? null,
    isMainWorktree: info?.isMainWorktree ?? null,
    slug: info?.slug ?? "_global",
    coordinationDir: coordinationDir(),
    db: dbPath(),
    notify: notifyPath(agentId),
    /** the craft roster — every craft's book + skill live here */
    craftsDir: craftFiles("roster").dir,
    ...(isStation(agentId)
      ? {
          craft,
          craftSlug: files?.slug ?? null,
          book: files?.book ?? null,
          skillFile: files?.skill ?? null,
        }
      : {}),
    journalProject: enabled ? resolveProject(cfg) : null,
    /** the books clone — digest pages under journal/<project>/<handle>/<date>.md (read-in source) */
    booksDir: enabled ? journalDir() : null,
    journalSync: journal
      ? { ...journal, at: new Date(journal.at).toISOString() }
      : enabled
        ? "never-synced"
        : "disabled",
  };
}

function runCli(subcommand: string, argv: string[]): number {
  if (subcommand === "paths") {
    // Debug: where does this cwd resolve? Reads the existing DB for the
    // current craft, but never CREATES one as a side effect of a debug call.
    const id = resolveSelf();
    let focus: string | null = null;
    if (fs.existsSync(dbPath())) {
      const s = new Store();
      try {
        focus = s.getFocus(id);
      } finally {
        s.close();
      }
    }
    process.stdout.write(`${JSON.stringify(pathsReport(id, loadConfig(), focus), null, 2)}\n`);
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
      if (journal) syncPush(journal, { store });
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
    process.stderr.write(`[hands] unknown subcommand: ${subcommand}\n`);
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
    process.stdout.write(`hands dashboard → ${handle.url}\n(Ctrl-C to stop)\n`);
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
// not this module), which signals through HANDS_FORCE_MAIN instead.
const invokedDirectly = (() => {
  if (process.env.HANDS_FORCE_MAIN === "1") return true;
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
    console.error("[hands] fatal:", err);
    process.exit(1);
  });
}
