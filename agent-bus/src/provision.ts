import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentBusConfig, loadConfig } from "./config.js";
import { type RepoInfo, repoInfo } from "./paths.js";

/**
 * Station provisioning — the user thinks in STATIONS, never worktrees. Each
 * station is a Claude Code session launched with AGENT_BUS_ID=station-<n>
 * inside a managed git worktree (the hidden isolation primitive) under
 * `~/.agent-bus/worktrees/<slug>/station-<n>`. That root lives OUTSIDE the
 * repo tree so nested-repo tooling never sees it, and the worktree shares the
 * repo's git common-dir, so every station automatically lands on the expo's
 * bus. Legacy `worker-<n>` dirs/branches from the pre-brigade era are listed
 * and retired transparently.
 */

export interface ManagedWorker {
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

/** Where this repo's managed worker worktrees live. */
export function workerRoot(cwd: string = process.cwd(), config?: AgentBusConfig): string {
  const cfg = config ?? loadConfig({ cwd });
  if (cfg.stations.worktreeRoot) return cfg.stations.worktreeRoot;
  return path.join(os.homedir(), ".agent-bus", "worktrees", requireRepo(cwd).slug);
}

export function workerBranch(index: number): string {
  return `yc/station-${index}`;
}

/** Pre-brigade branch name — still recognized for teardown. */
function legacyBranch(index: number): string {
  return `agent-bus/worker-${index}`;
}

/** List managed workers (worker-<n> dirs under the worker root). */
export function listWorkers(cwd: string = process.cwd(), config?: AgentBusConfig): ManagedWorker[] {
  const root = workerRoot(cwd, config);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const workers: ManagedWorker[] = [];
  for (const name of names) {
    const m = name.match(/^(?:station|worker)-(\d+)$/);
    if (!m) continue;
    const index = Number.parseInt(m[1]!, 10);
    workers.push({
      id: `station-${index}`,
      index,
      dir: path.join(root, name), // legacy worker-<n> dirs keep their path
      branch: workerBranch(index),
      present: true,
    });
  }
  return workers.sort((a, b) => a.index - b.index);
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Compose the paste-able launch command for a station (plugin-namespaced skill). */
export function launchCommand(worker: { id: string; dir: string; model: string }): string {
  return `cd ${shellQuote(worker.dir)} && AGENT_BUS_ID=${worker.id} claude --model ${shellQuote(worker.model)} ${shellQuote("/loop /yc:station")}`;
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
 * Start a worker session via the configured launcher. Returns the effective
 * launcher + whether a session was actually spawned. `manual` never spawns —
 * it's the zero-assumption fallback where the human pastes the command.
 */
function launch(
  plan: { id: string; dir: string; model: string },
  launcher: AgentBusConfig["stations"]["launcher"],
  env: NodeJS.ProcessEnv = process.env,
): { launcher: "tmux" | "iterm" | "manual"; launched: boolean } {
  const command = launchCommand(plan);
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
        // no session → dedicated detached session per worker (idempotent-ish:
        // a duplicate session name fails, which we surface)
        execFileSync(
          "tmux",
          ["new-session", "-d", "-s", `agent-bus-${plan.id}`, command],
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
 * Provision the next N workers: create each managed worktree (branch
 * `agent-bus/worker-<n>` off the configured base) and launch its session.
 * The worktree is never surfaced to the user — only the worker id is.
 */
export function addWorkers(
  count: number,
  opts?: { cwd?: string; config?: AgentBusConfig; env?: NodeJS.ProcessEnv },
): LaunchPlan[] {
  const cwd = opts?.cwd ?? process.cwd();
  const cfg = opts?.config ?? loadConfig({ cwd });
  const info = requireRepo(cwd);
  const root = workerRoot(cwd, cfg);
  fs.mkdirSync(root, { recursive: true });

  const taken = new Set(listWorkers(cwd, cfg).map((w) => w.index));
  const plans: LaunchPlan[] = [];
  let index = 1;
  for (let created = 0; created < count; index++) {
    if (taken.has(index)) continue;
    const id = `station-${index}`;
    const dir = path.join(root, id);
    const branch = workerBranch(index);
    const base = cfg.stations.baseBranch ?? "HEAD";
    if (branchExists(info.repoRoot, branch)) {
      // left over from a prior rm that kept the branch — reuse it
      git(info.repoRoot, ["worktree", "add", dir, branch]);
    } else {
      git(info.repoRoot, ["worktree", "add", "-b", branch, dir, base]);
    }
    const model =
      cfg.stations.overrides[id] ?? cfg.stations.overrides[`worker-${index}`] ?? cfg.stations.model;
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
 * Retire a worker: stop its session (best-effort), remove the managed worktree
 * and its ephemeral branch. Idempotent — removing an absent worker is a no-op.
 */
export function removeWorker(
  id: string,
  opts?: { cwd?: string; config?: AgentBusConfig; force?: boolean },
): { id: string; removed: boolean } {
  const cwd = opts?.cwd ?? process.cwd();
  const cfg = opts?.config ?? loadConfig({ cwd });
  const m = id.match(/^(?:station|worker)-(\d+)$/);
  if (!m) throw new ProvisionError(`not a station id: ${id} (expected station-<n>)`);
  const index = Number.parseInt(m[1]!, 10);
  const info = requireRepo(cwd);
  const root = workerRoot(cwd, cfg);
  // canonical dir first, then the legacy worker-<n> location
  const candidates = [path.join(root, `station-${index}`), path.join(root, `worker-${index}`)];
  const dir = candidates.find((d) => fs.existsSync(d)) ?? candidates[0]!;

  // Stop the session's wake Monitor (the worker skill's tail); killing the
  // tail ends the watch. The pane/session itself is the human's to close —
  // we never kill a whole terminal that might hold other work.
  for (const alias of [`station-${index}`, `worker-${index}`]) {
    try {
      execFileSync("pkill", ["-f", `tail -F -n0 .*${alias}\\.notify`], { stdio: "ignore", timeout: 5000 });
    } catch {
      // no tail running — fine
    }
    // A tmux session we created ourselves is ours to kill.
    try {
      execFileSync("tmux", ["kill-session", "-t", `agent-bus-${alias}`], { stdio: "ignore", timeout: 5000 });
    } catch {
      // not tmux-launched / already gone — fine
    }
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
  for (const branch of [workerBranch(index), legacyBranch(index)]) {
    if (branchExists(info.repoRoot, branch)) {
      try {
        git(info.repoRoot, ["branch", "-D", branch]);
      } catch {
        // branch checked out elsewhere or protected — leave it
      }
    }
  }
  return { id: `station-${index}`, removed };
}

/** Reconcile the pool to exactly `target` workers (adds low free indices, retires the highest first). */
export function scaleWorkers(
  target: number,
  opts?: { cwd?: string; config?: AgentBusConfig; env?: NodeJS.ProcessEnv; force?: boolean },
): { added: LaunchPlan[]; removed: string[] } {
  if (!Number.isInteger(target) || target < 0) throw new ProvisionError(`bad target: ${target}`);
  const cwd = opts?.cwd ?? process.cwd();
  const cfg = opts?.config ?? loadConfig({ cwd });
  const current = listWorkers(cwd, cfg);
  if (current.length < target) {
    return { added: addWorkers(target - current.length, { cwd, config: cfg, env: opts?.env }), removed: [] };
  }
  const removed: string[] = [];
  for (const w of current.slice(target)) {
    removeWorker(w.id, { cwd, config: cfg, force: opts?.force });
    removed.push(w.id);
  }
  return { added: [], removed };
}
