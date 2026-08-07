import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { coordinationDir } from "./paths.js";

/**
 * Exclusive, worktree-scoped ownership for a station session (hands#153).
 *
 * A station IS its worktree. Two sessions in one worktree is not a degraded
 * mode, it's a correctness hazard — and a silent one. What it looked like when
 * it happened here, twice:
 *
 * - Two contradictory messages from "station-2" in the same update: one
 *   reporting the work complete with commit SHAs, the other reporting it had
 *   written nothing. Neither was lying, and the expo had no way to tell them
 *   apart — it had already routed a ruling to one that the other never asked.
 * - A station found commits on its own branch it had not made, and edits
 *   appearing in its tree while it held still. It escalated an unexplained
 *   concurrent writer, correctly, and blamed the wrong culprit — itself.
 * - One ticket, two builders.
 *
 * Correctness survived only because the two designs happened to converge. That
 * is luck, not a property of the system: two sessions writing one working tree
 * will eventually clobber each other mid-edit, and the losing write leaves no
 * trace.
 *
 * Detection landed first (see sessions.ts + the doctor checks). This is the
 * prevention. Detection stays: a lock is a cooperative guard, and anything that
 * starts without asking still needs to be *visible*.
 */

export interface LockRecord {
  /** pid of the session holding the worktree */
  pid: number;
  /** process start time, to survive pid reuse — null when unavailable */
  startedAtBoot: number | null;
  /** wall-clock claim time, for display */
  claimedAt: number;
  agentId: string;
  worktree: string;
  hostname: string;
}

export type ClaimOutcome =
  | { ok: true; record: LockRecord; previous: "none" | "stale" | "self" | "evicted" }
  | { ok: false; heldBy: LockRecord };

/**
 * One lock file per worktree PATH, not per station id — the whole failure mode
 * is a pane whose id disagrees with the directory it's in (hands#152), so
 * keying by id would let exactly the broken case slip through.
 */
export function lockPath(
  worktree: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): string {
  let resolved = worktree;
  try {
    resolved = fs.realpathSync(worktree);
  } catch {
    // not on disk yet — the literal path is still a stable key
  }
  const digest = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return path.join(
    coordinationDir(env, cwd ?? resolved),
    "locks",
    `${path.basename(resolved)}-${digest}.json`,
  );
}

/** Linux: field 22 of /proc/<pid>/stat is start time in clock ticks since boot. */
export function processStartTime(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm can contain spaces and parens — split after the closing paren
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(after[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but belongs to another user — still alive
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Is this lock still held by the process that took it?
 *
 * A dead pid is stale. A LIVE pid whose start time disagrees with the record is
 * also stale — that's pid reuse, and treating it as held would wedge the
 * worktree until someone deleted the file by hand. When start time is
 * unavailable (non-Linux), liveness alone decides.
 */
export function isStale(record: LockRecord): boolean {
  if (!isAlive(record.pid)) return true;
  if (record.startedAtBoot === null) return false;
  const now = processStartTime(record.pid);
  return now !== null && now !== record.startedAtBoot;
}

export function readLock(worktree: string, env?: NodeJS.ProcessEnv, cwd?: string): LockRecord | null {
  try {
    const raw = fs.readFileSync(lockPath(worktree, env, cwd), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.pid !== "number" || typeof parsed.worktree !== "string") return null;
    return {
      pid: parsed.pid,
      startedAtBoot: typeof parsed.startedAtBoot === "number" ? parsed.startedAtBoot : null,
      claimedAt: typeof parsed.claimedAt === "number" ? parsed.claimedAt : 0,
      agentId: typeof parsed.agentId === "string" ? parsed.agentId : "unknown",
      worktree: parsed.worktree,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "unknown",
    };
  } catch {
    return null;
  }
}

/**
 * Claim a worktree for this session.
 *
 * - no lock, or a stale one → take it
 * - held by this same pid → idempotent, re-affirm it
 * - held by a live foreign pid → refuse, naming the holder, unless `evict`
 *
 * Refusing is the default deliberately. Eviction kills a session that may be
 * mid-edit; the caller should choose that explicitly, and a human reading
 * "refused: pid 24450 holds this worktree" learns more than a session that
 * silently vanished.
 */
export function claimWorktree(opts: {
  worktree: string;
  agentId: string;
  pid?: number;
  evict?: boolean;
  now?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): ClaimOutcome {
  const pid = opts.pid ?? process.pid;
  const file = lockPath(opts.worktree, opts.env, opts.cwd);
  const existing = readLock(opts.worktree, opts.env, opts.cwd);

  let previous: "none" | "stale" | "self" | "evicted" = "none";
  if (existing) {
    if (existing.pid === pid) previous = "self";
    else if (isStale(existing)) previous = "stale";
    else if (opts.evict) {
      try {
        process.kill(existing.pid, "SIGTERM");
      } catch {
        // already gone, or not ours to signal — taking the lock is still right
      }
      previous = "evicted";
    } else {
      return { ok: false, heldBy: existing };
    }
  }

  const record: LockRecord = {
    pid,
    startedAtBoot: processStartTime(pid),
    claimedAt: opts.now ?? Date.now(),
    agentId: opts.agentId,
    worktree: opts.worktree,
    hostname: os.hostname(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return { ok: true, record, previous };
}

/** Release only if we hold it — never yank someone else's claim. */
export function releaseWorktree(
  worktree: string,
  pid: number = process.pid,
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): boolean {
  const existing = readLock(worktree, env, cwd);
  if (!existing || existing.pid !== pid) return false;
  try {
    fs.rmSync(lockPath(worktree, env, cwd), { force: true });
    return true;
  } catch {
    return false;
  }
}
