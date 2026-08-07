import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { readLock } from "./worktree-lock.js";
import { inboxMonitorAlive } from "./watchers.js";

/**
 * Station readiness — "I am clean and ready" (hands#157).
 *
 * The expo dispatches from whatever picture it has, and a stale picture at the
 * expo becomes *everyone's* stale picture. Measured mid-shift once, **not one
 * workspace was ready**: every station carried leftovers, and the expo itself —
 * the pane writing all the tickets — was 992 commits behind and dirty. It filed
 * a false "this is unversioned" alarm about a directory that was tracked the
 * whole time.
 *
 * The design (principal's): the expo cleans its OWN checkout and nothing else.
 * It does not inspect or clean seven worktrees it doesn't own. Each station
 * attests about itself; no current attestation means no tickets to that
 * station. Per-station, not global — one dirty station stops tickets to that
 * station, not the kitchen.
 *
 * WHY THIS IS A MACHINE CHECK, NOT AN ASSERTION: a station cannot attest by
 * saying so. It runs this, and this re-derives every fact. Otherwise
 * "attested" degrades into "said so", which is worth nothing at the moment you
 * rely on it.
 *
 * CLEAN MEANS ZERO STATE: no dish left half-made, no missing ingredients.
 * Two halves, both required — see `Readiness` below.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Readiness {
  ok: boolean;
  checks: Check[];
  /** the failing checks, joined — the station's answer to "why not?" */
  reason: string | null;
  headSha: string | null;
  originSha: string | null;
  lockPid: number | null;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Assess a station worktree.
 *
 * On tickets: neither an `assigned` ticket nor this station's own `in_progress`
 * ticket is dirt. `/hands:last-call` deliberately preps next-day work and leaves
 * things in_progress so a station knows where to start — treating either as
 * leftover would make the close-out ritual and the open-up gate reject each
 * other every morning. An order waiting is the menu; a dish half-cooked is
 * uncommitted CHANGES, which the `clean` check already catches.
 */
export function assessReadiness(opts: {
  worktree: string;
  agentId: string;
  /** ids of tickets this station holds in_progress and will resume (reported, never blocking) */
  resumingTickets?: string[];
  notifyPath?: string;
  /** skip the network fetch (tests, offline) */
  offline?: boolean;
}): Readiness {
  const { worktree, agentId } = opts;
  const checks: Check[] = [];

  // ── nothing left over ────────────────────────────────────────────────────
  const status = git(worktree, ["status", "--porcelain", "--untracked-files=all"]);
  if (status === null) {
    checks.push({ name: "worktree", ok: false, detail: `cannot read git status in ${worktree}` });
  } else {
    const dirty = status.split("\n").filter(Boolean);
    checks.push({
      name: "clean",
      ok: dirty.length === 0,
      detail:
        dirty.length === 0
          ? "working tree clean"
          : `${dirty.length} uncommitted change(s) — commit to the station branch or stash with a named message; do NOT discard`,
    });
  }

  const stashes = git(worktree, ["stash", "list"]);
  const stashCount = stashes ? stashes.split("\n").filter(Boolean).length : 0;
  checks.push({
    name: "stashes",
    ok: stashCount === 0,
    detail:
      stashCount === 0
        ? "no stashes"
        : `${stashCount} stash(es) — an unclaimed stash is a question for the expo, not garbage`,
  });

  // A station's OWN in_progress ticket is work to resume, not dirt — the
  // station is alive and about to cook it, and /hands:last-call deliberately
  // leaves work in_progress so a station knows where to start. Flagging it here
  // would fail attestation every morning for doing exactly what the close-out
  // asked. "Stranded" means in_progress with NO live session, which is a fact
  // about OTHER stations for the expo to detect — not something a running
  // station can be guilty of about itself.
  const resuming = opts.resumingTickets ?? [];
  checks.push({
    name: "tickets",
    ok: true,
    detail:
      resuming.length === 0
        ? "no tickets to resume"
        : `resuming ${resuming.join(", ")} from the previous shift`,
  });

  // ── nothing missing ──────────────────────────────────────────────────────
  const branch = git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const expected = `hands/${agentId}`;
  checks.push({
    name: "branch",
    ok: branch === expected,
    detail: branch === expected ? `on ${branch}` : `on ${branch ?? "?"} — expected ${expected}`,
  });

  if (!opts.offline) git(worktree, ["fetch", "--quiet", "origin"]);
  const headSha = git(worktree, ["rev-parse", "HEAD"]);
  const originSha = git(worktree, ["rev-parse", "origin/main"]);
  const behind =
    originSha && headSha
      ? Number(git(worktree, ["rev-list", "--count", `HEAD..${originSha}`]) ?? "0")
      : 0;
  checks.push({
    name: "synced",
    ok: behind === 0,
    detail: behind === 0 ? "up to date with origin/main" : `${behind} behind origin/main — rebase`,
  });

  const lock = readLock(worktree);
  checks.push({
    name: "lock",
    ok: lock !== null,
    detail: lock ? `worktree held by pid ${lock.pid}` : "worktree not claimed — run `hands claim`",
  });

  const inbox = inboxMonitorAlive(agentId, opts.notifyPath);
  checks.push({
    name: "monitor",
    ok: inbox === true,
    detail:
      inbox === true
        ? "inbox monitor armed"
        : inbox === false
          ? "inbox monitor DEAD — this station cannot be woken"
          : "inbox monitor state unknown on this platform",
  });

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    reason: failed.length === 0 ? null : failed.map((c) => c.detail).join("; "),
    headSha,
    originSha,
    lockPid: lock?.pid ?? null,
  };
}

/**
 * Is a recorded attestation still good?
 *
 * Measured against EVENTS, not the clock. #157's sharpest point is that
 * `hands_priorities` reports `stale: false` when the list was merely *set*
 * recently — so an out-of-date map arrives with a freshness stamp on it. An
 * attestation with the same flaw would be worse than none.
 *
 * Note the offline case is deliberately cheap: a station that attested clean
 * and then sat idle is still clean, because nothing ran. Requiring every
 * station to boot just to re-sign would make mornings worse, which is how a
 * ceremony gets disabled in week two.
 */
export function attestationValid(
  record: { ok: number; head_sha: string | null; origin_sha: string | null; lock_pid: number | null; at: number },
  now: {
    headSha: string | null;
    originSha: string | null;
    lockPid: number | null;
    shiftStartedAt?: number;
  },
): { valid: boolean; reason: string | null } {
  if (!record.ok) return { valid: false, reason: "the station declined to attest" };
  if (record.head_sha && now.headSha && record.head_sha !== now.headSha) {
    return { valid: false, reason: "the worktree has moved since it attested" };
  }
  if (record.origin_sha && now.originSha && record.origin_sha !== now.originSha) {
    return { valid: false, reason: "origin/main has advanced since it attested" };
  }
  if (record.lock_pid && now.lockPid && record.lock_pid !== now.lockPid) {
    return { valid: false, reason: "the worktree lock changed hands since it attested" };
  }
  if (now.shiftStartedAt && record.at < now.shiftStartedAt) {
    return { valid: false, reason: "attested in a previous shift" };
  }
  return { valid: true, reason: null };
}

/** Station worktree → its notify file, for the monitor check. */
export function notifyFor(coordinationDir: string, agentId: string): string {
  return path.join(coordinationDir, `${agentId}.notify`);
}
