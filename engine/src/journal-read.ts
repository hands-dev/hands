import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { openJournal, type RemoteJournal, syncPull } from "./remote.js";

/**
 * Reading the books back from inside a working session (hands#156).
 *
 * The journal was write-only from the agent side: 18 `hands_*` tools, one
 * writer, zero readers. The books were written by the working agents and
 * readable only by a *different* MCP client (`hands mcp install`, for Claude
 * Desktop) that those agents don't have. The artifact designed to survive a
 * session boundary was unreachable from the session on the other side of it.
 *
 * What that cost, once, concretely: yesterday's page was 303 lines and
 * contained the line that settled a question three agents spent an afternoon
 * re-deriving —
 *
 *   "02:56 ENG-1536, local plane. The chain now runs dispatch → match → claim
 *    → exchange on real code paths with real signatures"
 *
 * Two stations proved the opposite from `origin/staging`. Both were right about
 * staging and wrong about the branch the work actually ran on. The status board
 * was marked disputed for an hour. The answer was on disk the whole time.
 *
 * `/hands:last-call` exists to write a good close-out. That investment only
 * pays if something reads it — otherwise the ritual is a diary, not a handoff.
 */

export interface JournalPage {
  date: string;
  /** `journal/<project>/<handle>/<date>.md` */
  relPath: string;
  text: string;
  lines: number;
  bytes: number;
}

export interface MirrorHealth {
  /** commits on origin the local mirror does not have */
  behind: number | null;
  /** local commits never pushed */
  ahead: number | null;
  /** a one-line description when the mirror cannot sync; null when healthy */
  problem: string | null;
}

export interface JournalReadResult {
  ok: boolean;
  /** why nothing could be read — books unconfigured, page absent, etc. */
  reason?: string;
  project?: string;
  handle?: string;
  pages: JournalPage[];
  /** dates present for this handle, newest first — so a caller can ask again precisely */
  available?: string[];
  /** set when a read came up empty, to distinguish "nothing written" from "cannot see it" */
  mirror?: MirrorHealth;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Can the local books mirror actually see origin?
 *
 * Found the hard way: this kitchen's mirror had 17 unpushed commits and sat 334
 * behind, so it could neither push nor fast-forward. Every page existed on
 * origin and none of them locally. A reader that answers "no pages yet" in that
 * state is confidently wrong, and it sends whoever reads it looking for a
 * missing feature instead of a broken clone.
 */
export function mirrorHealth(dir: string, url?: string): MirrorHealth {
  // Books fall back to a locally-bootstrapped git origin when no remote.url is
  // configured (hands#129). There is no upstream to track in that case and
  // nothing is wrong — reporting "never been able to pull" for every local
  // kitchen would be crying wolf, which is how a real warning gets ignored.
  const isRemote = /^(https?:\/\/|git@|ssh:\/\/)/.test(url ?? "");
  if (!isRemote) return { behind: 0, ahead: 0, problem: null };

  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      }).trim();
    } catch {
      return null;
    }
  };
  const upstream = git(["rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (!upstream) {
    return {
      behind: null,
      ahead: null,
      problem:
        "the local books mirror has no upstream branch — it has never been able to pull. " +
        "Fix: git -C <booksDir> branch --set-upstream-to=origin/main main",
    };
  }
  const counts = git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
  const [aheadRaw, behindRaw] = (counts ?? "").split(/\s+/);
  const ahead = Number.isFinite(Number(aheadRaw)) ? Number(aheadRaw) : null;
  const behind = Number.isFinite(Number(behindRaw)) ? Number(behindRaw) : null;

  if (ahead && behind) {
    return {
      behind,
      ahead,
      problem:
        `the local books mirror has DIVERGED from origin (${ahead} local-only, ${behind} behind) — ` +
        "it can neither push nor fast-forward, so writes stay local and origin's pages never arrive. " +
        "This needs a human: the local commits are real journal events.",
    };
  }
  if (behind) {
    return { behind, ahead, problem: `the local books mirror is ${behind} behind origin — pull it` };
  }
  return { behind: behind ?? 0, ahead: ahead ?? 0, problem: null };
}

function handleDir(journal: RemoteJournal): string {
  return path.join(journal.dir, "journal", journal.project, journal.handle);
}

/** Dated pages for this handle, newest first. README.md and log/ are not pages. */
export function availableDates(journal: RemoteJournal): string[] {
  try {
    return fs
      .readdirSync(handleDir(journal))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((d) => DATE_RE.test(d))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** `YYYY-MM-DD` for a date, in the same local-day terms the digests are written in. */
export function isoDay(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Read one or more daily pages.
 *
 * With no `date`, returns the most recent page that EXISTS rather than today's
 * — the handoff case is "what happened last shift", and today's page is often
 * empty at the moment you most need yesterday's.
 *
 * `pull` refreshes from the remote first. Off by default: reading must work
 * offline and must never be slow enough that a session skips it.
 */
export function readJournal(opts?: {
  date?: string;
  /** how many pages, newest first, when no explicit date is given */
  limit?: number;
  /** cap per page; a page can be tens of KB and this rides in a tool result */
  maxBytes?: number;
  pull?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): JournalReadResult {
  const journal = openJournal({ env: opts?.env, cwd: opts?.cwd });
  if (!journal) {
    return { ok: false, reason: "no books configured (remote.url) and no local origin", pages: [] };
  }
  if (opts?.pull) {
    // best-effort: a failed fetch must not stop us reading what's on disk
    try {
      syncPull(journal.dir);
    } catch {
      /* offline — local pages are still worth reading */
    }
  }

  const available = availableDates(journal);
  const wanted =
    opts?.date !== undefined
      ? [opts.date]
      : available.slice(0, Math.max(1, opts?.limit ?? 1));

  if (opts?.date !== undefined && !DATE_RE.test(opts.date)) {
    return { ok: false, reason: `date must be YYYY-MM-DD, got "${opts.date}"`, pages: [], available };
  }

  const maxBytes = opts?.maxBytes ?? 24_000;
  const pages: JournalPage[] = [];
  for (const date of wanted) {
    const rel = path.join("journal", journal.project, journal.handle, `${date}.md`);
    const file = path.join(journal.dir, rel);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      // Keep the HEAD, not the tail. Digests lead with the expo's Notes — the
      // narrative handoff — and trail into per-agent ticket lists.
      text = `${text.slice(0, maxBytes)}\n\n… truncated (${bytes} bytes total; ask for this date directly for more)`;
    }
    pages.push({ date, relPath: rel, text, lines: text.split("\n").length, bytes });
  }

  if (pages.length === 0) {
    // "No pages" has two very different causes and conflating them sent me
    // looking for a missing feature when the real problem was a broken mirror.
    // If the local clone is diverged or behind, the pages exist — we just can't
    // see them — and saying "no pages yet" would be a confident wrong answer.
    const mirror = mirrorHealth(journal.dir, journal.url);
    return {
      ok: false,
      reason:
        mirror.problem ??
        (available.length === 0
          ? "no pages in the books yet for this project/handle"
          : `no page for ${wanted.join(", ")}`),
      project: journal.project,
      handle: journal.handle,
      pages: [],
      available,
      mirror,
    };
  }
  return { ok: true, project: journal.project, handle: journal.handle, pages, available };
}

/**
 * The last page STRICTLY BEFORE `today` — what a shift-start read actually
 * wants. Asking for "yesterday" by subtracting a day misses a Friday close read
 * on a Monday morning, which is the common case.
 */
export function readPreviousPage(opts?: {
  today?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  maxBytes?: number;
}): JournalReadResult {
  const journal = openJournal({ env: opts?.env, cwd: opts?.cwd });
  if (!journal) {
    return { ok: false, reason: "no books configured (remote.url) and no local origin", pages: [] };
  }
  const today = opts?.today ?? isoDay(new Date());
  const previous = availableDates(journal).find((d) => d < today);
  if (!previous) {
    // Same trap as readJournal: "first shift" and "the mirror can't see origin"
    // look identical from here, and only one of them is good news.
    const mirror = mirrorHealth(journal.dir, journal.url);
    return {
      ok: false,
      reason: mirror.problem ?? "no earlier page in the books — this looks like the first shift",
      project: journal.project,
      handle: journal.handle,
      pages: [],
      available: availableDates(journal),
      mirror,
    };
  }
  return readJournal({ date: previous, env: opts?.env, cwd: opts?.cwd, maxBytes: opts?.maxBytes });
}

export interface RoleStateResult {
  ok: boolean;
  /** why nothing could be read — books unconfigured, mirror problem, etc. Absent alongside ok:true with empty text just means "never distilled yet." */
  reason?: string;
  role?: string;
  /** `journal/<project>/<handle>/roles/<role>.md` */
  relPath?: string;
  /** absolute path — a fold pass rewrites this file in place directly (Write tool), same as a craft book fold */
  file?: string;
  /** "" when the page has never been distilled — not itself a failure */
  text?: string;
  mirror?: MirrorHealth;
}

/**
 * A role's own standing, curated page (hands#115) — NOT a dated digest. Deliberately outside
 * `regenerateDigests`' deterministic re-render: a digest page is "what happened this day," rebuilt
 * from raw events and never revisited; a role's page is "current accumulated judgment," distilled
 * and pruned in place at `/hands:last-call`. Rendering it from events the way digests are would
 * make pruning impossible — you cannot re-derive "this is no longer true" from the historical fact
 * that it was once written. Riding the same `journal/<project>/<handle>/` tree it does mean the
 * existing `syncPush`/`syncPull` staging (which stages that whole directory, not just dated files)
 * carries this page for free — no separate sync path to build or maintain.
 */
export function readRoleState(role: string, opts?: { env?: NodeJS.ProcessEnv; cwd?: string }): RoleStateResult {
  const journal = openJournal({ env: opts?.env, cwd: opts?.cwd });
  if (!journal) {
    return { ok: false, reason: "no books configured (remote.url) and no local origin" };
  }
  const relPath = path.join("journal", journal.project, journal.handle, "roles", `${role}.md`);
  const file = path.join(journal.dir, relPath);
  try {
    const text = fs.readFileSync(file, "utf8");
    return { ok: true, role, relPath, file, text };
  } catch {
    // Missing has two different causes, same trap readJournal already guards against: a
    // genuinely first-ever distillation, or a mirror that can't see a page that exists on
    // origin. Only the second is actually bad news.
    const mirror = mirrorHealth(journal.dir, journal.url);
    return {
      ok: mirror.problem === null,
      reason: mirror.problem ?? "no standing page yet for this role — never distilled",
      role,
      relPath,
      file,
      text: "",
      mirror,
    };
  }
}
