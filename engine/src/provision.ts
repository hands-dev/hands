import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type HandsConfig, loadConfig } from "./config.js";
import { type RepoInfo, repoInfo } from "./paths.js";
import { seedStationPermissions } from "./seed-permissions.js";

/**
 * Station provisioning — the user thinks in STATIONS, never worktrees. Each
 * station is a Claude Code session launched with HANDS_ID=station-<n>
 * inside a managed git worktree (the hidden isolation primitive) under
 * `~/.hands/worktrees/<slug>/station-<n>`. That root lives OUTSIDE the
 * repo tree so nested-repo tooling never sees it, and the worktree shares the
 * repo's git common-dir, so every station automatically lands on the expo's
 * bus.
 */

export interface ManagedStation {
  id: string;
  index: number;
  dir: string;
  branch: string;
  /** dir exists on disk (a stale registry row would be false) */
  present: boolean;
}

export interface LaunchPlan {
  id: string;
  dir: string;
  branch: string;
  model: string;
  /** the exact command a human could paste into a fresh terminal */
  command: string;
  /** how it was (or wasn't) started: tmux | iterm | manual */
  launcher: "tmux" | "iterm" | "manual";
  launched: boolean;
}

export class ProvisionError extends Error {}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

function requireRepo(cwd: string): RepoInfo {
  const info = repoInfo(cwd);
  if (!info) throw new ProvisionError(`not inside a git repo: ${cwd}`);
  return info;
}

/** Where this repo's managed station worktrees live. */
export function stationRoot(cwd: string = process.cwd(), config?: HandsConfig): string {
  const cfg = config ?? loadConfig({ cwd });
  if (cfg.stations.worktreeRoot) return cfg.stations.worktreeRoot;
  return path.join(os.homedir(), ".hands", "worktrees", requireRepo(cwd).slug);
}

export function stationBranch(index: number): string {
  return `hands/station-${index}`;
}

/** List managed stations (station-<n> dirs under the station root). */
export function listStations(cwd: string = process.cwd(), config?: HandsConfig): ManagedStation[] {
  const root = stationRoot(cwd, config);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const stations: ManagedStation[] = [];
  for (const name of names) {
    const m = name.match(/^station-(\d+)$/);
    if (!m) continue;
    const index = Number.parseInt(m[1]!, 10);
    stations.push({
      id: `station-${index}`,
      index,
      dir: path.join(root, name),
      branch: stationBranch(index),
      present: true,
    });
  }
  return stations.sort((a, b) => a.index - b.index);
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Which skill loop a spawned session comes up in. */
export type LaunchMode = "expo" | "station";

/**
 * Compose the paste-able launch command for a session (plugin-namespaced skill).
 * Defaults to `station` so existing callers are unaffected; `expo` is what the
 * `hands <project>` launcher uses to bring up a kitchen's pass.
 */
export function launchCommand(
  target: { id: string; dir: string; model?: string },
  mode: LaunchMode = "station",
): string {
  const skill = mode === "expo" ? "/loop /hands:expo" : "/loop /hands:station";
  // No model → omit the flag entirely and inherit the principal's own default.
  // Stations get a configured tier (stations.model); the expo has no such
  // config field, and picking one on the principal's behalf would silently
  // downgrade the pass.
  const modelFlag = target.model ? ` --model ${shellQuote(target.model)}` : "";
  return `cd ${shellQuote(target.dir)} && HANDS_ID=${target.id} claude${modelFlag} ${shellQuote(skill)}`;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a station session via the configured launcher. Returns the effective
 * launcher + whether a session was actually spawned. `manual` never spawns —
 * it's the zero-assumption fallback where the human pastes the command.
 */
export function launch(
  plan: { id: string; dir: string; model?: string },
  launcher: HandsConfig["stations"]["launcher"],
  env: NodeJS.ProcessEnv = process.env,
  launchMode: LaunchMode = "station",
): { launcher: "tmux" | "iterm" | "manual"; launched: boolean } {
  const command = launchCommand(plan, launchMode);
  const mode =
    launcher === "auto" ? (env.TMUX || tmuxAvailable() ? "tmux" : "manual") : launcher;

  if (mode === "tmux") {
    try {
      if (env.TMUX) {
        // inside a session → new window there
        execFileSync("tmux", ["new-window", "-d", "-n", plan.id, command], {
          stdio: "ignore",
          timeout: 10_000,
        });
      } else {
        // no session → dedicated detached session per station (idempotent-ish:
        // a duplicate session name fails, which we surface)
        execFileSync(
          "tmux",
          ["new-session", "-d", "-s", `hands-${plan.id}`, command],
          { stdio: "ignore", timeout: 10_000 },
        );
      }
      return { launcher: "tmux", launched: true };
    } catch {
      return { launcher: "manual", launched: false };
    }
  }

  if (mode === "iterm") {
    const script = `tell application "iTerm"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow to write text ${JSON.stringify(command)}
end tell`;
    try {
      const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
      child.unref();
      return { launcher: "iterm", launched: true };
    } catch {
      return { launcher: "manual", launched: false };
    }
  }

  return { launcher: "manual", launched: false };
}

/**
 * Provision the next N stations: create each managed worktree (branch
 * `hands/station-<n>` off the configured base) and launch its session.
 * The worktree is never surfaced to the user — only the station id is.
 */
export function addStations(
  count: number,
  opts?: { cwd?: string; config?: HandsConfig; env?: NodeJS.ProcessEnv },
): LaunchPlan[] {
  const cwd = opts?.cwd ?? process.cwd();
  const cfg = opts?.config ?? loadConfig({ cwd });
  const info = requireRepo(cwd);
  const root = stationRoot(cwd, cfg);
  fs.mkdirSync(root, { recursive: true });

  const taken = new Set(listStations(cwd, cfg).map((w) => w.index));
  const plans: LaunchPlan[] = [];
  let index = 1;
  for (let created = 0; created < count; index++) {
    if (taken.has(index)) continue;
    const id = `station-${index}`;
    const dir = path.join(root, id);
    const branch = stationBranch(index);
    const base = cfg.stations.baseBranch ?? "HEAD";
    if (branchExists(info.repoRoot, branch)) {
      // left over from a prior rm that kept the branch — reuse it
      git(info.repoRoot, ["worktree", "add", dir, branch]);
    } else {
      git(info.repoRoot, ["worktree", "add", "-b", branch, dir, base]);
    }
    const model = cfg.stations.overrides[id] ?? cfg.stations.model;
    // Seed BEFORE spawning: a station that comes up without a permission
    // allowlist stalls on a prompt before it can read its own files. See
    // seed-permissions.ts for what that cost us once already.
    seedStationPermissions(dir);
    const res = launch({ id, dir, model }, cfg.stations.launcher, opts?.env);
    plans.push({
      id,
      dir,
      branch,
      model,
      command: launchCommand({ id, dir, model }),
      launcher: res.launcher,
      launched: res.launched,
    });
    created++;
  }
  return plans;
}

/**
 * Retire a station: stop its session (best-effort), remove the managed worktree
 * and its ephemeral branch. Idempotent — removing an absent station is a no-op.
 */
export function removeStation(
  id: string,
  opts?: { cwd?: string; config?: HandsConfig; force?: boolean },
): { id: string; removed: boolean } {
  const cwd = opts?.cwd ?? process.cwd();
  const cfg = opts?.config ?? loadConfig({ cwd });
  const m = id.match(/^station-(\d+)$/);
  if (!m) throw new ProvisionError(`not a station id: ${id} (expected station-<n>)`);
  const index = Number.parseInt(m[1]!, 10);
  const info = requireRepo(cwd);
  const root = stationRoot(cwd, cfg);
  const dir = path.join(root, `station-${index}`);

  // Stop the session's wake Monitor (the station skill's tail); killing the
  // tail ends the watch. The pane/session itself is the human's to close —
  // we never kill a whole terminal that might hold other work.
  try {
    execFileSync("pkill", ["-f", `tail -F -n0 .*station-${index}\\.notify`], { stdio: "ignore", timeout: 5000 });
  } catch {
    // no tail running — fine
  }
  // A tmux session we created ourselves is ours to kill.
  try {
    execFileSync("tmux", ["kill-session", "-t", `hands-station-${index}`], { stdio: "ignore", timeout: 5000 });
  } catch {
    // not tmux-launched / already gone — fine
  }

  let removed = false;
  if (fs.existsSync(dir)) {
    const args = ["worktree", "remove", dir];
    if (opts?.force) args.splice(2, 0, "--force");
    try {
      git(info.repoRoot, args);
    } catch (err) {
      throw new ProvisionError(
        `could not remove ${id}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)} ` +
          "(uncommitted work? re-run with --force to discard it)",
      );
    }
    removed = true;
  }
  git(info.repoRoot, ["worktree", "prune"]);
  const branch = stationBranch(index);
  if (branchExists(info.repoRoot, branch)) {
    try {
      git(info.repoRoot, ["branch", "-D", branch]);
    } catch {
      // branch checked out elsewhere or protected — leave it
    }
  }
  return { id: `station-${index}`, removed };
}

/** Reconcile the pool to exactly `target` stations (adds low free indices, retires the highest first). */
export function scaleStations(
  target: number,
  opts?: { cwd?: string; config?: HandsConfig; env?: NodeJS.ProcessEnv; force?: boolean },
): { added: LaunchPlan[]; removed: string[] } {
  if (!Number.isInteger(target) || target < 0) throw new ProvisionError(`bad target: ${target}`);
  const cwd = opts?.cwd ?? process.cwd();
  const cfg = opts?.config ?? loadConfig({ cwd });
  const current = listStations(cwd, cfg);
  if (current.length < target) {
    return { added: addStations(target - current.length, { cwd, config: cfg, env: opts?.env }), removed: [] };
  }
  const removed: string[] = [];
  for (const w of current.slice(target)) {
    removeStation(w.id, { cwd, config: cfg, force: opts?.force });
    removed.push(w.id);
  }
  return { added: [], removed };
}
