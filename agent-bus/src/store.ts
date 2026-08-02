import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { coordinationDir, dbPath } from "./paths.js";

/** SQLite result codes we treat as transient under multi-process contention. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/**
 * How long a peer stays "online" after its last heartbeat. Presence only beats
 * at turn-end (the Stop hook), and the gap between turns routinely exceeds a
 * minute, so this must be generous — it means "had a turn recently", not
 * "this instant". Pairs with board's IDLE_THRESHOLD_MS (active vs idle) to give
 * a three-band signal: active <3m · idle 3–15m · offline >15m.
 */
export const ONLINE_WINDOW_MS = 15 * 60_000;

export interface AgentRow {
  id: string;
  cwd: string;
  pid: number;
  registered_at: number;
  last_seen_at: number;
  /** current git branch in this agent's worktree (null until first publish) */
  branch: string | null;
  /** JSON blob: { files: string[]; ticket?: string | null } — for the board + collision detection */
  activity: string | null;
  /** idle | busy — derived from last_active recency by the publisher */
  state: string | null;
  /** last turn-end heartbeat (Stop hook); drives the worker idle-gate */
  last_active: number | null;
}

export interface JournalRow {
  id: number;
  agent_id: string;
  /** commit | memory | note */
  kind: string;
  /** commit sha, memory filename, etc. */
  ref: string | null;
  text: string;
  created_at: number;
}

export interface QuestionRow {
  id: number;
  asker: string;
  question: string;
  context: string | null;
  /** open (awaiting foreman) | needs_human (escalated) | answered */
  state: string;
  answer: string | null;
  /** foreman | human — who decided */
  resolved_by: string | null;
  /** which priority the foreman mapped this to */
  priority_ref: string | null;
  /** the foreman's recommended answer when escalated */
  recommendation: string | null;
  /** foreman hindsight self-audit: validated | contradicted | null (unassessed) */
  outcome: string | null;
  /** short reason for the outcome verdict */
  outcome_note: string | null;
  /** when the outcome was recorded */
  outcome_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TaskRow {
  id: number;
  created_by: string;
  /** null = unassigned queue */
  assignee: string | null;
  title: string;
  body: string | null;
  /** open | assigned | in_progress | returned | done | cancelled */
  state: string;
  result: string | null;
  priority_ref: string | null;
  thread_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface TodoRow {
  id: number;
  title: string;
  detail: string | null;
  /** open | done | dismissed */
  state: string;
  /** foreman (inferred) | human (principal added) */
  source: string;
  /** what spawned it — PR#, question id, priority text, etc. (provenance) */
  origin_ref: string | null;
  /** normalized identity; prevents re-adding the same item while it's still open */
  dedup_key: string | null;
  /** how completion was inferred — the reversible audit line ("PR #2354 merged") */
  done_signal: string | null;
  priority_ref: string | null;
  created_at: number;
  updated_at: number;
}

export interface GithubPrRow {
  number: number;
  title: string;
  author: string;
  branch: string | null;
  url: string;
  /** open | merged */
  state: string;
  ticket: string | null;
  files_json: string | null;
  updated_at: number;
  seen_at: number;
}

export interface StatusInput {
  id: string;
  cwd: string;
  pid: number;
  branch?: string | null;
  /** repo-relative paths this worktree is currently touching */
  files?: string[];
  ticket?: string | null;
  state?: "idle" | "busy";
  now?: number;
}

export interface MessageRow {
  id: number;
  from_id: string;
  /** null = broadcast */
  to_id: string | null;
  subject: string | null;
  body: string;
  thread_id: string | null;
  created_at: number;
}

export interface Peer extends AgentRow {
  online: boolean;
}

export interface SendInput {
  from: string;
  /** an agent id, or null for broadcast */
  to: string | null;
  body: string;
  subject?: string | null;
  thread?: string | null;
  now?: number;
}

/** True sync sleep — used to back off between retries in this synchronous layer. */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function isBusy(err: unknown): boolean {
  const code = (err as { errcode?: number } | null)?.errcode;
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED) return true;
  const message = err instanceof Error ? err.message : "";
  return /database is locked|database table is locked|busy/i.test(message);
}

/**
 * Shared-SQLite store for agent-bus. One instance per stdio server process; the
 * DB file at `~/.claude/coordination/agent-bus.db` (WAL mode) is the single
 * source of truth shared across every worktree's process.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(options?: { env?: NodeJS.ProcessEnv; path?: string }) {
    const env = options?.env ?? process.env;
    const dir = coordinationDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A pre-existing dir keeps its old mode through mkdir; enforce 0700.
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // best-effort — not fatal
    }

    const file = options?.path ?? dbPath(env);
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();

    // Local, same-user secret hygiene: the DB (and its WAL/SHM sidecars) hold
    // plaintext message bodies.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.chmodSync(`${file}${suffix}`, 0o600);
      } catch {
        // sidecar may not exist yet — best-effort
      }
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id            TEXT PRIMARY KEY,
        cwd           TEXT NOT NULL,
        pid           INTEGER NOT NULL,
        registered_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id    TEXT NOT NULL,
        to_id      TEXT,               -- NULL = broadcast
        subject    TEXT,
        body       TEXT NOT NULL,
        thread_id  TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_to_id ON messages (to_id, id);

      CREATE TABLE IF NOT EXISTS cursors (
        agent_id            TEXT PRIMARY KEY,
        last_read_message_id INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS journal (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT NOT NULL,
        kind       TEXT NOT NULL,      -- commit | memory | note
        ref        TEXT,               -- sha, memory filename, …
        text       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_journal_created ON journal (created_at);

      CREATE TABLE IF NOT EXISTS watermarks (
        agent_id TEXT NOT NULL,        -- '*' = global (cross-worktree dedup)
        key      TEXT NOT NULL,
        value    TEXT NOT NULL,
        PRIMARY KEY (agent_id, key)
      );

      CREATE TABLE IF NOT EXISTS questions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        asker          TEXT NOT NULL,
        question       TEXT NOT NULL,
        context        TEXT,
        state          TEXT NOT NULL DEFAULT 'open',  -- open | needs_human | answered
        answer         TEXT,
        resolved_by    TEXT,                          -- foreman | human
        priority_ref   TEXT,
        recommendation TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_questions_state ON questions (state, id);

      CREATE TABLE IF NOT EXISTS github_prs (
        number     INTEGER PRIMARY KEY,
        title      TEXT NOT NULL,
        author     TEXT NOT NULL,
        branch     TEXT,
        url        TEXT NOT NULL,
        state      TEXT NOT NULL,        -- open | merged
        ticket     TEXT,
        files_json TEXT,
        updated_at INTEGER NOT NULL,     -- PR updatedAt (epoch ms)
        seen_at    INTEGER NOT NULL      -- first time we recorded it
      );

      CREATE INDEX IF NOT EXISTS idx_github_state ON github_prs (state, updated_at);

      CREATE TABLE IF NOT EXISTS tasks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        created_by   TEXT NOT NULL,
        assignee     TEXT,                              -- NULL = unassigned queue
        title        TEXT NOT NULL,
        body         TEXT,
        state        TEXT NOT NULL DEFAULT 'assigned',  -- open|assigned|in_progress|returned|done|cancelled
        result       TEXT,
        priority_ref TEXT,
        thread_id    TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee, state);
      CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks (state, updated_at);

      CREATE TABLE IF NOT EXISTS todos (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT NOT NULL,
        detail       TEXT,
        state        TEXT NOT NULL DEFAULT 'open',      -- open | done | dismissed
        source       TEXT NOT NULL DEFAULT 'foreman',   -- foreman | human
        origin_ref   TEXT,                              -- PR#, question id, priority text, …
        dedup_key    TEXT,                              -- normalized identity (open-scoped)
        done_signal  TEXT,                              -- how completion was inferred (audit)
        priority_ref TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_todos_state ON todos (state, updated_at);
      -- At most one OPEN todo per dedup_key, so a self-managing foreman that
      -- re-derives the same item every pass never spawns duplicates. Done/
      -- dismissed rows are exempt, so a recurring item can legitimately re-open.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_open_dedup
        ON todos (dedup_key) WHERE state = 'open' AND dedup_key IS NOT NULL;
    `);

    // Additive columns on agents (safe to run against a pre-Phase-1 DB).
    this.ensureColumn("agents", "branch", "TEXT");
    this.ensureColumn("agents", "activity", "TEXT");
    this.ensureColumn("agents", "state", "TEXT");
    this.ensureColumn("agents", "last_active", "INTEGER");

    // Foreman self-audit: hindsight verdict on each recommendation.
    this.ensureColumn("questions", "outcome", "TEXT");
    this.ensureColumn("questions", "outcome_note", "TEXT");
    this.ensureColumn("questions", "outcome_at", "INTEGER");
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  /** Retry a write closure on transient SQLITE_BUSY/LOCKED contention. */
  private withRetry<T>(fn: () => T): T {
    const maxAttempts = 6;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return fn();
      } catch (err) {
        if (!isBusy(err)) throw err;
        lastErr = err;
        sleepSync(10 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  registerAgent(agent: { id: string; cwd: string; pid: number; now?: number }): void {
    const now = agent.now ?? Date.now();
    this.withRetry(() =>
      this.db
        .prepare(
          `INSERT INTO agents (id, cwd, pid, registered_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             cwd = excluded.cwd,
             pid = excluded.pid,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(agent.id, agent.cwd, agent.pid, now, now),
    );
  }

  touch(agentId: string, now: number = Date.now()): void {
    this.withRetry(() =>
      this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(now, agentId),
    );
  }

  /** Enqueue a message; returns its autoincrement id. */
  insertMessage(input: SendInput): number {
    const now = input.now ?? Date.now();
    return this.withRetry(() => {
      const result = this.db
        .prepare(
          `INSERT INTO messages (from_id, to_id, subject, body, thread_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.from,
          input.to,
          input.subject ?? null,
          input.body,
          input.thread ?? null,
          now,
        );
      return Number(result.lastInsertRowid);
    });
  }

  /**
   * Messages addressed to `agentId` (directed OR broadcast) with id > cursor,
   * excluding the agent's own sends. Uniform handling of directed + broadcast.
   */
  messagesSince(agentId: string, cursor: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE (to_id = ? OR to_id IS NULL)
           AND from_id != ?
           AND id > ?
         ORDER BY id ASC`,
      )
      .all(agentId, agentId, cursor) as unknown as MessageRow[];
  }

  /**
   * Messages addressed to `agentId` created after `sinceTs` — for the board's
   * awareness view. Independent of the receive cursor (which is how a worker
   * *handles* messages), so showing a message never marks it handled.
   */
  messagesForSince(agentId: string, sinceTs: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE (to_id = ? OR to_id IS NULL) AND from_id != ? AND created_at > ?
         ORDER BY id ASC`,
      )
      .all(agentId, agentId, sinceTs) as unknown as MessageRow[];
  }

  getCursor(agentId: string): number {
    const row = this.db
      .prepare("SELECT last_read_message_id AS c FROM cursors WHERE agent_id = ?")
      .get(agentId) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  setCursor(agentId: string, lastReadMessageId: number): void {
    this.withRetry(() =>
      this.db
        .prepare(
          `INSERT INTO cursors (agent_id, last_read_message_id)
           VALUES (?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
        )
        .run(agentId, lastReadMessageId),
    );
  }

  listPeers(now: number = Date.now()): Peer[] {
    const rows = this.db
      .prepare("SELECT * FROM agents ORDER BY id ASC")
      .all() as unknown as AgentRow[];
    return rows.map((row) => ({
      ...row,
      online: now - row.last_seen_at < ONLINE_WINDOW_MS,
    }));
  }

  history(options?: { peer?: string; thread?: string; limit?: number }): MessageRow[] {
    const limit = Math.max(1, Math.min(options?.limit ?? 50, 500));
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options?.peer) {
      clauses.push("(from_id = ? OR to_id = ?)");
      params.push(options.peer, options.peer);
    }
    if (options?.thread) {
      clauses.push("thread_id = ?");
      params.push(options.thread);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM messages ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as unknown as MessageRow[];
    return rows.reverse();
  }

  /**
   * Upsert this agent's live status (branch/activity/state) and bump both the
   * presence heartbeat (`last_seen_at`) and the turn heartbeat (`last_active`).
   * Called by the Stop-hook publisher every turn.
   */
  setStatus(input: StatusInput): void {
    const now = input.now ?? Date.now();
    const activity =
      input.files !== undefined || input.ticket !== undefined
        ? JSON.stringify({ files: input.files ?? [], ticket: input.ticket ?? null })
        : null;
    this.withRetry(() =>
      this.db
        .prepare(
          `INSERT INTO agents (id, cwd, pid, registered_at, last_seen_at, branch, activity, state, last_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             cwd          = excluded.cwd,
             last_seen_at = excluded.last_seen_at,
             last_active  = excluded.last_active,
             branch       = COALESCE(excluded.branch, agents.branch),
             activity     = COALESCE(excluded.activity, agents.activity),
             state        = COALESCE(excluded.state, agents.state)`,
        )
        .run(
          input.id,
          input.cwd,
          input.pid,
          now,
          now,
          input.branch ?? null,
          activity,
          input.state ?? null,
          now,
        ),
    );
  }

  journalAdd(input: {
    agentId: string;
    kind: "commit" | "memory" | "note";
    ref?: string | null;
    text: string;
    now?: number;
  }): number {
    const now = input.now ?? Date.now();
    return this.withRetry(() => {
      const result = this.db
        .prepare(
          `INSERT INTO journal (agent_id, kind, ref, text, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.agentId, input.kind, input.ref ?? null, input.text, now);
      return Number(result.lastInsertRowid);
    });
  }

  /** True if a journal row with this (kind, ref) already exists — commit dedup. */
  journalHasRef(kind: string, ref: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM journal WHERE kind = ? AND ref = ? LIMIT 1")
      .get(kind, ref) as { x: number } | undefined;
    return row !== undefined;
  }

  journalSince(since: number, limit = 50): JournalRow[] {
    return this.db
      .prepare("SELECT * FROM journal WHERE created_at > ? ORDER BY created_at ASC, id ASC LIMIT ?")
      .all(since, Math.max(1, Math.min(limit, 200))) as unknown as JournalRow[];
  }

  getWatermark(agentId: string, key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM watermarks WHERE agent_id = ? AND key = ?")
      .get(agentId, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setWatermark(agentId: string, key: string, value: string): void {
    this.withRetry(() =>
      this.db
        .prepare(
          `INSERT INTO watermarks (agent_id, key, value) VALUES (?, ?, ?)
           ON CONFLICT(agent_id, key) DO UPDATE SET value = excluded.value`,
        )
        .run(agentId, key, value),
    );
  }

  // --- questions (worktree → foreman escalation) ---

  askQuestion(input: { asker: string; question: string; context?: string | null; now?: number }): number {
    const now = input.now ?? Date.now();
    return this.withRetry(() => {
      const result = this.db
        .prepare(
          `INSERT INTO questions (asker, question, context, state, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, ?)`,
        )
        .run(input.asker, input.question, input.context ?? null, now, now);
      return Number(result.lastInsertRowid);
    });
  }

  listQuestions(options?: { state?: string; asker?: string; limit?: number }): QuestionRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options?.state) {
      clauses.push("state = ?");
      params.push(options.state);
    }
    if (options?.asker) {
      clauses.push("asker = ?");
      params.push(options.asker);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(options?.limit ?? 100, 500)));
    return this.db
      .prepare(`SELECT * FROM questions ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as unknown as QuestionRow[];
  }

  getQuestion(id: number): QuestionRow | undefined {
    return this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as
      | QuestionRow
      | undefined;
  }

  answerQuestion(input: {
    id: number;
    answer: string;
    resolvedBy: "foreman" | "human";
    priorityRef?: string | null;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.withRetry(() =>
      this.db
        .prepare(
          `UPDATE questions
           SET state = 'answered', answer = ?, resolved_by = ?,
               priority_ref = COALESCE(?, priority_ref), updated_at = ?
           WHERE id = ?`,
        )
        .run(input.answer, input.resolvedBy, input.priorityRef ?? null, now, input.id),
    );
  }

  /**
   * Record the foreman's hindsight verdict on a recommendation it made (self-audit):
   * `validated` (held up) or `contradicted` (a later finding overturned it). Feeds the
   * foreman-effectiveness score. Grades the foreman's judgment, not the principal's acceptance.
   */
  setQuestionOutcome(input: {
    id: number;
    outcome: "validated" | "contradicted";
    note?: string | null;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.withRetry(() =>
      this.db
        .prepare(
          `UPDATE questions
           SET outcome = ?, outcome_note = ?, outcome_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.outcome, input.note ?? null, now, now, input.id),
    );
  }

  escalateQuestion(input: {
    id: number;
    recommendation?: string | null;
    priorityRef?: string | null;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.withRetry(() =>
      this.db
        .prepare(
          `UPDATE questions
           SET state = 'needs_human', recommendation = ?,
               priority_ref = COALESCE(?, priority_ref), updated_at = ?
           WHERE id = ?`,
        )
        .run(input.recommendation ?? null, input.priorityRef ?? null, now, input.id),
    );
  }

  /** Answered questions for an asker updated since `since` — for its board delta. */
  answeredForAsker(asker: string, since: number): QuestionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM questions
         WHERE asker = ? AND state = 'answered' AND updated_at > ?
         ORDER BY updated_at ASC`,
      )
      .all(asker, since) as unknown as QuestionRow[];
  }

  // --- github PRs (foreman's team-awareness poll) ---

  upsertGithubPr(pr: {
    number: number;
    title: string;
    author: string;
    branch?: string | null;
    url: string;
    state: string;
    ticket?: string | null;
    files?: string[];
    updatedAt: number;
    now?: number;
  }): { isNew: boolean; changed: boolean } {
    const now = pr.now ?? Date.now();
    const filesJson = pr.files ? JSON.stringify(pr.files) : null;
    return this.withRetry(() => {
      const existing = this.db
        .prepare("SELECT updated_at FROM github_prs WHERE number = ?")
        .get(pr.number) as { updated_at: number } | undefined;
      const isNew = existing === undefined;
      const changed = !isNew && existing.updated_at !== pr.updatedAt;
      this.db
        .prepare(
          `INSERT INTO github_prs (number, title, author, branch, url, state, ticket, files_json, updated_at, seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(number) DO UPDATE SET
             title=excluded.title, author=excluded.author, branch=excluded.branch, url=excluded.url,
             state=excluded.state, ticket=excluded.ticket, files_json=excluded.files_json,
             updated_at=excluded.updated_at`,
        )
        .run(
          pr.number,
          pr.title,
          pr.author,
          pr.branch ?? null,
          pr.url,
          pr.state,
          pr.ticket ?? null,
          filesJson,
          pr.updatedAt,
          now, // seen_at — only applied on INSERT (not in the ON CONFLICT SET)
        );
      return { isNew, changed };
    });
  }

  listGithubPrs(options?: { state?: string; limit?: number }): GithubPrRow[] {
    const where = options?.state ? "WHERE state = ?" : "";
    const params: Array<string | number> = [];
    if (options?.state) params.push(options.state);
    params.push(Math.max(1, Math.min(options?.limit ?? 100, 300)));
    return this.db
      .prepare(`SELECT * FROM github_prs ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params) as unknown as GithubPrRow[];
  }

  // --- tasks (foreman → worktree delegation lifecycle) ---

  createTask(input: {
    createdBy: string;
    assignee?: string | null;
    title: string;
    body?: string | null;
    priority?: string | null;
    thread?: string | null;
    now?: number;
  }): number {
    const now = input.now ?? Date.now();
    const state = input.assignee ? "assigned" : "open";
    return this.withRetry(() => {
      const result = this.db
        .prepare(
          `INSERT INTO tasks (created_by, assignee, title, body, state, priority_ref, thread_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.createdBy,
          input.assignee ?? null,
          input.title,
          input.body ?? null,
          state,
          input.priority ?? null,
          input.thread ?? null,
          now,
          now,
        );
      return Number(result.lastInsertRowid);
    });
  }

  listTasks(options?: {
    state?: string;
    assignee?: string;
    createdBy?: string;
    active?: boolean;
    limit?: number;
  }): TaskRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options?.state) {
      clauses.push("state = ?");
      params.push(options.state);
    }
    if (options?.assignee) {
      clauses.push("assignee = ?");
      params.push(options.assignee);
    }
    if (options?.createdBy) {
      clauses.push("created_by = ?");
      params.push(options.createdBy);
    }
    if (options?.active) {
      clauses.push("state IN ('open','assigned','in_progress','returned')");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(options?.limit ?? 100, 300)));
    return this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params) as unknown as TaskRow[];
  }

  getTask(id: number): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  }

  updateTaskState(input: {
    id: number;
    state: "assigned" | "in_progress" | "returned" | "done" | "cancelled";
    assignee?: string | null;
    result?: string | null;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.withRetry(() =>
      this.db
        .prepare(
          `UPDATE tasks
           SET state = ?,
               assignee = COALESCE(?, assignee),
               result = COALESCE(?, result),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(input.state, input.assignee ?? null, input.result ?? null, now, input.id),
    );
  }

  /** Tasks freshly assigned to a worktree (for its board delta). */
  tasksAssignedSince(assignee: string, since: number): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE assignee = ? AND state = 'assigned' AND updated_at > ?
         ORDER BY updated_at ASC`,
      )
      .all(assignee, since) as unknown as TaskRow[];
  }

  /** Tasks a worktree has returned to their creator (for the creator's board delta). */
  tasksReturnedForCreator(createdBy: string, since: number): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE created_by = ? AND state = 'returned' AND updated_at > ?
         ORDER BY updated_at ASC`,
      )
      .all(createdBy, since) as unknown as TaskRow[];
  }

  // --- todos (foreman-managed personal to-do list for the principal) ---

  /**
   * Add an item to the principal's to-do list. Idempotent while open: if `dedupKey`
   * is given and an open todo already carries it, the existing row is returned
   * untouched (isNew:false) — so the self-managing foreman can re-derive the
   * same item every pass without spawning duplicates.
   */
  createTodo(input: {
    title: string;
    detail?: string | null;
    source?: "foreman" | "human";
    originRef?: string | null;
    dedupKey?: string | null;
    priority?: string | null;
    now?: number;
  }): { id: number; isNew: boolean } {
    const now = input.now ?? Date.now();
    return this.withRetry(() => {
      if (input.dedupKey) {
        const existing = this.db
          .prepare("SELECT id FROM todos WHERE dedup_key = ? AND state = 'open' LIMIT 1")
          .get(input.dedupKey) as { id: number } | undefined;
        if (existing) return { id: existing.id, isNew: false };
      }
      const result = this.db
        .prepare(
          `INSERT INTO todos (title, detail, state, source, origin_ref, dedup_key, priority_ref, created_at, updated_at)
           VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.title,
          input.detail ?? null,
          input.source ?? "foreman",
          input.originRef ?? null,
          input.dedupKey ?? null,
          input.priority ?? null,
          now,
          now,
        );
      return { id: Number(result.lastInsertRowid), isNew: true };
    });
  }

  listTodos(options?: { state?: string; limit?: number }): TodoRow[] {
    const where = options?.state ? "WHERE state = ?" : "";
    const params: Array<string | number> = [];
    if (options?.state) params.push(options.state);
    params.push(Math.max(1, Math.min(options?.limit ?? 100, 300)));
    return this.db
      .prepare(`SELECT * FROM todos ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params) as unknown as TodoRow[];
  }

  getTodo(id: number): TodoRow | undefined {
    return this.db.prepare("SELECT * FROM todos WHERE id = ?").get(id) as TodoRow | undefined;
  }

  /**
   * Cross an item off (state 'done'), drop it ('dismissed'), or re-open it.
   * `doneSignal` records HOW completion was inferred — the auto-cross-off stays
   * transparent and reversible (the principal can re-open with the signal in view).
   */
  updateTodoState(input: {
    id: number;
    state: "open" | "done" | "dismissed";
    doneSignal?: string | null;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.withRetry(() =>
      this.db
        .prepare(
          `UPDATE todos
           SET state = ?, done_signal = COALESCE(?, done_signal), updated_at = ?
           WHERE id = ?`,
        )
        .run(input.state, input.doneSignal ?? null, now, input.id),
    );
  }

  close(): void {
    this.db.close();
  }
}
