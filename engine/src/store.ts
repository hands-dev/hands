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

/**
 * Whether `pid` names a currently-running OS process (hands#183). A dead pid
 * is proof a station's session ended (crash, eviction, closed pane)
 * independent of heartbeat timing — `ONLINE_WINDOW_MS` alone can't tell "no
 * turn in a while" from "no longer exists" for up to 15 minutes, and the
 * expo dispatches into that blind spot. `pid === 0` is the stub value
 * `setFocus`/`setSessionName` write for an agent that has never actually
 * registered — nothing to check yet, so it reads alive (unknown, not
 * disprovable) rather than penalized. `EPERM` (pid exists, owned by someone
 * else) also reads alive — only a confirmed `ESRCH` proves death.
 */
function isPidAlive(pid: number): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

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
  /** last turn-end heartbeat (Stop hook); drives the station idle-gate */
  last_active: number | null;
  /** the station's evolving specialization label ("developer API") — not part of its id */
  focus: string | null;
  /**
   * hands-owned display name (hands#104) — assigned at `station add`, never
   * read back from Claude Code's own `/rename` (that only surfaces in the
   * statusline JSON payload, not anywhere hands' hooks can see it). hands may
   * optionally *push* this into the session via `/rename` for terminal-tab
   * benefit, but this column is the source of truth.
   */
  session_name: string | null;
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
  /** open (awaiting expo) | needs_human (escalated) | answered */
  state: string;
  answer: string | null;
  /** expo | human — who decided */
  resolved_by: string | null;
  /** which priority the expo mapped this to */
  priority_ref: string | null;
  /** the expo's recommended answer when escalated */
  recommendation: string | null;
  /** expo hindsight self-audit: validated | contradicted | null (unassessed) */
  outcome: string | null;
  /** short reason for the outcome verdict */
  outcome_note: string | null;
  /** when the outcome was recorded */
  outcome_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface AttestationRow {
  agent_id: string;
  /** 1 = clean and ready, 0 = declined */
  ok: number;
  reason: string | null;
  head_sha: string | null;
  origin_sha: string | null;
  lock_pid: number | null;
  details: string | null;
  at: number;
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
  /** the DISH this ticket helps assemble — an external ref (Linear "ENG-1476", "PR #2455") */
  dish: string | null;
  thread_id: string | null;
  created_at: number;
  updated_at: number;
  /** first in_progress transition (token-cost interval start) */
  started_at: number | null;
  /** first returned/done/cancelled transition (token-cost interval end) */
  finished_at: number | null;
}

export interface TodoRow {
  id: number;
  title: string;
  detail: string | null;
  /** open | done | dismissed */
  state: string;
  /** expo (inferred) | human (principal added) */
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

export interface CraftNoteRow {
  id: number;
  craft_slug: string;
  brief_id: number | null;
  source_agent: string;
  /** mise | book | skill | friction | spillover — the fold-time placement rule */
  kind: string;
  body: string;
  /**
   * Set only when kind = spillover: the craft whose sub-agent actually
   * PRODUCED this note (craft_slug is the note's TARGET — the note is
   * filed under the craft it's about, same as any other note; this column
   * is provenance — "borrowed from a X sub-agent," hands#81 Q3).
   */
  spillover_craft: string | null;
  /** NULL = pending a fold; set once a distill pass has folded it in */
  folded_at: number | null;
  created_at: number;
}

export interface CraftBriefRow {
  id: number;
  craft_slug: string;
  /** plan (read-only) | execute */
  mode: string;
  /** the dispatching agent's worktree — execute-lease scoping */
  cwd: string | null;
  opened_by: string;
  task: string | null;
  /** the tasks.id this dispatch was for, when the dispatcher named one (hands#136-dashboard) */
  ticket_id: number | null;
  /** stamped by `hands craft mise` — separates pickup compliance from note compliance */
  picked_up_at: number | null;
  /** stamped once the craft-note block is harvested (subagent-stop.ts) */
  noted_at: number | null;
  created_at: number;
  expires_at: number;
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
  /** stamped on the recipient's first real `hands_receive` drain — null = not yet acked (or a broadcast, never tracked) */
  acked_at: number | null;
}

export interface Peer extends AgentRow {
  online: boolean;
  /**
   * pid-liveness (hands#183) — false ONLY when the recorded pid is confirmed
   * dead (ESRCH). Independent of `online`: a dead pid means offline right
   * now, not after waiting out the heartbeat window. This is the signal a
   * caller deciding "can I dispatch to this station" wants; `online` alone
   * cannot tell a dead session from one that simply hasn't taken a turn yet.
   */
  alive: boolean;
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
 * Shared-SQLite store for hands. One instance per stdio server process; the
 * DB file at `~/.claude/coordination/hands.db` (WAL mode) is the single
 * source of truth shared across every worktree's process.
 */
export class Store {
  private readonly db: DatabaseSync;
  private journalFn: ((type: string, data: Record<string, unknown>) => void) | null = null;

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
        resolved_by    TEXT,                          -- expo | human
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
        source       TEXT NOT NULL DEFAULT 'expo',   -- expo | human
        origin_ref   TEXT,                              -- PR#, question id, priority text, …
        dedup_key    TEXT,                              -- normalized identity (open-scoped)
        done_signal  TEXT,                              -- how completion was inferred (audit)
        priority_ref TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_todos_state ON todos (state, updated_at);
      -- At most one OPEN todo per dedup_key, so a self-managing expo that
      -- re-derives the same item every pass never spawns duplicates. Done/
      -- dismissed rows are exempt, so a recurring item can legitimately re-open.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_open_dedup
        ON todos (dedup_key) WHERE state = 'open' AND dedup_key IS NOT NULL;
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wake_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_wake_log_agent ON wake_log (agent_id, created_at);
    `);

    // Observability samples (hands#103, #106) — local-only and ephemeral, same
    // spirit as wake_log: never journaled/synced, trimmed opportunistically on
    // insert so they stay cheap. Operational data, not durable bus history.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_samples (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id              TEXT NOT NULL,
        input_tokens          INTEGER NOT NULL,
        cache_read_tokens     INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL,
        created_at            INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_context_samples_agent ON context_samples (agent_id, created_at);

      CREATE TABLE IF NOT EXISTS subagent_samples (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_agent_id TEXT NOT NULL,
        agent_type     TEXT,
        spawn_depth    INTEGER,
        output_tokens  INTEGER NOT NULL,
        created_at     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subagent_samples_owner ON subagent_samples (owner_agent_id, created_at);

      CREATE TABLE IF NOT EXISTS wake_outcomes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT NOT NULL,      -- the intended recipient
        message_id INTEGER,
        outcome    TEXT NOT NULL,      -- fired | suppressed | coalesced | failed
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_wake_outcomes_agent ON wake_outcomes (agent_id, created_at);
    `);

    // Crafts as sub-agent-deployed specializations (hands#81/#96/#49). Sub-agents never write
    // craft files directly — they append notes here; a single leased fold pass distills pending
    // notes into the book/mise/skill (see engine/src/crafts.ts). Notes are journaled (durable,
    // rebuildable via `hands restore` — losing unfolded learnings on a machine move would be
    // exactly the silent loss the rest of the bus is designed to avoid); briefs/folds are
    // operational bookkeeping in the same spirit as wake_log — local-only, never journaled.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS craft_notes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        craft_slug      TEXT NOT NULL,
        brief_id        INTEGER,
        source_agent    TEXT NOT NULL,
        kind            TEXT NOT NULL,     -- mise | book | skill | friction | spillover
        body            TEXT NOT NULL,
        spillover_craft TEXT,
        folded_at       INTEGER,           -- NULL = pending
        created_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_craft_notes_pending ON craft_notes (craft_slug, folded_at);

      CREATE TABLE IF NOT EXISTS craft_briefs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        craft_slug   TEXT NOT NULL,
        mode         TEXT NOT NULL,        -- plan | execute
        cwd          TEXT,
        opened_by    TEXT NOT NULL,
        task         TEXT,
        picked_up_at INTEGER,
        noted_at     INTEGER,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_craft_briefs_lease ON craft_briefs (craft_slug, mode, cwd, expires_at);

      -- One row per craft: who currently holds the single-writer fold/distill pass.
      CREATE TABLE IF NOT EXISTS craft_folds (
        craft_slug TEXT PRIMARY KEY,
        holder     TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      -- Station readiness (hands#157). A station attests about ITSELF: clean
      -- and ready. The expo does not inspect or clean other worktrees; it reads
      -- these. head_sha and origin_sha are what make the record expire by
      -- EVENT rather than by clock -- a stale attestation carrying a freshness
      -- stamp is worse than none, which is the flaw #157 identified in
      -- priorities reporting stale:false about a superseded picture.
      CREATE TABLE IF NOT EXISTS attestations (
        agent_id   TEXT PRIMARY KEY,
        ok         INTEGER NOT NULL,       -- 1 = clean and ready, 0 = declined
        reason     TEXT,                   -- the station's OWN words when declining
        head_sha   TEXT,                   -- worktree HEAD at attestation time
        origin_sha TEXT,                   -- origin/main at attestation time
        lock_pid   INTEGER,                -- worktree lock holder, to spot handover
        details    TEXT,                   -- JSON: the individual checks
        at         INTEGER NOT NULL
      );
    `);

    // Additive columns on agents (safe to run against a pre-Phase-1 DB).
    this.ensureColumn("agents", "branch", "TEXT");
    this.ensureColumn("agents", "activity", "TEXT");
    this.ensureColumn("agents", "state", "TEXT");
    this.ensureColumn("agents", "last_active", "INTEGER");
    this.ensureColumn("tasks", "started_at", "INTEGER");
    this.ensureColumn("tasks", "finished_at", "INTEGER");
    this.ensureColumn("agents", "focus", "TEXT");
    this.ensureColumn("tasks", "dish", "TEXT");

    // Expo self-audit: hindsight verdict on each recommendation.
    this.ensureColumn("questions", "outcome", "TEXT");
    this.ensureColumn("questions", "outcome_note", "TEXT");
    this.ensureColumn("questions", "outcome_at", "INTEGER");

    // hands-owned session display name (hands#104) — see AgentRow.session_name.
    this.ensureColumn("agents", "session_name", "TEXT");

    // Optional ticket correlation for a craft dispatch (dashboard "for what ticket" stat) —
    // forward-looking only; a dispatch made before this column existed has no way to backfill it.
    this.ensureColumn("craft_briefs", "ticket_id", "INTEGER");

    // Message ack/turnaround (dashboard chat-bubble checkmark) — stamped on the recipient's
    // first real hands_receive drain. Directed messages only; see ackMessages().
    this.ensureColumn("messages", "acked_at", "INTEGER");
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  /**
   * Wire the durable remote journal (remote.ts). When set, every
   * state-changing method below mirrors its action as one event AFTER the DB
   * write succeeds — the DB stays authoritative; the journal is the rebuild
   * log. Ephemeral state (presence, wake_log, board watermarks, github cache)
   * is deliberately NOT journaled.
   */
  setJournal(fn: (type: string, data: Record<string, unknown>) => void): void {
    this.journalFn = fn;
  }

  /** Emit a journal event (no-op when no journal is wired; never throws). */
  journal(type: string, data: Record<string, unknown>): void {
    try {
      this.journalFn?.(type, data);
    } catch {
      // the journal is best-effort by contract
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

  /**
   * Set a station's focus — its evolving specialization label. The id stays
   * the routing key (the persona-layer lesson); the label rides along, shows
   * on the board/digests, and is addressable as a convenience lookup. Upserts
   * so a focus can be assigned before the station's first turn.
   */
  setFocus(agentId: string, focus: string | null, now: number = Date.now()): void {
    this.withRetry(() =>
      this.db
        .prepare(
          `INSERT INTO agents (id, cwd, pid, registered_at, last_seen_at, focus)
           VALUES (?, '', 0, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET focus = excluded.focus`,
        )
        .run(agentId, now, now, focus),
    );
    this.journal("focus.set", { station: agentId, focus, at: now });
  }

  /**
   * An agent's current focus label — i.e. the CRAFT it holds. Deliberately
   * not presence-windowed (unlike listPeers): an offline station's craft must
   * still resolve so its files inject correctly at the next connect.
   */
  /**
   * Record a station's self-attestation (hands#157).
   *
   * The station asserts about ITSELF; the expo reads. `ok:false` is a
   * first-class outcome, not a failure to record — a station that says "14
   * uncommitted files I don't recognise" is giving better information than any
   * outside inspection could, and it is information only that station has.
   */
  setAttestation(input: {
    agentId: string;
    ok: boolean;
    reason?: string | null;
    headSha?: string | null;
    originSha?: string | null;
    lockPid?: number | null;
    details?: unknown;
    now?: number;
  }): void {
    this.withRetry(() =>
      this.db
        .prepare(
          `INSERT INTO attestations (agent_id, ok, reason, head_sha, origin_sha, lock_pid, details, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             ok = excluded.ok, reason = excluded.reason, head_sha = excluded.head_sha,
             origin_sha = excluded.origin_sha, lock_pid = excluded.lock_pid,
             details = excluded.details, at = excluded.at`,
        )
        .run(
          input.agentId,
          input.ok ? 1 : 0,
          input.reason ?? null,
          input.headSha ?? null,
          input.originSha ?? null,
          input.lockPid ?? null,
          input.details === undefined ? null : JSON.stringify(input.details),
          input.now ?? Date.now(),
        ),
    );
    this.journal("attest", {
      agent: input.agentId,
      ok: input.ok,
      reason: input.reason ?? null,
      at: input.now ?? Date.now(),
    });
  }

  getAttestation(agentId: string): AttestationRow | null {
    const row = this.db
      .prepare(`SELECT * FROM attestations WHERE agent_id = ?`)
      .get(agentId) as unknown as AttestationRow | undefined;
    return row ?? null;
  }

  allAttestations(): AttestationRow[] {
    return this.db.prepare(`SELECT * FROM attestations`).all() as unknown as AttestationRow[];
  }

  /** Drop a station's attestation — used when an event invalidates it. */
  clearAttestation(agentId: string): void {
    this.withRetry(() => this.db.prepare(`DELETE FROM attestations WHERE agent_id = ?`).run(agentId));
  }

  getFocus(agentId: string): string | null {
    const row = this.db
      .prepare(`SELECT focus FROM agents WHERE id = ?`)
      .get(agentId) as { focus: string | null } | undefined;
    return row?.focus ?? null;
  }

  /**
   * Set a station's hands-owned display name (hands#104). Source of truth —
   * NEVER derived by reading Claude Code's own `/rename` output back (that
   * data path doesn't reach hands' hooks). Upserts so a name assigned at
   * `station add` sticks even before the station's first turn registers it.
   */
  setSessionName(agentId: string, sessionName: string | null, now: number = Date.now()): void {
    this.withRetry(() =>
      this.db
        .prepare(
          `INSERT INTO agents (id, cwd, pid, registered_at, last_seen_at, session_name)
           VALUES (?, '', 0, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET session_name = excluded.session_name`,
        )
        .run(agentId, now, now, sessionName),
    );
    this.journal("session_name.set", { station: agentId, sessionName, at: now });
  }

  /** An agent's hands-owned display name, or null if none was ever assigned. */
  getSessionName(agentId: string): string | null {
    const row = this.db
      .prepare(`SELECT session_name FROM agents WHERE id = ?`)
      .get(agentId) as { session_name: string | null } | undefined;
    return row?.session_name ?? null;
  }

  /** Agent ids whose focus label matches (case-insensitive) — label addressing. */
  findByFocus(label: string): string[] {
    return (
      this.db
        .prepare("SELECT id FROM agents WHERE focus IS NOT NULL AND lower(focus) = lower(?) ORDER BY id")
        .all(label.trim()) as unknown as Array<{ id: string }>
    ).map((r) => r.id);
  }

  /** Enqueue a message; returns its autoincrement id. */
  insertMessage(input: SendInput): number {
    const now = input.now ?? Date.now();
    const id = this.withRetry(() => {
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
    this.journal("message", {
      id,
      from: input.from,
      to: input.to,
      subject: input.subject ?? null,
      body: input.body,
      thread: input.thread ?? null,
      at: now,
    });
    return id;
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
   * Directed messages from expo to `agentId` still past its receive cursor —
   * "pending/unacked commands" for the dashboard (hands#55). Unlike
   * messagesForSince, this DOES use the cursor: a station that's read a
   * command (even without acting on it) shouldn't keep showing as pending
   * forever, and a station that's simply behind shows every command it
   * hasn't drained yet, however old.
   */
  pendingFromExpo(agentId: string): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE to_id = ? AND from_id = 'expo' AND id > ?
         ORDER BY id ASC`,
      )
      .all(agentId, this.getCursor(agentId)) as unknown as MessageRow[];
  }

  /**
   * Messages addressed to `agentId` created after `sinceTs` — for the board's
   * awareness view. Independent of the receive cursor (which is how a station
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

  /**
   * Redundant-wake suppression state. A recipient with an OUTSTANDING `.notify`
   * wake (delivered but not yet drained) doesn't need another — one drain
   * returns everything. Tracked as an explicit flag (not "any undrained
   * message") so silent `wake:false` FYIs never mask a real wake: only an
   * actual notify sets it, and only a drain clears it.
   *
   * The drain clears the flag BEFORE reading messages, so a send racing the
   * drain can at worst cause one redundant wake — never a lost one.
   */
  hasPendingWake(agentId: string): boolean {
    return this.getWatermark(agentId, "wake_pending") === "1";
  }

  markWakePending(agentIds: readonly string[]): void {
    for (const id of agentIds) this.setWatermark(id, "wake_pending", "1");
  }

  clearWakePending(agentId: string): void {
    this.setWatermark(agentId, "wake_pending", "0");
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
    this.journal("cursor", { agent: agentId, last: lastReadMessageId });
  }

  listPeers(now: number = Date.now()): Peer[] {
    const rows = this.db
      .prepare("SELECT * FROM agents ORDER BY id ASC")
      .all() as unknown as AgentRow[];
    return rows.map((row) => ({
      ...row,
      online: now - row.last_seen_at < ONLINE_WINDOW_MS,
      alive: isPidAlive(row.pid),
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
   * Stamp the recipient's read-receipt time — the dashboard's message ack/turnaround metric
   * (hands: chat bubble checkmark). Called from `hands_receive`'s real-drain path only; a peek
   * (`mark_read: false`) must never ack. `to_id = ?` makes broadcast-exclusion automatic and
   * free: a broadcast row has `to_id IS NULL`, which never equality-matches a real agent id in
   * SQL, so passing a broadcast's id here is a safe no-op rather than something the caller must
   * filter out itself. `COALESCE` makes this first-drain-wins — a replay of the same batch (e.g.
   * after a crash) must never push an already-set ack time later.
   */
  ackMessages(agentId: string, messageIds: readonly number[], now = Date.now()): void {
    if (messageIds.length === 0) return;
    const placeholders = messageIds.map(() => "?").join(",");
    this.withRetry(() =>
      this.db
        .prepare(`UPDATE messages SET acked_at = COALESCE(acked_at, ?) WHERE to_id = ? AND id IN (${placeholders})`)
        .run(now, agentId, ...messageIds),
    );
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
    const id = this.withRetry(() => {
      const result = this.db
        .prepare(
          `INSERT INTO journal (agent_id, kind, ref, text, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.agentId, input.kind, input.ref ?? null, input.text, now);
      return Number(result.lastInsertRowid);
    });
    this.journal("journal.add", {
      id,
      agent: input.agentId,
      kind: input.kind,
      ref: input.ref ?? null,
      text: input.text,
      at: now,
    });
    return id;
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

  // --- wake accounting (observability only — no caps, no throttling) ---

  /**
   * Record that a real wake (`.notify` append) was just delivered to each
   * agent. Suppressed/`wake:false` notifies are NOT recorded — the log counts
   * actual model wakes, the thing that costs a full context turn. Prunes rows
   * older than ~24h opportunistically to keep the table tiny.
   */
  recordWakes(agentIds: readonly string[], now: number = Date.now()): void {
    if (agentIds.length === 0) return;
    this.withRetry(() => {
      const stmt = this.db.prepare("INSERT INTO wake_log (agent_id, created_at) VALUES (?, ?)");
      for (const id of agentIds) stmt.run(id, now);
      this.db.prepare("DELETE FROM wake_log WHERE created_at < ?").run(now - 24 * 60 * 60_000);
    });
  }

  /** Per-agent wake counts over the trailing hour and 24h. */
  wakeCounts(now: number = Date.now()): Map<string, { lastHour: number; last24h: number }> {
    const rows = this.db
      .prepare(
        `SELECT agent_id,
                SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS hour,
                COUNT(*) AS day
         FROM wake_log WHERE created_at > ?
         GROUP BY agent_id`,
      )
      .all(now - 60 * 60_000, now - 24 * 60 * 60_000) as unknown as Array<{
      agent_id: string;
      hour: number;
      day: number;
    }>;
    return new Map(rows.map((r) => [r.agent_id, { lastHour: Number(r.hour), last24h: Number(r.day) }]));
  }

  /**
   * One context-length sample per Stop-hook publish (hands#103) — the raw
   * line the dashboard needs to derive compaction events, ETA-to-compaction
   * slope, and per-craft context delta. Trims past 7 days on insert.
   */
  recordContextSample(input: {
    agentId: string;
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.withRetry(() => {
      this.db
        .prepare(
          `INSERT INTO context_samples (agent_id, input_tokens, cache_read_tokens, cache_creation_tokens, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.agentId, input.inputTokens, input.cacheReadTokens, input.cacheCreationTokens, now);
      this.db.prepare("DELETE FROM context_samples WHERE created_at < ?").run(now - 7 * 24 * 60 * 60_000);
    });
  }

  /** Recent context samples for one agent, newest first. */
  contextSamples(
    agentId: string,
    limit = 50,
  ): Array<{ inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; at: number }> {
    const rows = this.db
      .prepare(
        `SELECT input_tokens, cache_read_tokens, cache_creation_tokens, created_at
         FROM context_samples WHERE agent_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(agentId, limit) as unknown as Array<{
      input_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      created_at: number;
    }>;
    return rows.map((r) => ({
      inputTokens: r.input_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheCreationTokens: r.cache_creation_tokens,
      at: r.created_at,
    }));
  }

  /** contextSamples() for every agent in one call — the dashboard's "context length over time" tab. */
  contextSamplesForAgents(
    agentIds: readonly string[],
    limit = 50,
  ): Record<string, Array<{ inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; at: number }>> {
    const result: Record<
      string,
      Array<{ inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; at: number }>
    > = {};
    for (const id of agentIds) result[id] = this.contextSamples(id, limit);
    return result;
  }

  /**
   * One row per SubagentStop (hands#103) — the completion the dashboard's
   * periodic transcript scan (tokens.ts) can't attribute to a specific
   * finish event. `agentType` is the craft-grouping key; `spawnDepth` comes
   * from the subagent's own `.meta.json` sidecar. Trims past 7 days on insert.
   */
  recordSubagentSample(input: {
    ownerAgentId: string;
    agentType: string | null;
    spawnDepth: number | null;
    outputTokens: number;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.withRetry(() => {
      this.db
        .prepare(
          `INSERT INTO subagent_samples (owner_agent_id, agent_type, spawn_depth, output_tokens, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.ownerAgentId, input.agentType, input.spawnDepth, input.outputTokens, now);
      this.db.prepare("DELETE FROM subagent_samples WHERE created_at < ?").run(now - 7 * 24 * 60 * 60_000);
    });
  }

  /** Recent subagent completion samples for one owning agent, newest first. */
  subagentSamples(
    ownerAgentId: string,
    limit = 50,
  ): Array<{ agentType: string | null; spawnDepth: number | null; outputTokens: number; at: number }> {
    const rows = this.db
      .prepare(
        `SELECT agent_type, spawn_depth, output_tokens, created_at
         FROM subagent_samples WHERE owner_agent_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(ownerAgentId, limit) as unknown as Array<{
      agent_type: string | null;
      spawn_depth: number | null;
      output_tokens: number;
      created_at: number;
    }>;
    return rows.map((r) => ({
      agentType: r.agent_type,
      spawnDepth: r.spawn_depth,
      outputTokens: r.output_tokens,
      at: r.created_at,
    }));
  }

  /**
   * One row per hands_send delivery decision (hands#106) — "fired" (a real
   * `.notify` append that succeeded, same event `recordWakes` counts),
   * "coalesced" (the recipient already had a pending wake, so this one rides
   * along on the next drain instead of double-waking), "suppressed"
   * (`wake:false`, an intentional FYI), or "failed" (hands#173 — a wake was
   * attempted but the `.notify` write itself threw, so the recipient was
   * never actually nudged despite the DB row existing). Trims past 24h on
   * insert, same window as wake_log.
   */
  recordWakeOutcome(input: {
    agentId: string;
    messageId: number | null;
    outcome: "fired" | "suppressed" | "coalesced" | "failed";
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.withRetry(() => {
      this.db
        .prepare("INSERT INTO wake_outcomes (agent_id, message_id, outcome, created_at) VALUES (?, ?, ?, ?)")
        .run(input.agentId, input.messageId, input.outcome, now);
      this.db.prepare("DELETE FROM wake_outcomes WHERE created_at < ?").run(now - 24 * 60 * 60_000);
    });
  }

  /** Per-agent wake-outcome counts since `sinceMs` — the "success rate, lapse count" hands#106 asks for. */
  wakeOutcomeCounts(
    agentId: string,
    sinceMs: number,
  ): { fired: number; suppressed: number; coalesced: number; failed: number } {
    const rows = this.db
      .prepare("SELECT outcome, COUNT(*) AS n FROM wake_outcomes WHERE agent_id = ? AND created_at > ? GROUP BY outcome")
      .all(agentId, sinceMs) as unknown as Array<{ outcome: string; n: number }>;
    const counts = { fired: 0, suppressed: 0, coalesced: 0, failed: 0 };
    for (const r of rows) {
      if (r.outcome === "fired" || r.outcome === "suppressed" || r.outcome === "coalesced" || r.outcome === "failed") {
        counts[r.outcome] = Number(r.n);
      }
    }
    return counts;
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

  // --- questions (worktree → expo escalation) ---

  askQuestion(input: { asker: string; question: string; context?: string | null; now?: number }): number {
    const now = input.now ?? Date.now();
    const id = this.withRetry(() => {
      const result = this.db
        .prepare(
          `INSERT INTO questions (asker, question, context, state, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, ?)`,
        )
        .run(input.asker, input.question, input.context ?? null, now, now);
      return Number(result.lastInsertRowid);
    });
    this.journal("question.ask", {
      id,
      asker: input.asker,
      question: input.question,
      context: input.context ?? null,
      at: now,
    });
    return id;
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
    resolvedBy: "expo" | "human";
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
    this.journal("question.answer", {
      id: input.id,
      answer: input.answer,
      by: input.resolvedBy,
      priority: input.priorityRef ?? null,
      at: now,
    });
  }

  /**
   * Record the expo's hindsight verdict on a recommendation it made (self-audit):
   * `validated` (held up) or `contradicted` (a later finding overturned it). Feeds the
   * expo-effectiveness score. Grades the expo's judgment, not the principal's acceptance.
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
    this.journal("question.outcome", {
      id: input.id,
      outcome: input.outcome,
      note: input.note ?? null,
      at: now,
    });
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
    this.journal("question.escalate", {
      id: input.id,
      recommendation: input.recommendation ?? null,
      priority: input.priorityRef ?? null,
      at: now,
    });
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

  // --- github PRs (expo's team-awareness poll) ---

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

  // --- tasks (expo → worktree delegation lifecycle) ---

  createTask(input: {
    createdBy: string;
    assignee?: string | null;
    title: string;
    body?: string | null;
    priority?: string | null;
    dish?: string | null;
    thread?: string | null;
    now?: number;
  }): number {
    const now = input.now ?? Date.now();
    const state = input.assignee ? "assigned" : "open";
    const id = this.withRetry(() => {
      const result = this.db
        .prepare(
          `INSERT INTO tasks (created_by, assignee, title, body, state, priority_ref, dish, thread_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.createdBy,
          input.assignee ?? null,
          input.title,
          input.body ?? null,
          state,
          input.priority ?? null,
          input.dish ?? null,
          input.thread ?? null,
          now,
          now,
        );
      return Number(result.lastInsertRowid);
    });
    this.journal("task.create", {
      id,
      by: input.createdBy,
      assignee: input.assignee ?? null,
      title: input.title,
      body: input.body ?? null,
      state,
      priority: input.priority ?? null,
      dish: input.dish ?? null,
      thread: input.thread ?? null,
      at: now,
    });
    return id;
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

  /**
   * `done`/`cancelled` are terminal — a ticket in either state cannot flip back to an
   * active one. Without this, a station racing a cancellation (or replaying a stale
   * claim after a restart) can silently resurrect 86'd/served work: the bus loses its
   * only way to stop a station, both sides disagree about whether the ticket is live,
   * and `finished_at`'s COALESCE means the resurrected ticket's cost-attribution
   * window stays anchored to the OLD close time instead of the new work (hands#97).
   */
  private static readonly ACTIVE_STATES = new Set(["assigned", "in_progress", "returned"]);

  /**
   * Park tickets that claim to be in progress while nobody is working them.
   *
   * `in_progress` means someone is cooking this RIGHT NOW. When a station goes
   * offline — stood down at /hands:last-call, or a pane closed — its tickets
   * keep saying otherwise, and that produces the same lie the board tells about
   * idle-versus-deaf: the expo routes around a station it believes is busy, and
   * the rail shows work in flight that nothing is advancing.
   *
   * /hands:last-call ASKS the expo to park these. This makes it true — the same
   * reason strict-hub topology is enforced before any write rather than
   * requested in a skill. Prose asks a model to comply; the server decides.
   *
   * Parks to `assigned`, not `open`: it stays that station's work, waiting where
   * it looks on its next wake. An order waiting is the menu.
   */
  parkStrandedTickets(now: number = Date.now()): Array<{ id: number; assignee: string }> {
    const cutoff = now - ONLINE_WINDOW_MS;
    const rows = this.db
      .prepare(
        `SELECT t.id AS id, t.assignee AS assignee
           FROM tasks t
           LEFT JOIN agents a ON a.id = t.assignee
          WHERE t.state = 'in_progress'
            AND t.assignee IS NOT NULL
            AND (a.id IS NULL OR a.last_seen_at < ?)`,
      )
      .all(cutoff) as unknown as Array<{ id: number; assignee: string }>;
    for (const row of rows) {
      this.withRetry(() =>
        this.db
          .prepare(
            `UPDATE tasks
                SET state = 'assigned',
                    result = COALESCE(result, '') ||
                             CASE WHEN result IS NULL OR result = '' THEN '' ELSE '\n' END ||
                             'parked: its station went offline while this was in progress',
                    updated_at = ?
              WHERE id = ? AND state = 'in_progress'`,
          )
          .run(now, row.id),
      );
      this.journal("task.parked", { id: row.id, assignee: row.assignee, at: now });
    }
    return rows;
  }

  updateTaskState(input: {
    id: number;
    state: "assigned" | "in_progress" | "returned" | "done" | "cancelled";
    assignee?: string | null;
    result?: string | null;
    now?: number;
  }): { ok: true } | { ok: false; reason: "not_found" | "terminal" } {
    const now = input.now ?? Date.now();
    // Transition stamps feed per-ticket token-cost attribution: the working
    // interval is [started_at, finished_at ?? now] of the assignee's pane.
    const started = input.state === "in_progress";
    const finished =
      input.state === "returned" || input.state === "done" || input.state === "cancelled";
    // The terminal-state check rides the same UPDATE's WHERE clause (not a
    // separate SELECT-then-UPDATE) so it's an atomic compare-and-set — two
    // agents racing a claim against a just-cancelled ticket can't both win.
    const blockResurrect = Store.ACTIVE_STATES.has(input.state);
    const result = this.withRetry(() =>
      this.db
        .prepare(
          `UPDATE tasks
           SET state = ?,
               assignee = COALESCE(?, assignee),
               result = COALESCE(?, result),
               started_at = CASE WHEN ? AND started_at IS NULL THEN ? ELSE started_at END,
               finished_at = CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE finished_at END,
               updated_at = ?
           WHERE id = ?
             AND NOT (? AND state IN ('done', 'cancelled'))`,
        )
        .run(
          input.state,
          input.assignee ?? null,
          input.result ?? null,
          started ? 1 : 0,
          now,
          finished ? 1 : 0,
          now,
          now,
          input.id,
          blockResurrect ? 1 : 0,
        ),
    ) as { changes: number };
    if (result.changes === 0) {
      return this.getTask(input.id) ? { ok: false, reason: "terminal" } : { ok: false, reason: "not_found" };
    }
    this.journal("task.update", {
      id: input.id,
      state: input.state,
      assignee: input.assignee ?? null,
      result: input.result ?? null,
      at: now,
    });
    return { ok: true };
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

  // --- todos (expo-managed personal to-do list for the principal) ---

  /**
   * Add an item to the principal's to-do list. Idempotent while open: if `dedupKey`
   * is given and an open todo already carries it, the existing row is returned
   * untouched (isNew:false) — so the self-managing expo can re-derive the
   * same item every pass without spawning duplicates.
   */
  createTodo(input: {
    title: string;
    detail?: string | null;
    source?: "expo" | "human";
    originRef?: string | null;
    dedupKey?: string | null;
    priority?: string | null;
    now?: number;
  }): { id: number; isNew: boolean } {
    const now = input.now ?? Date.now();
    const created = this.withRetry(() => {
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
          input.source ?? "expo",
          input.originRef ?? null,
          input.dedupKey ?? null,
          input.priority ?? null,
          now,
          now,
        );
      return { id: Number(result.lastInsertRowid), isNew: true };
    });
    if (created.isNew) {
      this.journal("todo.create", {
        id: created.id,
        title: input.title,
        detail: input.detail ?? null,
        source: input.source ?? "expo",
        origin: input.originRef ?? null,
        dedupKey: input.dedupKey ?? null,
        priority: input.priority ?? null,
        at: now,
      });
    }
    return created;
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
    this.journal("todo.update", {
      id: input.id,
      state: input.state,
      doneSignal: input.doneSignal ?? null,
      at: now,
    });
  }

  // --- crafts: briefs (dispatch ledger), notes (append-only capture), fold lease ---

  createCraftBrief(input: {
    craftSlug: string;
    mode: "plan" | "execute";
    cwd?: string | null;
    openedBy: string;
    task?: string | null;
    ticketId?: number | null;
    ttlMs?: number;
    now?: number;
  }): number {
    const now = input.now ?? Date.now();
    const expires = now + (input.ttlMs ?? 60 * 60_000); // an hour is generous for one sub-agent turn
    return this.withRetry(() => {
      const result = this.db
        .prepare(
          `INSERT INTO craft_briefs (craft_slug, mode, cwd, opened_by, task, ticket_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.craftSlug,
          input.mode,
          input.cwd ?? null,
          input.openedBy,
          input.task ?? null,
          input.ticketId ?? null,
          now,
          expires,
        );
      return Number(result.lastInsertRowid);
    });
  }

  getCraftBrief(id: number): CraftBriefRow | undefined {
    return this.db.prepare("SELECT * FROM craft_briefs WHERE id = ?").get(id) as CraftBriefRow | undefined;
  }

  markCraftBriefPickedUp(id: number, now = Date.now()): void {
    this.withRetry(() =>
      this.db.prepare("UPDATE craft_briefs SET picked_up_at = COALESCE(picked_up_at, ?) WHERE id = ?").run(now, id),
    );
  }

  markCraftBriefNoted(id: number, now = Date.now()): void {
    this.withRetry(() =>
      this.db.prepare("UPDATE craft_briefs SET noted_at = COALESCE(noted_at, ?) WHERE id = ?").run(now, id),
    );
  }

  /**
   * Is there already an open (un-noted, unexpired) EXECUTE brief for this craft+cwd? The guard
   * behind "parallel dispatch implies read-only" — a second execute-mode brief against the same
   * craft+worktree is refused while one is still open, rather than letting two sub-agents write
   * one worktree concurrently.
   */
  openExecuteBrief(craftSlug: string, cwd: string, now = Date.now()): CraftBriefRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM craft_briefs
         WHERE craft_slug = ? AND cwd = ? AND mode = 'execute' AND noted_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(craftSlug, cwd, now) as CraftBriefRow | undefined;
  }

  /** Append one learning. Concurrency-safe by construction — many writers, no read-modify-write. */
  insertCraftNote(input: {
    craftSlug: string;
    briefId?: number | null;
    sourceAgent: string;
    kind: "mise" | "book" | "skill" | "friction" | "spillover";
    body: string;
    spilloverCraft?: string | null;
    now?: number;
  }): number {
    const now = input.now ?? Date.now();
    const id = this.withRetry(() => {
      const result = this.db
        .prepare(
          `INSERT INTO craft_notes (craft_slug, brief_id, source_agent, kind, body, spillover_craft, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.craftSlug,
          input.briefId ?? null,
          input.sourceAgent,
          input.kind,
          input.body,
          input.spilloverCraft ?? null,
          now,
        );
      return Number(result.lastInsertRowid);
    });
    this.journal("craft.note", {
      id,
      craft: input.craftSlug,
      briefId: input.briefId ?? null,
      by: input.sourceAgent,
      kind: input.kind,
      body: input.body,
      spilloverCraft: input.spilloverCraft ?? null,
      at: now,
    });
    return id;
  }

  pendingCraftNotes(craftSlug: string): CraftNoteRow[] {
    return this.db
      .prepare("SELECT * FROM craft_notes WHERE craft_slug = ? AND folded_at IS NULL ORDER BY id")
      .all(craftSlug) as unknown as CraftNoteRow[];
  }

  getCraftNote(id: number): CraftNoteRow | undefined {
    return this.db.prepare("SELECT * FROM craft_notes WHERE id = ?").get(id) as CraftNoteRow | undefined;
  }

  /**
   * Every note for a craft, newest first, pending AND folded (unlike pendingCraftNotes) — the
   * dashboard's "note history" panel. This is the one universal, durable timeline: it survives
   * folding (which rewrites the book/skill file in place) and exists regardless of whether the
   * craft's files are ever git-tracked.
   */
  craftNoteHistory(craftSlug: string, limit = 50): CraftNoteRow[] {
    return this.db
      .prepare("SELECT * FROM craft_notes WHERE craft_slug = ? ORDER BY id DESC LIMIT ?")
      .all(craftSlug, limit) as unknown as CraftNoteRow[];
  }

  /**
   * Every craft slug carrying at least one pending note — independent of whether a book file
   * exists yet on disk (a craft can accumulate notes before it's ever founded with a file), so
   * doctor's backlog check doesn't miss a craft just because listCrafts()'s file-based roster
   * hasn't picked it up.
   */
  pendingCraftSlugs(): string[] {
    return (
      this.db.prepare("SELECT DISTINCT craft_slug FROM craft_notes WHERE folded_at IS NULL").all() as Array<{
        craft_slug: string;
      }>
    ).map((r) => r.craft_slug);
  }

  markCraftNotesFolded(craftSlug: string, throughNoteId: number, now = Date.now()): void {
    this.withRetry(() =>
      this.db
        .prepare("UPDATE craft_notes SET folded_at = ? WHERE craft_slug = ? AND id <= ? AND folded_at IS NULL")
        .run(now, craftSlug, throughNoteId),
    );
  }

  /**
   * Fold-mark exactly one note by its own id — distinct from markCraftNotesFolded's "through"
   * batch cutoff, which would risk sweeping up older pending book/skill notes for the same craft.
   * Used by the mechanical mise writer: a mise note is fully applied (upserted into mise.md) the
   * instant it's harvested, independent of whatever else is still pending for that craft.
   */
  markCraftNoteFolded(id: number, now = Date.now()): void {
    this.withRetry(() =>
      this.db.prepare("UPDATE craft_notes SET folded_at = ? WHERE id = ? AND folded_at IS NULL").run(now, id),
    );
  }

  /**
   * Acquire the single-writer fold lease for a craft — an expired (or absent) lease is free to
   * take; a live one held by someone else is refused. Not journaled: purely local coordination
   * for "who is distilling this book right now," same spirit as wake_log.
   */
  acquireCraftFoldLease(craftSlug: string, holder: string, ttlMs = 10 * 60_000, now = Date.now()): boolean {
    const expires = now + ttlMs;
    const result = this.withRetry(() =>
      this.db
        .prepare(
          `INSERT INTO craft_folds (craft_slug, holder, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(craft_slug) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
           WHERE craft_folds.expires_at < ?`,
        )
        .run(craftSlug, holder, expires, now),
    );
    if (result.changes > 0) return true;
    // the INSERT half of the upsert didn't fire (row existed) and the WHERE blocked the
    // UPDATE half (lease still live) — but a lease this same holder already owns is fine to renew
    const existing = this.db
      .prepare("SELECT holder FROM craft_folds WHERE craft_slug = ?")
      .get(craftSlug) as { holder: string } | undefined;
    return existing?.holder === holder;
  }

  releaseCraftFoldLease(craftSlug: string, holder: string): void {
    this.withRetry(() =>
      this.db.prepare("DELETE FROM craft_folds WHERE craft_slug = ? AND holder = ?").run(craftSlug, holder),
    );
  }

  /**
   * Dispatch stats per craft, for the dashboard — craft_briefs is never trimmed, so dispatchCount
   * is a real all-time total. avgDurationMs is over completedCount dispatches only (noted_at IS
   * NOT NULL) — a dispatch whose sub-agent never completed the craft-note contract has no
   * duration, not a zero one; the caller should show "N of M dispatches reported a duration,"
   * never silently average nulls as zero.
   */
  craftUsageStats(): Map<
    string,
    {
      dispatchCount: number;
      lastDispatchedAt: number | null;
      stations: string[];
      completedCount: number;
      avgDurationMs: number | null;
    }
  > {
    const base = this.db
      .prepare("SELECT craft_slug, COUNT(*) as cnt, MAX(created_at) as last FROM craft_briefs GROUP BY craft_slug")
      .all() as Array<{ craft_slug: string; cnt: number; last: number }>;
    const stationRows = this.db.prepare("SELECT DISTINCT craft_slug, opened_by FROM craft_briefs").all() as Array<{
      craft_slug: string;
      opened_by: string;
    }>;
    const stationsBySlug = new Map<string, string[]>();
    for (const r of stationRows) {
      const list = stationsBySlug.get(r.craft_slug) ?? [];
      list.push(r.opened_by);
      stationsBySlug.set(r.craft_slug, list);
    }
    const durationRows = this.db
      .prepare(
        `SELECT craft_slug, COUNT(*) as cnt, AVG(noted_at - created_at) as avgMs
         FROM craft_briefs WHERE noted_at IS NOT NULL GROUP BY craft_slug`,
      )
      .all() as Array<{ craft_slug: string; cnt: number; avgMs: number }>;
    const durationBySlug = new Map(durationRows.map((r) => [r.craft_slug, r]));

    const result = new Map<
      string,
      {
        dispatchCount: number;
        lastDispatchedAt: number | null;
        stations: string[];
        completedCount: number;
        avgDurationMs: number | null;
      }
    >();
    for (const row of base) {
      const dur = durationBySlug.get(row.craft_slug);
      result.set(row.craft_slug, {
        dispatchCount: row.cnt,
        lastDispatchedAt: row.last,
        stations: stationsBySlug.get(row.craft_slug) ?? [],
        completedCount: dur?.cnt ?? 0,
        avgDurationMs: dur ? Math.round(dur.avgMs) : null,
      });
    }
    return result;
  }

  /**
   * `craft_briefs` rows whose `craft_slug` matches no currently-founded craft — dispatches that
   * never carried a real book/mise/skill because the name was wrong (hands#165: a mistyped or
   * stale slug used to succeed silently and write one of these). `knownSlugs` is the caller's
   * current roster (a filesystem read `Store` doesn't do itself); this is a pure DB-vs-list diff.
   * Never trimmed or auto-deleted — this only makes them visible, on the theory that a human who
   * finds a genuine reason to purge history should do it deliberately, not have it happen quietly.
   */
  orphanCraftBriefSlugs(knownSlugs: string[]): Array<{ slug: string; count: number }> {
    const known = new Set(knownSlugs);
    const rows = this.db
      .prepare("SELECT craft_slug, COUNT(*) as cnt FROM craft_briefs GROUP BY craft_slug")
      .all() as Array<{ craft_slug: string; cnt: number }>;
    return rows.filter((r) => !known.has(r.craft_slug)).map((r) => ({ slug: r.craft_slug, count: r.cnt }));
  }

  /**
   * Dispatch-rate visibility (hands#168): of the tickets that finished in the window, how many
   * carried at least one craft dispatch. `knownSlugs` filters out orphan/phantom briefs
   * (orphanCraftBriefSlugs) so a mistyped slug can never inflate this the way it inflated the
   * `craft_briefs` table itself pre-hands#165 — an empty `knownSlugs` correctly reports 0 rather
   * than joining against nothing.
   */
  craftDispatchRate(sinceMs: number, knownSlugs: string[]): { ticketsFinished: number; ticketsWithCraftBrief: number } {
    const finished = this.db
      .prepare("SELECT COUNT(*) as n FROM tasks WHERE finished_at IS NOT NULL AND finished_at >= ?")
      .get(sinceMs) as { n: number };
    if (knownSlugs.length === 0) return { ticketsFinished: finished.n, ticketsWithCraftBrief: 0 };
    const placeholders = knownSlugs.map(() => "?").join(",");
    const withCraft = this.db
      .prepare(
        `SELECT COUNT(DISTINCT t.id) as n FROM tasks t
         JOIN craft_briefs cb ON cb.ticket_id = t.id
         WHERE t.finished_at IS NOT NULL AND t.finished_at >= ? AND cb.craft_slug IN (${placeholders})`,
      )
      .get(sinceMs, ...knownSlugs) as { n: number };
    return { ticketsFinished: finished.n, ticketsWithCraftBrief: withCraft.n };
  }

  /**
   * Token usage per craft, from subagent_samples — written on every sub-agent finish but never
   * read anywhere until now. Only attributes calls where agent_type is literally "craft-<slug>"
   * (the fast/synced dispatch path); the "not yet synced" fallback dispatches as
   * "general-purpose" and isn't counted here — a real undercount the dashboard surfaces as a
   * caveat, not something this method should paper over. subagent_samples self-trims to the
   * trailing 7 days, so this is a recent window, not an all-time total.
   */
  craftTokenUsage(): Map<string, { totalOutputTokens: number; calls: number }> {
    const rows = this.db
      .prepare(
        `SELECT agent_type, SUM(output_tokens) as total, COUNT(*) as calls
         FROM subagent_samples WHERE agent_type LIKE 'craft-%' GROUP BY agent_type`,
      )
      .all() as Array<{ agent_type: string; total: number; calls: number }>;
    const result = new Map<string, { totalOutputTokens: number; calls: number }>();
    for (const row of rows) {
      result.set(row.agent_type.slice("craft-".length), { totalOutputTokens: row.total, calls: row.calls });
    }
    return result;
  }

  /** Every craft dispatch tied to a ticket (`hands craft brief --ticket <id>`) — a chit's "crafts used." */
  listCraftBriefsByTicket(ticketId: number): CraftBriefRow[] {
    return this.db
      .prepare("SELECT * FROM craft_briefs WHERE ticket_id = ? ORDER BY created_at ASC")
      .all(ticketId) as unknown as CraftBriefRow[];
  }

  /** Every ticket-tied craft dispatch, across all tickets — one query for the dashboard to group by ticket_id itself. */
  listCraftBriefsWithTicket(): CraftBriefRow[] {
    return this.db
      .prepare("SELECT * FROM craft_briefs WHERE ticket_id IS NOT NULL ORDER BY created_at ASC")
      .all() as unknown as CraftBriefRow[];
  }

  // --- journal replay (remote.ts restore path) ---

  /**
   * Materialize one journal event into the DB. Inserts carry their original
   * ids (OR IGNORE), updates re-apply — so replay is idempotent over a fresh
   * OR an existing DB. Returns false for an unrecognized event type (a newer
   * journal replayed by an older build skips rather than corrupts).
   * Deliberately does NOT re-emit to the journal.
   */
  applyEvent(type: string, data: Record<string, unknown>): boolean {
    // journal fields arrive as unknown JSON — coerce absent/undefined to null
    const f = (key: string): string | number | null => {
      const v = data[key];
      return typeof v === "string" || typeof v === "number" ? v : null;
    };
    const at = Number(data.at ?? Date.now());
    switch (type) {
      case "message":
        this.withRetry(() =>
          this.db
            .prepare(
              `INSERT OR IGNORE INTO messages (id, from_id, to_id, subject, body, thread_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(f("id"), f("from"), f("to"), f("subject"), f("body"), f("thread"), at),
        );
        return true;
      case "cursor":
        this.withRetry(() =>
          this.db
            .prepare(
              `INSERT INTO cursors (agent_id, last_read_message_id) VALUES (?, ?)
               ON CONFLICT(agent_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
            )
            .run(f("agent"), f("last")),
        );
        return true;
      case "journal.add":
        this.withRetry(() =>
          this.db
            .prepare(
              `INSERT OR IGNORE INTO journal (id, agent_id, kind, ref, text, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(f("id"), f("agent"), f("kind"), f("ref"), f("text"), at),
        );
        return true;
      case "question.ask":
        this.withRetry(() =>
          this.db
            .prepare(
              `INSERT OR IGNORE INTO questions (id, asker, question, context, state, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'open', ?, ?)`,
            )
            .run(f("id"), f("asker"), f("question"), f("context"), at, at),
        );
        return true;
      case "question.answer":
        this.withRetry(() =>
          this.db
            .prepare(
              `UPDATE questions SET state = 'answered', answer = ?, resolved_by = ?,
               priority_ref = COALESCE(?, priority_ref), updated_at = ? WHERE id = ?`,
            )
            .run(f("answer"), f("by"), f("priority"), at, f("id")),
        );
        return true;
      case "question.escalate":
        this.withRetry(() =>
          this.db
            .prepare(
              `UPDATE questions SET state = 'needs_human', recommendation = ?,
               priority_ref = COALESCE(?, priority_ref), updated_at = ? WHERE id = ?`,
            )
            .run(f("recommendation"), f("priority"), at, f("id")),
        );
        return true;
      case "question.outcome":
        this.withRetry(() =>
          this.db
            .prepare(
              `UPDATE questions SET outcome = ?, outcome_note = ?, outcome_at = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(f("outcome"), f("note"), at, at, f("id")),
        );
        return true;
      case "task.create":
        this.withRetry(() =>
          this.db
            .prepare(
              `INSERT OR IGNORE INTO tasks (id, created_by, assignee, title, body, state, priority_ref, dish, thread_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              f("id"),
              f("by"),
              f("assignee"),
              f("title"),
              f("body"),
              f("state"),
              f("priority"),
              f("dish"),
              f("thread"),
              at,
              at,
            ),
        );
        return true;
      case "task.update":
        this.withRetry(() =>
          this.db
            .prepare(
              `UPDATE tasks SET state = ?, assignee = COALESCE(?, assignee),
               result = COALESCE(?, result), updated_at = ? WHERE id = ?`,
            )
            .run(f("state"), f("assignee"), f("result"), at, f("id")),
        );
        return true;
      case "todo.create":
        this.withRetry(() =>
          this.db
            .prepare(
              `INSERT OR IGNORE INTO todos (id, title, detail, state, source, origin_ref, dedup_key, priority_ref, created_at, updated_at)
               VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              f("id"),
              f("title"),
              f("detail"),
              f("source") ?? "expo",
              f("origin"),
              f("dedupKey"),
              f("priority"),
              at,
              at,
            ),
        );
        return true;
      case "focus.set":
        this.withRetry(() =>
          this.db
            .prepare(
              `INSERT INTO agents (id, cwd, pid, registered_at, last_seen_at, focus)
               VALUES (?, '', 0, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET focus = excluded.focus`,
            )
            .run(f("station"), at, at, f("focus")),
        );
        return true;
      case "todo.update":
        this.withRetry(() =>
          this.db
            .prepare(
              `UPDATE todos SET state = ?, done_signal = COALESCE(?, done_signal), updated_at = ?
               WHERE id = ?`,
            )
            .run(f("state"), f("doneSignal"), at, f("id")),
        );
        return true;
      case "craft.note":
        this.withRetry(() =>
          this.db
            .prepare(
              `INSERT OR IGNORE INTO craft_notes (id, craft_slug, brief_id, source_agent, kind, body, spillover_craft, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(f("id"), f("craft"), f("briefId"), f("by"), f("kind"), f("body"), f("spilloverCraft"), at),
        );
        return true;
      default:
        return false;
    }
  }

  close(): void {
    this.db.close();
  }
}
