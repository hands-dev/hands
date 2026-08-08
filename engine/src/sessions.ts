import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Which live Claude Code sessions exist, where each one is rooted, and what
 * identity it claims.
 *
 * Two failures in this kitchen needed exactly this and had nothing to answer
 * it with (hands#147, hands#152, hands#153):
 *
 * - Two full sessions occupied ONE station worktree. Symptoms pointed
 *   everywhere except the cause: a station reported "everything committed"
 *   while its branch was 16 commits ahead, and a commit appeared on its branch
 *   that it hadn't made — its twin had. Found by hand with `lsof -d cwd`.
 * - A pane launched from station-2's worktree carried `HANDS_ID=station-1`.
 *   The resolver honours env over cwd (see identity.ts), so both panes answered
 *   to one id — and `doctor` called both healthy.
 *
 * The bus cannot see any of this: it only knows the ids that talk to it, and
 * two panes sharing an id look like one busy station.
 *
 * DESIGN RULE: never report "fine" when we could not actually look. Every
 * result carries how it was obtained, and `unsupported` is a distinct outcome
 * from "looked and found nothing" — conflating them is how #152 got a clean
 * bill of health while broken.
 *
 * macOS gets `unsupported` unconditionally (hands#100/#206). This used to run
 * `lsof -a -c claude -d cwd`, which walks the whole process table to filter by
 * name and triggered a real macOS TCC privacy prompt (Photos/Documents/etc.)
 * on some machines — `hands doctor` was asking people to grant the terminal
 * app broad access just to run a health check. A `-p <pid>`-scoped lsof call
 * (candidates from `pgrep -x claude`, which is pure process-table metadata and
 * never touches a file descriptor) measured clean against the TCC subsystem
 * log in testing — no REQUEST/AUTHREQ/GRANT activity, vs. the whole-table scan
 * this replaced. But that's one observation on one machine, not proof for
 * every account and OS version, and the fix here is deliberately the
 * conservative side of that uncertainty: a broken check beats conditioning
 * someone into clicking through privacy dialogs for a terminal tool. See
 * `doctor.ts`'s "sessions" check — `unsupported` there is a `warn`, not a
 * silent pass, so this degrades loudly rather than invisibly.
 */

/** How the scan was performed — `unsupported` means we could not look at all. */
export type ScanMethod = "proc" | "unsupported";

export interface ClaudeSession {
  pid: number;
  /** working directory the session is rooted in */
  cwd: string;
  /** HANDS_ID from the process environment, when readable */
  handsId: string | null;
}

export interface SessionScan {
  method: ScanMethod;
  sessions: ClaudeSession[];
  /** why the scan could not run, when method is "unsupported" */
  reason?: string;
}

function isClaudeProcess(pid: number): boolean {
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    if (comm === "claude") return true;
    // node-launched wrappers keep comm="node"; check argv[0..1] for the CLI
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return cmdline.slice(0, 2).some((a) => /(^|\/)claude$/.test(a));
  } catch {
    return false;
  }
}

function envValue(pid: number, key: string): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    for (const entry of raw.split("\0")) {
      if (entry.startsWith(`${key}=`)) return entry.slice(key.length + 1) || null;
    }
  } catch {
    // not ours to read, or the process exited mid-scan
  }
  return null;
}

/** Linux: /proc gives cwd AND environment, so both detections are possible. */
function scanViaProc(): SessionScan {
  const sessions: ClaudeSession[] = [];
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return { method: "unsupported", sessions: [], reason: "/proc is not readable" };
  }
  for (const name of pids) {
    const pid = Number(name);
    if (!isClaudeProcess(pid)) continue;
    let cwd: string;
    try {
      cwd = fs.realpathSync(fs.readlinkSync(`/proc/${pid}/cwd`));
    } catch {
      continue; // exited, or another user's process
    }
    sessions.push({ pid, cwd, handsId: envValue(pid, "HANDS_ID") });
  }
  return { method: "proc", sessions };
}

export function scanClaudeSessions(platform: NodeJS.Platform = process.platform): SessionScan {
  if (platform === "linux") return scanViaProc();
  if (platform === "darwin") {
    return {
      method: "unsupported",
      sessions: [],
      reason: "session inspection on macOS risks a TCC privacy prompt (hands#206) — see sessions.ts",
    };
  }
  return {
    method: "unsupported",
    sessions: [],
    reason: `no session inspection on ${platform}`,
  };
}

/** Sessions rooted in `dir`, by exact resolved path. */
export function sessionsIn(dir: string, scan: SessionScan): ClaudeSession[] {
  let target = dir;
  try {
    target = fs.realpathSync(dir);
  } catch {
    // dir is gone; fall back to the literal path
  }
  return scan.sessions.filter((s) => s.cwd === target);
}

/**
 * A pane whose declared HANDS_ID disagrees with the station worktree it is
 * running in. `null` handsId (unreadable env, or an unmanaged session) is not a
 * conflict — absence of evidence is not evidence of a mismatch.
 */
export interface IdentityConflict {
  pid: number;
  cwd: string;
  /** what the pane claims to be */
  claimed: string;
  /** what its worktree says it should be */
  expected: string;
}

export function identityConflicts(
  stations: readonly { id: string; dir: string }[],
  scan: SessionScan,
): IdentityConflict[] {
  const conflicts: IdentityConflict[] = [];
  for (const station of stations) {
    for (const session of sessionsIn(station.dir, scan)) {
      if (session.handsId && session.handsId !== station.id) {
        conflicts.push({
          pid: session.pid,
          cwd: session.cwd,
          claimed: session.handsId,
          expected: station.id,
        });
      }
    }
  }
  return conflicts;
}

/**
 * STATION ids claimed by more than one live pane, whatever worktree they sit in.
 *
 * Scoped to station ids on purpose. Several sessions sharing the **expo** seat
 * in the main checkout is normal and documented — the principal opening a
 * second window is the ordinary case, and `tokens.ts` explicitly counts those
 * against the expo seat. Flagging it was a false positive on the very first
 * live run of this check. A station is different: it owns a worktree and a
 * branch, and two panes answering to one station id will commit over each
 * other (hands#147, hands#152).
 */
export function contestedIds(
  scan: SessionScan,
  stationIds: readonly string[],
): Map<string, ClaudeSession[]> {
  const known = new Set(stationIds);
  const byId = new Map<string, ClaudeSession[]>();
  for (const session of scan.sessions) {
    if (!session.handsId || !known.has(session.handsId)) continue;
    const list = byId.get(session.handsId) ?? [];
    list.push(session);
    byId.set(session.handsId, list);
  }
  for (const [id, list] of byId) {
    if (list.length < 2) byId.delete(id);
  }
  return byId;
}

/** Short display form for a session, for check output. */
export function describeSession(s: ClaudeSession): string {
  return `pid ${s.pid}${s.handsId ? ` (HANDS_ID=${s.handsId})` : ""} in ${path.basename(s.cwd)}`;
}
