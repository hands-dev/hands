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
 * (`log/<handle>/<yyyy-mm-dd>.ndjson`) in a local clone; pushes ride the
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
  /** append one event to today's log file (best-effort, synchronous) */
  append: (type: string, data: Record<string, unknown>) => void;
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
  status: "pushed" | "clean" | "debounced" | "error";
  detail?: string;
}

/**
 * Commit + push any journal appends. Debounced via a marker file so the
 * per-turn Stop hook costs nothing most turns. All failures are soft — the
 * commits stay local and the next sync catches up.
 */
export function syncPush(dir: string, opts?: { force?: boolean; now?: number }): SyncResult {
  const now = opts?.now ?? Date.now();
  const marker = path.join(dir, ".last-push");
  if (!opts?.force) {
    try {
      if (now - fs.statSync(marker).mtimeMs < PUSH_DEBOUNCE_MS) return { status: "debounced" };
    } catch {
      // no marker yet — proceed
    }
  }
  try {
    git(dir, ["add", "-A", "log"]);
    const dirty = git(dir, ["status", "--porcelain"]) !== "";
    if (dirty) {
      git(dir, ["commit", "-q", "-m", `journal: ${new Date(now).toISOString()}`]);
    }
    const ahead = tryGit(dir, ["rev-list", "--count", "origin/main..HEAD"]);
    if (!dirty && ahead === "0") {
      fs.writeFileSync(marker, "");
      return { status: "clean" };
    }
    if (!syncPull(dir)) return { status: "error", detail: "pull failed (offline?)" };
    git(dir, ["push", "-q", "-u", "origin", "main"]);
    fs.writeFileSync(marker, "");
    return { status: "pushed" };
  } catch (err) {
    return {
      status: "error",
      detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
    };
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
}): RemoteJournal | null {
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();
  const config = options?.config ?? loadConfig({ cwd, env });
  const url = config.remote.url?.trim();
  if (!url) return null;
  const dir = journalDir(env, cwd);
  ensureRepo(dir, url); // best-effort — appends work even if git wiring failed
  const handle = resolveHandle(config);
  const logDir = path.join(dir, "log", handle);
  return {
    dir,
    handle,
    url,
    append(type, data) {
      try {
        fs.mkdirSync(logDir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        const event: JournalEvent = { v: JOURNAL_VERSION, ts: Date.now(), type, data };
        fs.appendFileSync(path.join(logDir, `${day}.ndjson`), `${JSON.stringify(event)}\n`, {
          mode: 0o600,
        });
      } catch {
        // best-effort — never fail the bus action being journaled
      }
    },
  };
}

/** Read one handle's events in append order (files sort by date name). */
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
  return events;
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
