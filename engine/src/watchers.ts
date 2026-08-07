import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

/**
 * What a station currently has ARMED — its inbox tail, and any ad-hoc poll
 * loops it started (hands#133).
 *
 * Two gaps this closes, both of which produced wrong statements to the
 * principal on the same day:
 *
 * - "idle" and "deaf" are indistinguishable on the board (hands#121). A station
 *   whose inbox tail died looks exactly like one with nothing to do — it just
 *   never wakes again. The expo infers liveness today; it should see it.
 * - Stopping a station's `/loop` does NOT stop its watchers. They're detached
 *   processes that outlive the schedule. Five stations were "stopped"; an hour
 *   later one still had two live watchers, including a poll loop on a CI run
 *   that could never complete — still able to wake, still spending quota. The
 *   expo told the principal a station was watching a critical run when it
 *   wasn't, and that a stopped station was frozen when it wasn't.
 *
 * Everything here is best-effort and read-only unless explicitly asked to kill.
 * A station that can't be inspected reports as unknown, never as quiet.
 */

export interface Watcher {
  pid: number;
  /** the command line, trimmed for display */
  command: string;
  /** true when this is the station's own `.notify` inbox tail — its wake signal */
  isInbox: boolean;
}

export interface WatcherReport {
  stationId: string;
  /** null when the process table could not be inspected at all */
  watchers: Watcher[] | null;
  /** the wake signal specifically: alive, dead, or unknown */
  inboxAlive: boolean | null;
}

/** Poll-loop shapes, which legitimately run under a shell. */
const LOOP_PATTERNS = [/\bwhile\s+true\b/, /\buntil\s+\[/, /\bwhile\s+\[/];
/** Watcher executables, matched on argv[0] rather than anywhere in the string. */
const WATCHER_BINARIES = new Set(["tail", "inotifywait", "fswatch"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

function argvOf(pid: number): string[] | null {
  try {
    const parts = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return parts.length > 0 ? parts : null;
  } catch {
    return null;
  }
}

/**
 * Match the EXECUTABLE, not the string.
 *
 * A `bash -c "… tail -F …/station-3.notify"` wrapper carries the whole command
 * in its own cmdline, so substring matching counted the shell that spawns the
 * tail, the tail itself, and every sibling wrapper — four "inbox watchers" for
 * one actual tail, on the first live run. Killing the tail is what matters;
 * the wrapper is not a second watcher.
 */
function classify(argv: string[], inboxNeedle: string): Watcher | null {
  const joined = argv.join(" ");
  const bin = (argv[0] ?? "").split("/").pop() ?? "";

  if (WATCHER_BINARIES.has(bin)) {
    return {
      pid: 0,
      command: joined,
      isInbox: bin === "tail" && joined.includes(inboxNeedle),
    };
  }
  // A shell only counts when it IS the loop, not when it merely spawns a watcher.
  if (SHELLS.has(bin) && LOOP_PATTERNS.some((re) => re.test(joined))) {
    return { pid: 0, command: joined, isInbox: false };
  }
  return null;
}

/** cwd of a pid, or null. */
function cwdOf(pid: number): string | null {
  try {
    return fs.realpathSync(fs.readlinkSync(`/proc/${pid}/cwd`));
  } catch {
    return null;
  }
}

/**
 * This process and every ancestor.
 *
 * `--clear` killed the caller's OWN tool-invocation shells on its first live
 * run: they were shells, they contained a loop, and they mentioned the station
 * id because the command being run mentioned it. Excluding only `process.pid`
 * was not enough — the wrapper shells above us matched too. Never signal our
 * own lineage.
 */
function selfLineage(): Set<number> {
  const line = new Set<number>();
  let pid = process.pid;
  for (let hops = 0; pid > 1 && hops < 32; hops++) {
    line.add(pid);
    const stat: string | null = (() => {
      try {
        return fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        return null;
      }
    })();
    if (stat === null) break;
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!Number.isFinite(ppid) || ppid <= 0) break;
    pid = ppid;
  }
  return line;
}

function allPids(): number[] | null {
  try {
    return fs
      .readdirSync("/proc")
      .filter((n) => /^\d+$/.test(n))
      .map(Number);
  } catch {
    return null;
  }
}

/**
 * Watchers belonging to `stationId`.
 *
 * Ownership is PROVEN, not guessed: a process counts only if it references the
 * station's notify path, or runs inside the station's worktree. Matching on
 * "the command line mentions station-3" was the first attempt and it caught the
 * caller's own tool shells, which `--clear` then killed.
 *
 * Deliberately does NOT walk the session's process tree either: a Monitor is
 * detached and survives its parent, so parentage is exactly the wrong key —
 * that's why "the pane is closed" never meant "the watcher stopped".
 */
export function watchersFor(
  stationId: string,
  opts?: { notifyPath?: string; worktree?: string },
): WatcherReport {
  const pids = allPids();
  if (pids === null) {
    return { stationId, watchers: null, inboxAlive: null };
  }
  const watchers: Watcher[] = [];
  const inboxNeedle = opts?.notifyPath ?? `${stationId}.notify`;
  const worktree = opts?.worktree;
  const mine = selfLineage();

  for (const pid of pids) {
    if (mine.has(pid)) continue; // never our own lineage — see selfLineage()
    const argv = argvOf(pid);
    if (!argv) continue;
    const hit = classify(argv, inboxNeedle);
    if (!hit) continue;

    // Ownership must be PROVEN, not guessed. "the command line mentions
    // station-3" is far too loose — it matched the caller's own tool shells,
    // which --clear then killed. A watcher belongs to this station only if it
    // references the station's notify path, or runs inside its worktree.
    // The inbox tail proves itself: argv[0] IS `tail` and it names this
    // station's notify file. Anything else must be running INSIDE the station's
    // worktree. Deliberately not "its command line mentions the notify path" —
    // a forked shell inherits its parent's whole command line, so that clause
    // matched the caller's own harness and `--clear` killed it.
    const owned = hit.isInbox || (worktree !== undefined && cwdOf(pid) === worktree);
    if (!owned) continue;

    watchers.push({
      pid,
      command: hit.command.length > 160 ? `${hit.command.slice(0, 159)}…` : hit.command,
      isInbox: hit.isInbox,
    });
  }
  return {
    stationId,
    watchers,
    inboxAlive: watchers.some((w) => w.isInbox),
  };
}

/**
 * Stop a station's watchers. Returns what was actually stopped.
 *
 * `keepInbox` (the default) leaves the wake signal armed: quiescing a station
 * usually means "stop the stray poll loops", not "make it permanently deaf".
 * Killing the inbox tail without saying so is how a station gets silently
 * removed from the bus.
 */
export function quiesce(
  stationId: string,
  opts?: { notifyPath?: string; worktree?: string; keepInbox?: boolean },
): { stopped: Watcher[]; kept: Watcher[]; supported: boolean } {
  const report = watchersFor(stationId, { notifyPath: opts?.notifyPath, worktree: opts?.worktree });
  if (report.watchers === null) return { stopped: [], kept: [], supported: false };
  const keepInbox = opts?.keepInbox ?? true;

  const stopped: Watcher[] = [];
  const kept: Watcher[] = [];
  for (const w of report.watchers) {
    if (w.isInbox && keepInbox) {
      kept.push(w);
      continue;
    }
    try {
      process.kill(w.pid, "SIGTERM");
      stopped.push(w);
    } catch {
      // already gone, or not ours to signal
    }
  }
  return { stopped, kept, supported: true };
}

/**
 * Cheap liveness probe for one station's wake signal, for the board.
 * `null` means "couldn't look" — which must not render as "fine".
 */
export function inboxMonitorAlive(stationId: string, notifyPath?: string): boolean | null {
  if (process.platform !== "linux") {
    // pgrep exists on macOS; fall back to it rather than reporting a false negative
    try {
      const out = execFileSync("pgrep", ["-f", `tail -F .*${stationId}\\.notify`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });
      return out.trim().length > 0;
    } catch (err) {
      // pgrep exits 1 with no matches — that's a real "no", not a failure
      return (err as { status?: number }).status === 1 ? false : null;
    }
  }
  return watchersFor(stationId, { notifyPath }).inboxAlive;
}
