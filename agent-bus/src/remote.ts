import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentBusConfig, loadConfig } from "./config.js";
import { coordinationDir } from "./paths.js";
import { writePriorities } from "./priorities.js";
import type { Store } from "./store.js";

/**
 * Durable remote journal — the bus gets a git remote.
 *
 * The local SQLite DB stays the fast working copy; the remote repo is the
 * durable, append-only event log it can always be rebuilt from. Every
 * state-changing action appends one NDJSON line under this fleet's handle
 * (`log/<handle>/<yyyy-mm-dd>.<writer>.ndjson`; writer = sanitized hostname,
 * so two machines on one handle never contend on a file) in a local clone;
 * pushes ride the
 * Stop-hook publish cadence (debounced, best-effort, offline-tolerant).
 * Restore = pull + replay (`agent-bus restore`).
 *
 * Multiplayer is the same mechanism pointed at a shared repo: each fleet
 * appends ONLY under its own handle, so writers never touch the same path
 * and sync reduces to pull-rebase-push with no merge logic.
 *
 * Everything here is best-effort by design — a journal or git hiccup must
 * never fail the bus action it mirrors. Delivery correctness lives in the
 * DB; durability is eventually caught up by the next sync.
 */

export const JOURNAL_VERSION = 1;

/**
 * Journal-REPO layout version, recorded in the `agent-bus.json` marker at the
 * repo root. The marker is the shape contract: it identifies a repo as an
 * agent-bus journal (guarding against a typo'd remote.url pointing at some
 * real repo), and gates replay when the layout is newer than this build. The
 * tool owns exactly two root paths — `agent-bus.json` and `log/` — and never
 * stages anything else, so the repo may freely hold other content.
 */
export const JOURNAL_LAYOUT = 1;
export const MARKER_FILE = "agent-bus.json";

export interface JournalEvent {
  v: number;
  ts: number;
  /** e.g. message | cursor | question.ask | task.update | priorities.set */
  type: string;
  data: Record<string, unknown>;
}

/** Debounce between pushes — one turn-end push per window, not per turn. */
const PUSH_DEBOUNCE_MS = 60_000;
const GIT_TIMEOUT_MS = 20_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export interface RemoteJournal {
  dir: string;
  handle: string;
  url: string;
  /** per-machine log-file suffix (sanitized hostname unless overridden) */
  writerId: string;
  /** append one event to today's log file (best-effort, synchronous) */
  append: (type: string, data: Record<string, unknown>) => void;
}

/** Sanitized per-machine writer id — keeps same-handle clones on separate files. */
export function defaultWriterId(): string {
  try {
    const host = os.hostname().split(".")[0] ?? "";
    const clean = host.toLowerCase().replace(/[^a-z0-9-]/g, "");
    return clean || "writer";
  } catch {
    return "writer";
  }
}

export function resolveHandle(config: AgentBusConfig): string {
  const h = config.remote.handle?.trim();
  if (h) return h;
  try {
    return os.userInfo().username;
  } catch {
    return "local";
  }
}

/** Where the journal clone lives for this repo's bus. */
export function journalDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return path.join(coordinationDir(env, cwd), "remote");
}

/**
 * Make sure `dir` is a git work tree wired to `url`. `git init` + remote-add
 * (not clone) so it works identically for an empty remote, an existing one,
 * and a dir that already has unpushed local commits.
 */
export function ensureRepo(dir: string, url: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(dir, ".git"))) {
      git(dir, ["init", "-q", "-b", "main"]);
      git(dir, ["config", "user.name", "agent-bus"]);
      git(dir, ["config", "user.email", "agent-bus@localhost"]);
    }
    if (tryGit(dir, ["remote", "get-url", "origin"]) === null) {
      git(dir, ["remote", "add", "origin", url]);
    } else {
      git(dir, ["remote", "set-url", "origin", url]);
    }
    return true;
  } catch {
    return false;
  }
}

/** Fetch + integrate origin/main (rebase keeps our unpushed appends on top). */
export function syncPull(dir: string): boolean {
  // fetch all refs — asking for `main` explicitly fails on a still-empty remote
  if (tryGit(dir, ["fetch", "-q", "origin"]) === null) return false;
  if (tryGit(dir, ["rev-parse", "--verify", "origin/main"]) === null) return true; // empty remote
  if (tryGit(dir, ["rev-parse", "--verify", "HEAD"]) === null) {
    // no local commits yet — just adopt the remote
    return tryGit(dir, ["reset", "--hard", "-q", "origin/main"]) !== null;
  }
  if (tryGit(dir, ["rebase", "-q", "origin/main"]) === null) {
    tryGit(dir, ["rebase", "--abort"]);
    return false;
  }
  return true;
}

export interface SyncResult {
  status: "pushed" | "clean" | "debounced" | "invalid" | "error";
  detail?: string;
}

interface Validation {
  ok: boolean;
  /** marker was just written (empty/legacy repo bootstrapped, or --adopt) */
  bootstrapped?: boolean;
  /** repo has foreign content and no marker — needs an explicit adopt */
  needsAdopt?: boolean;
  reason?: string;
}

function readMarker(dir: string): { journal: number } | null | "malformed" {
  const file = path.join(dir, MARKER_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { journal?: unknown };
    return typeof parsed?.journal === "number" ? { journal: parsed.journal } : "malformed";
  } catch {
    return "malformed";
  }
}

/**
 * Enforce the journal-repo shape contract.
 *
 * write mode (sync path): marker present → layout-version gate. Marker absent →
 * bootstrap it when the repo is empty (or holds only `log/` — a phase-1
 * journal), REFUSE when the repo has other content unless `adopt` — the guard
 * against a typo'd remote.url quietly committing logs into some real repo.
 *
 * read mode (restore path): only the version gate — reading never mutates or
 * refuses; a foreign repo simply yields no events.
 */
export function validateJournal(
  dir: string,
  opts?: { write?: boolean; adopt?: boolean },
): Validation {
  const marker = readMarker(dir);
  if (marker === "malformed") {
    return { ok: false, reason: `${MARKER_FILE} is malformed — fix or delete it in the journal repo` };
  }
  if (marker) {
    if (marker.journal > JOURNAL_LAYOUT) {
      return {
        ok: false,
        reason: `journal layout v${marker.journal} was written by a newer agent-bus — update the plugin`,
      };
    }
    return { ok: true };
  }
  if (!opts?.write) return { ok: true }; // read mode: nothing to gate
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((e) => e !== ".git");
  } catch {
    return { ok: false, reason: `journal dir unreadable: ${dir}` };
  }
  const foreign = entries.filter((e) => e !== "log");
  if (foreign.length > 0 && !opts.adopt) {
    return {
      ok: false,
      needsAdopt: true,
      reason:
        "the configured remote.url is not an agent-bus journal (no agent-bus.json) and is not empty. " +
        "If this repo is really where the journal should live, run `agent-bus sync --adopt` once to " +
        "initialize the journal structure alongside the existing content.",
    };
  }
  fs.writeFileSync(path.join(dir, MARKER_FILE), `${JSON.stringify({ journal: JOURNAL_LAYOUT })}\n`);
  return { ok: true, bootstrapped: true };
}

/** Marker/status live under .git/ so they never dirty the journal work tree. */
function debounceMarkerPath(dir: string): string {
  return path.join(dir, ".git", "agent-bus-last-push");
}

function syncStatusPath(dir: string): string {
  return path.join(dir, ".git", "agent-bus-sync-status");
}

export interface SyncStatus extends SyncResult {
  at: number;
}

function writeSyncStatus(dir: string, result: SyncResult, now: number): void {
  try {
    fs.writeFileSync(syncStatusPath(dir), `${JSON.stringify({ ...result, at: now })}\n`);
  } catch {
    // observability only
  }
}

/** Last syncPush outcome (push/auth failures are otherwise invisible to the hook path). */
export function readSyncStatus(dir: string): SyncStatus | null {
  try {
    return JSON.parse(fs.readFileSync(syncStatusPath(dir), "utf8")) as SyncStatus;
  } catch {
    return null;
  }
}

/**
 * Commit + push any journal appends. Debounced via a marker file so the
 * per-turn Stop hook costs nothing most turns. All failures are soft — the
 * commits stay local and the next sync catches up. Order matters: local
 * appends are committed FIRST (rebase refuses a dirty tracked tree), then we
 * pull, then validate the merged shape — so nothing is ever pushed to a repo
 * that fails the contract (stray local commits in our private clone are
 * harmless).
 */
export function syncPush(
  dir: string,
  opts?: { force?: boolean; now?: number; adopt?: boolean },
): SyncResult {
  const now = opts?.now ?? Date.now();
  const marker = debounceMarkerPath(dir);
  if (!opts?.force) {
    try {
      if (now - fs.statSync(marker).mtimeMs < PUSH_DEBOUNCE_MS) return { status: "debounced" };
    } catch {
      // no marker yet — proceed
    }
  }
  const finish = (result: SyncResult): SyncResult => {
    writeSyncStatus(dir, result, now);
    return result;
  };
  try {
    // stage only the paths the tool owns — and only ones that exist (a bare
    // `git add log` before the first append is a pathspec fatal)
    const own = ["log", MARKER_FILE].filter((p) => fs.existsSync(path.join(dir, p)));
    if (own.length > 0) git(dir, ["add", "-A", "--", ...own]);
    let dirty = git(dir, ["status", "--porcelain", "--", "log", MARKER_FILE]) !== "";
    if (dirty) {
      git(dir, ["commit", "-q", "-m", `journal: ${new Date(now).toISOString()}`]);
    }
    if (!syncPull(dir)) return finish({ status: "error", detail: "pull failed (offline?)" });
    const validation = validateJournal(dir, { write: true, adopt: opts?.adopt });
    if (!validation.ok) return finish({ status: "invalid", detail: validation.reason });
    if (validation.bootstrapped) {
      git(dir, ["add", "--", MARKER_FILE]);
      git(dir, ["commit", "-q", "-m", "journal: initialize agent-bus structure"]);
      dirty = true;
    }
    const ahead = tryGit(dir, ["rev-list", "--count", "origin/main..HEAD"]);
    if (!dirty && ahead === "0") {
      fs.writeFileSync(marker, "");
      return finish({ status: "clean" });
    }
    git(dir, ["push", "-q", "-u", "origin", "main"]);
    fs.writeFileSync(marker, "");
    return finish({ status: "pushed" });
  } catch (err) {
    return finish({
      status: "error",
      detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
    });
  }
}

/**
 * Open (or lazily create) this repo's journal. Returns null when no remote is
 * configured — callers wire the returned `append` into the Store.
 */
export function openJournal(options?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  config?: AgentBusConfig;
  /** override the per-machine file suffix (tests simulate two machines) */
  writerId?: string;
}): RemoteJournal | null {
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();
  const config = options?.config ?? loadConfig({ cwd, env });
  const url = config.remote.url?.trim();
  if (!url) return null;
  const dir = journalDir(env, cwd);
  ensureRepo(dir, url); // best-effort — appends work even if git wiring failed
  const handle = resolveHandle(config);
  const writerId = options?.writerId ?? defaultWriterId();
  const logDir = path.join(dir, "log", handle);
  return {
    dir,
    handle,
    url,
    writerId,
    append(type, data) {
      try {
        fs.mkdirSync(logDir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        const event: JournalEvent = { v: JOURNAL_VERSION, ts: Date.now(), type, data };
        fs.appendFileSync(
          path.join(logDir, `${day}.${writerId}.ndjson`),
          `${JSON.stringify(event)}\n`,
          { mode: 0o600 },
        );
      } catch {
        // best-effort — never fail the bus action being journaled
      }
    },
  };
}

/**
 * Read one handle's events in causal order. Files sort by date name; with
 * per-writer suffixes a handle may span several files per day, so events are
 * re-sorted by `ts` (stable — same-ts events keep their file order), which
 * keeps update-after-insert correct across a machine move.
 */
export function readEvents(dir: string, handle: string): JournalEvent[] {
  const logDir = path.join(dir, "log", handle);
  let files: string[] = [];
  try {
    files = fs.readdirSync(logDir).filter((f) => f.endsWith(".ndjson")).sort();
  } catch {
    return [];
  }
  const events: JournalEvent[] = [];
  for (const file of files) {
    let body: string;
    try {
      body = fs.readFileSync(path.join(logDir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JournalEvent;
        if (parsed && typeof parsed.type === "string" && parsed.data) events.push(parsed);
      } catch {
        // a torn/corrupt line loses one event, never the restore
      }
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

export interface ReplayResult {
  applied: number;
  skipped: number;
}

/**
 * Materialize events into the local state. Idempotent — inserts are
 * by-explicit-id (OR IGNORE) and updates re-apply, so replaying over an
 * existing DB (or twice) converges instead of duplicating.
 */
export function replayInto(
  store: Store,
  events: readonly JournalEvent[],
  env: NodeJS.ProcessEnv = process.env,
): ReplayResult {
  let applied = 0;
  let skipped = 0;
  for (const event of events) {
    try {
      if (event.type === "priorities.set") {
        const items = Array.isArray(event.data.items) ? (event.data.items as string[]) : [];
        writePriorities(items, env);
        applied++;
        continue;
      }
      if (store.applyEvent(event.type, event.data)) applied++;
      else skipped++;
    } catch {
      skipped++; // one malformed event never sinks the restore
    }
  }
  return { applied, skipped };
}
