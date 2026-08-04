import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type YesChefConfig, loadConfig } from "./config.js";
import { regenerateDigests } from "./digest.js";
import { coordinationDir, repoInfo } from "./paths.js";
import { writePriorities } from "./priorities.js";
import type { Store } from "./store.js";

/**
 * Durable remote journal — the bus gets a git remote.
 *
 * The local SQLite DB stays the fast working copy; the remote repo is the
 * durable, append-only event log it can always be rebuilt from. Layout v2 is
 * organized for BROWSING — project, then contributor, then date — with the
 * machine log nested underneath:
 *
 *   journal/<project>/<handle>/<date>.md          digest
 *   journal/<project>/<handle>/log/<date>.ndjson  event log
 *
 * `project` is a PORTABLE key (the origin repo name, or config
 * remote.project) — deliberately not the coordination slug, which hashes the
 * machine-local path. One handle = one writer at a time: two machines on the
 * same handle share the day's log file, so concurrent same-day writes can
 * conflict (accepted — sync surfaces it; sequential pull-then-append is
 * clean). Pushes ride the Stop-hook publish cadence (debounced, best-effort,
 * offline-tolerant). Restore = pull + replay (`yes-chef restore`).
 *
 * Multiplayer is the same mechanism pointed at a shared repo: each fleet
 * appends ONLY under its own project/handle namespace, so writers never touch
 * the same path and sync reduces to pull-rebase-push with no merge logic.
 *
 * Everything here is best-effort by design — a journal or git hiccup must
 * never fail the bus action it mirrors. Delivery correctness lives in the
 * DB; durability is eventually caught up by the next sync.
 */

export const JOURNAL_VERSION = 1;

/**
 * Journal-REPO layout version, recorded in the `yes-chef.json` marker at the
 * repo root. The marker is the shape contract: it identifies a repo as an
 * yes-chef journal (guarding against a typo'd remote.url pointing at some
 * real repo), and gates replay when the layout doesn't match this build. The
 * tool owns exactly the marker and `journal/` — and never stages anything
 * else, so the repo may freely hold other content.
 */
export const JOURNAL_LAYOUT = 2;
export const MARKER_FILE = "yes-chef.json";

export interface JournalEvent {
  v: number;
  ts: number;
  /** e.g. message | cursor | question.ask | task.update | priorities.set */
  type: string;
  /** emitting agent (expo | station-<n>) */
  agent?: string;
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

/** The identity triple sync/read operations need — RemoteJournal carries it. */
export interface JournalRef {
  dir: string;
  project: string;
  handle: string;
}

export interface RemoteJournal extends JournalRef {
  url: string;
  /** emitting agent stamped onto every event (expo | station-<n>) */
  agentId: string | null;
  /** append one event to today's log file (best-effort, synchronous) */
  append: (type: string, data: Record<string, unknown>) => void;
}

/**
 * Path-segment hygiene for project/handle names: lowercase, keep
 * `[a-z0-9._-]`, map the rest to `-`, strip leading dots (no hidden dirs, no
 * `..` escapes), never empty. A handle containing `/` must not shift the tree.
 */
export function sanitizeSegment(raw: string, fallback = "unnamed"): string {
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^\.+/, "");
  return clean || fallback;
}

/**
 * Derive the portable project key from a git origin URL: the repo name
 * (last path segment), lowercased (GitHub names are case-insensitive —
 * mixed-case origins must not split one project in two). Handles scp
 * (`git@host:owner/repo.git`) and URL forms. Returns null when unparseable.
 * Two same-named repos from different owners collide — set `remote.project`
 * explicitly to disambiguate.
 */
export function projectFromOrigin(originUrl: string): string | null {
  let p = originUrl.trim().replace(/\.git\/?$/, "");
  if (!p) return null;
  const scp = p.match(/^[^@/]+@[^:/]+:(.+)$/);
  if (scp) p = scp[1]!;
  else {
    try {
      p = new URL(p).pathname;
    } catch {
      // not a URL — treat as a bare path
    }
  }
  const segments = p.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last ? sanitizeSegment(last) : null;
}

const projectCache = new Map<string, string>();

/**
 * The project key for a working directory: config override → origin-derived →
 * repo/dir basename (machine-dependent by nature — set `remote.project` for
 * origin-less repos that sync across machines). Cached per cwd like repoInfo.
 */
export function resolveProject(config: YesChefConfig, cwd: string = process.cwd()): string {
  const override = config.remote.project?.trim();
  if (override) return sanitizeSegment(override);
  const cached = projectCache.get(cwd);
  if (cached !== undefined) return cached;
  let project: string | null = null;
  const root = repoInfo(cwd)?.repoRoot ?? cwd;
  const origin = tryGit(root, ["remote", "get-url", "origin"]);
  if (origin) project = projectFromOrigin(origin);
  if (!project) project = sanitizeSegment(path.basename(root));
  projectCache.set(cwd, project);
  return project;
}

/** Test hook: drop the per-cwd project cache. */
export function resetProjectCache(): void {
  projectCache.clear();
}

/**
 * The GitHub username via the gh CLI (setup-time helper for handle defaults —
 * a network call, so never used on the runtime journal path). Null when gh is
 * missing or unauthenticated.
 */
export function githubUsername(): string | null {
  try {
    const out = execFileSync("gh", ["api", "user", "-q", ".login"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function resolveHandle(config: YesChefConfig): string {
  const h = config.remote.handle?.trim();
  if (h) return sanitizeSegment(h, "local");
  try {
    return sanitizeSegment(os.userInfo().username, "local");
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
      git(dir, ["config", "user.name", "yes-chef"]);
      git(dir, ["config", "user.email", "yes-chef@localhost"]);
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

export interface PullResult {
  ok: boolean;
  reason?: "offline" | "conflict";
}

/**
 * Fetch + integrate origin/main (rebase keeps our unpushed appends on top).
 *
 * Digest .md files are the one legitimately multi-writer path (same handle,
 * two machines, each rendering from a different pre-merge event set), so a
 * rebase conflict confined to digest .md files under `journal/` is auto-resolved — either
 * side's content is fine because the caller regenerates digests from the
 * MERGED events right after the pull, and the deterministic renderer makes
 * both machines converge on identical bytes. Any non-digest conflict still
 * aborts — including two machines appending the same handle's day log
 * concurrently (accepted: one handle = one writer at a time).
 */
export function syncPull(dir: string): PullResult {
  // fetch all refs — asking for `main` explicitly fails on a still-empty remote
  if (tryGit(dir, ["fetch", "-q", "origin"]) === null) return { ok: false, reason: "offline" };
  if (tryGit(dir, ["rev-parse", "--verify", "origin/main"]) === null) return { ok: true }; // empty remote
  if (tryGit(dir, ["rev-parse", "--verify", "HEAD"]) === null) {
    // no local commits yet — just adopt the remote
    return tryGit(dir, ["reset", "--hard", "-q", "origin/main"]) !== null
      ? { ok: true }
      : { ok: false, reason: "conflict" };
  }
  if (tryGit(dir, ["rebase", "-q", "origin/main"]) !== null) return { ok: true };

  // bounded: one conflicted replayed commit resolved per iteration
  for (let round = 0; round < 10; round++) {
    const conflictedRaw = tryGit(dir, ["diff", "--name-only", "--diff-filter=U"]);
    const conflicted = (conflictedRaw ?? "").split("\n").filter(Boolean);
    const digestOnly =
      conflicted.length > 0 &&
      conflicted.every((f) => f.startsWith("journal/") && f.endsWith(".md"));
    if (!digestOnly) break;
    if (tryGit(dir, ["checkout", "--theirs", "--", ...conflicted]) === null) break;
    if (tryGit(dir, ["add", "--", ...conflicted]) === null) break;
    if (tryGit(dir, ["-c", "core.editor=true", "rebase", "--continue"]) !== null) {
      return { ok: true };
    }
  }
  tryGit(dir, ["rebase", "--abort"]);
  return { ok: false, reason: "conflict" };
}

export interface SyncResult {
  status: "pushed" | "clean" | "debounced" | "invalid" | "error";
  detail?: string;
}

interface Validation {
  ok: boolean;
  /** marker was just written (bootstrap or --adopt) */
  bootstrapped?: boolean;
  /** repo has foreign content and no marker — needs an explicit adopt */
  needsAdopt?: boolean;
  reason?: string;
}

/** Root paths the tool owns; anything else in the repo is foreign. */
const OWNED_ROOT = new Set([MARKER_FILE, "journal"]);

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
 * bootstrap it when the repo is empty, REFUSE when the repo has other content
 * unless `adopt` — the guard against a typo'd remote.url quietly committing
 * logs into some real repo.
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
        reason: `journal layout v${marker.journal} was written by a newer yes-chef — update the plugin`,
      };
    }
    if (marker.journal < JOURNAL_LAYOUT) {
      return {
        ok: false,
        reason: `journal layout v${marker.journal} is no longer supported — start a fresh journal repo`,
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
  const foreign = entries.filter((e) => !OWNED_ROOT.has(e));
  if (foreign.length > 0 && !opts.adopt) {
    return {
      ok: false,
      needsAdopt: true,
      reason:
        "the configured remote.url is not an yes-chef journal (no yes-chef.json marker — either " +
        "this is the wrong repo, or the marker was deleted) and it is not empty. If this repo is " +
        "really where the journal should live, run `yes-chef sync --adopt` once to initialize " +
        "the journal structure alongside the existing content.",
    };
  }
  // empty repo or an explicit adopt
  fs.writeFileSync(path.join(dir, MARKER_FILE), `${JSON.stringify({ journal: JOURNAL_LAYOUT })}\n`);
  return { ok: true, bootstrapped: true };
}

/** Marker/status live under .git/ so they never dirty the journal work tree. */
function debounceMarkerPath(dir: string): string {
  return path.join(dir, ".git", "yes-chef-last-push");
}

function syncStatusPath(dir: string): string {
  return path.join(dir, ".git", "yes-chef-sync-status");
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
 * Dates whose log files changed between `head0` and HEAD for this
 * project/handle (own appends were committed before the pull, so the range
 * covers both sides of the merge). Returns undefined (= regenerate all dates)
 * when the range is unknowable — fresh repo, or head0 unreachable after an
 * unrelated-history rebase.
 */
function changedLogDates(
  dir: string,
  head0: string | null,
  journal: JournalRef,
): Set<string> | undefined {
  if (!head0) return undefined;
  const diff = tryGit(dir, [
    "diff",
    "--name-only",
    `${head0}..HEAD`,
    "--",
    path.join("journal", journal.project, journal.handle, "log"),
  ]);
  if (diff === null) return undefined;
  const dates = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = path.basename(line).match(/^(\d{4}-\d{2}-\d{2})(?:\..*)?\.ndjson$/);
    if (m) dates.add(m[1]!);
  }
  return dates;
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
  journal: JournalRef,
  opts?: { force?: boolean; now?: number; adopt?: boolean },
): SyncResult {
  const { dir, project, handle } = journal;
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
    // remembered so the post-pull digest pass knows which dates changed
    const head0 = tryGit(dir, ["rev-parse", "--verify", "HEAD"]);
    // stage only the paths this writer owns — and only ones that exist (a
    // bare `git add` on a missing pathspec is a fatal).
    const ownPaths = [path.join("journal", project, handle), MARKER_FILE];
    const own = ownPaths.filter((p) => fs.existsSync(path.join(dir, p)));
    if (own.length > 0) git(dir, ["add", "-A", "--", ...own]);
    let dirty = own.length > 0 && git(dir, ["status", "--porcelain", "--", ...own]) !== "";
    if (dirty) {
      git(dir, ["commit", "-q", "-m", `journal: ${new Date(now).toISOString()}`]);
    }
    const pulled = syncPull(dir);
    if (!pulled.ok) {
      return finish({
        status: "error",
        detail:
          pulled.reason === "conflict"
            ? `rebase conflict on non-digest files — inspect the journal clone at ${dir}`
            : "fetch failed (offline?)",
      });
    }
    const validation = validateJournal(dir, { write: true, adopt: opts?.adopt });
    if (!validation.ok) return finish({ status: "invalid", detail: validation.reason });
    if (validation.bootstrapped) {
      git(dir, ["add", "--", MARKER_FILE]);
      git(dir, ["commit", "-q", "-m", `journal: layout v${JOURNAL_LAYOUT} marker`]);
      dirty = true;
    }
    // Digests regenerate AFTER the pull, from the merged event set — the
    // deterministic renderer converges same-handle machines on identical
    // bytes. Dates to re-render = every date whose log files changed since
    // head0 (own appends + anything the pull brought in, including late
    // events for past days); unknown range → all dates.
    const digestDates = changedLogDates(dir, head0, journal);
    const changedDigests = regenerateDigests(journal, digestDates);
    if (changedDigests.length > 0) {
      git(dir, ["add", "--", path.join("journal", project, handle)]);
      git(dir, ["commit", "-q", "-m", "journal: digests"]);
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
  config?: YesChefConfig;
  /** emitting agent id, stamped onto every event (expo | station-<n>) */
  agentId?: string;
}): RemoteJournal | null {
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();
  const config = options?.config ?? loadConfig({ cwd, env });
  const url = config.remote.url?.trim();
  if (!url) return null;
  const dir = journalDir(env, cwd);
  ensureRepo(dir, url); // best-effort — appends work even if git wiring failed
  const project = resolveProject(config, cwd);
  const handle = resolveHandle(config);
  const agentId = options?.agentId ?? null;
  const logDir = path.join(dir, "journal", project, handle, "log");
  return {
    dir,
    project,
    handle,
    url,
    agentId,
    append(type, data) {
      try {
        fs.mkdirSync(logDir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        const event: JournalEvent = {
          v: JOURNAL_VERSION,
          ts: Date.now(),
          type,
          ...(agentId ? { agent: agentId } : {}),
          data,
        };
        fs.appendFileSync(path.join(logDir, `${day}.ndjson`), `${JSON.stringify(event)}\n`, {
          mode: 0o600,
        });
      } catch {
        // best-effort — never fail the bus action being journaled
      }
    },
  };
}

function readEventsFromDir(logDir: string, into: JournalEvent[], onlyFile?: string): void {
  let files: string[] = [];
  try {
    files = fs.readdirSync(logDir).filter((f) => f.endsWith(".ndjson")).sort();
  } catch {
    return;
  }
  if (onlyFile) files = files.filter((f) => f === onlyFile);
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
        if (parsed && typeof parsed.type === "string" && parsed.data) into.push(parsed);
      } catch {
        // a torn/corrupt line loses one event, never the restore
      }
    }
  }
}

/**
 * Read one (project, handle)'s events in causal order. Files sort by date
 * name; events are re-sorted by `ts` (stable — same-ts events keep their
 * file order), which keeps update-after-insert correct across days.
 */
export function readEvents(dir: string, project: string, handle: string): JournalEvent[] {
  const events: JournalEvent[] = [];
  readEventsFromDir(path.join(dir, "journal", project, handle, "log"), events);
  return events.sort((a, b) => a.ts - b.ts);
}

export interface KitchenUpdate {
  ts: number;
  type: string;
  agent: string | null;
  summary: string;
}

export interface OtherKitchen {
  handle: string;
  lastTs: number | null;
  updates: KitchenUpdate[];
}

/** Code-point-safe truncation for update summaries. */
function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length <= max ? flat : `${points.slice(0, max - 1).join("")}…`;
}

/**
 * One line per event for the other-kitchens feed. Message BODIES never
 * render (same rule as digests — they stay in the NDJSON layer); bookkeeping
 * events return null and are skipped.
 */
function summarizeEvent(e: JournalEvent): string | null {
  const d = e.data as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (e.type) {
    case "task.create":
      return clip(`ticket #${d.id} fired${s(d.title) ? `: ${s(d.title)}` : ""}`);
    case "task.update":
      return clip(`ticket #${d.id} → ${s(d.state)}`);
    case "question.ask":
      return clip(`asked: ${s(d.question)}`);
    case "question.answer":
      return `question #${d.id} answered`;
    case "question.escalate":
      return `question #${d.id} escalated`;
    case "priorities.set":
      return `specials set (${Array.isArray(d.items) ? d.items.length : 0})`;
    case "digest.note":
      return clip(`note: ${s(d.text)}`);
    case "focus.set":
      return clip(`${s(d.station)} focus → ${s(d.focus) || "cleared"}`);
    case "journal.add":
      return clip(`${s(d.kind) || "entry"}: ${s(d.text) || s(d.ref)}`);
    case "todo.create":
      return clip(`todo for the chef: ${s(d.title)}`);
    case "todo.update":
      return `todo #${d.id} → ${s(d.state)}`;
    default:
      return null; // messages, cursors, unknown bookkeeping — not feed material
  }
}

/**
 * Recent activity from every OTHER handle in this project's books — the
 * multiplayer read. Scans only the last `days` day-files per handle, so cost
 * stays flat as history grows. Purely local (reads the clone); pair with a
 * periodic syncPull for liveness.
 */
export function readOtherKitchens(
  dir: string,
  project: string,
  ownHandle: string,
  opts?: { days?: number; limitPerHandle?: number },
): OtherKitchen[] {
  const days = opts?.days ?? 2;
  const limit = opts?.limitPerHandle ?? 15;
  let handles: string[] = [];
  try {
    handles = fs
      .readdirSync(path.join(dir, "journal", project), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== ownHandle)
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const kitchens: OtherKitchen[] = [];
  for (const handle of handles) {
    const logDir = path.join(dir, "journal", project, handle, "log");
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(logDir)
        .filter((f) => f.endsWith(".ndjson"))
        .sort()
        .slice(-days);
    } catch {
      // handle dir without a log tree — still list it, empty
    }
    const events: JournalEvent[] = [];
    for (const file of files) readEventsFromDir(logDir, events, file);
    events.sort((a, b) => a.ts - b.ts);
    const updates: KitchenUpdate[] = [];
    for (const e of events) {
      const summary = summarizeEvent(e);
      if (summary) updates.push({ ts: e.ts, type: e.type, agent: e.agent ?? null, summary });
    }
    const recent = updates.slice(-limit).reverse(); // newest first
    kitchens.push({
      handle,
      lastTs: events.length > 0 ? (events[events.length - 1]?.ts ?? null) : null,
      updates: recent,
    });
  }
  return kitchens;
}

/** Project dirs present in the journal (the restore-miss hint). */
export function listProjects(dir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, "journal"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
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
  // Known renderer-only events: no DB state, applied as a no-op so restore
  // doesn't warn "written by a newer build?" about its own vocabulary.
  const stateless = new Set(["digest.note"]);
  for (const event of events) {
    try {
      if (stateless.has(event.type)) {
        applied++;
        continue;
      }
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
