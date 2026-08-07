import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type HandsConfig, loadConfig } from "./config.js";
import { materializeCraftAgents } from "./crafts.js";
import { type RepoInfo, repoInfo } from "./paths.js";
import {
  mergeStationSettings,
  SEEDED_RELPATH,
  seedStationPermissions,
  unseedStationPermissions,
} from "./seed-permissions.js";
import { assignStationTheme, themeFileContents, themeFilePath } from "./theming.js";

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
  /** how it was (or wasn't) started: exec (this terminal) | manual (paste it) */
  launcher: "exec" | "manual";
  launched: boolean;
  /**
   * hands#104 theming — undefined when `stations.theming` is off. `themeColor`
   * is the palette hex assigned deterministically by station index;
   * `sessionName` is the hands-owned display label (same string used as the
   * theme file's own "name" and, once persisted, the DB's session_name).
   */
  themeColor?: string;
  sessionName?: string;
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

/**
 * True when the ONLY thing making this worktree dirty is the permission
 * scaffolding hands itself seeded. Deliberately conservative: any other
 * modified or untracked path (real work) returns false, so `station rm` still
 * refuses without --force. An unreadable status also returns false — if we
 * can't prove the tree is clean of user work, we don't touch it.
 */
function onlyDirtInWorktreeIsOurs(dir: string): boolean {
  let status: string;
  try {
    status = git(dir, ["status", "--porcelain", "--untracked-files=all"]);
  } catch {
    return false;
  }
  const paths = status
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  if (paths.length === 0) return false; // already clean — nothing to clear
  return paths.every((p) => p === SEEDED_RELPATH);
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
/** The skill loop a session comes up in, shared by the exec and paste paths. */
export function launchSkill(mode: LaunchMode): string {
  return mode === "expo" ? "/loop /hands:expo" : "/loop /hands:station";
}

export function launchCommand(
  target: { id: string; dir: string; model?: string },
  mode: LaunchMode = "station",
): string {
  const skill = launchSkill(mode);
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

/**
 * Start a station session. Returns how it was (or wasn't) started.
 *
 * `exec` hands THIS terminal to the session: `claude` replaces the foreground,
 * stdio inherited, blocking until it exits. That is the only way a session is
 * spawned — hands does not own a terminal multiplexer. A station's durability
 * comes from state that outlives its process (the bus DB, the worktree, the
 * resumable transcript), never from the pane it happens to be running in;
 * parenting sessions to panes is what made a pane's death look like a station's.
 *
 * `manual` prints the command for the human to paste, and is the honest answer
 * wherever exec-in-place is impossible: opening N seats at once (one terminal
 * cannot host them all), a non-interactive stdin, or the MCP path, which has no
 * terminal at all.
 */
export function launch(
  plan: { id: string; dir: string; model?: string },
  env: NodeJS.ProcessEnv = process.env,
  launchMode: LaunchMode = "station",
  opts?: { exec?: boolean },
): { launcher: "exec" | "manual"; launched: boolean; exitCode?: number } {
  if (!opts?.exec || !process.stdin.isTTY) return { launcher: "manual", launched: false };

  const args = [...(plan.model ? ["--model", plan.model] : []), launchSkill(launchMode)];
  const res = spawnSync("claude", args, {
    cwd: plan.dir,
    stdio: "inherit",
    env: { ...env, HANDS_ID: plan.id },
  });
  return { launcher: "exec", launched: true, exitCode: res.status ?? 1 };
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

    // hands#104: deterministic-by-index theme + hands-owned session name.
    // Opt-out via stations.theming for people who already hand-roll their own
    // theme files and don't want them touched.
    let themeColor: string | undefined;
    let sessionName: string | undefined;
    if (cfg.stations.theming) {
      const assignment = assignStationTheme({
        repoLabel: path.basename(info.repoRoot),
        repoSlug: info.slug,
        index,
        env: opts?.env,
      });
      fs.mkdirSync(path.dirname(assignment.file), { recursive: true });
      fs.writeFileSync(assignment.file, `${JSON.stringify(themeFileContents(assignment), null, 2)}\n`);
      // Merge into the SAME settings.local.json seedStationPermissions just
      // wrote, without clobbering the permission allowlist already there.
      mergeStationSettings(dir, { theme: assignment.themeId });
      themeColor = assignment.color.hex;
      sessionName = assignment.sessionName;
    }

    // Materialize crafts as real, session-discoverable Agent types BEFORE the station's Claude
    // Code process launches — Skill/agentType discovery is fixed at session start, not live, so
    // this is the only point where a station can come up with one-call craft dispatch already
    // working (hands#81/#96). A craft founded/edited after this station is already running still
    // needs `hands craft brief`/`mise` until a restart re-syncs.
    materializeCraftAgents(cfg, dir, opts?.env, cwd);

    // Never exec here: `station add` can open several seats, and one terminal
    // cannot host them all. Each is reported with its paste command.
    const res = launch({ id, dir, model }, opts?.env);
    plans.push({
      id,
      dir,
      branch,
      model,
      command: launchCommand({ id, dir, model }),
      launcher: res.launcher,
      launched: res.launched,
      ...(themeColor ? { themeColor } : {}),
      ...(sessionName ? { sessionName } : {}),
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
  opts?: { cwd?: string; config?: HandsConfig; force?: boolean; env?: NodeJS.ProcessEnv },
): { id: string; removed: boolean } {
  const cwd = opts?.cwd ?? process.cwd();
  const cfg = opts?.config ?? loadConfig({ cwd });
  const m = id.match(/^station-(\d+)$/);
  if (!m) throw new ProvisionError(`not a station id: ${id} (expected station-<n>)`);
  const index = Number.parseInt(m[1]!, 10);
  const info = requireRepo(cwd);
  const root = stationRoot(cwd, cfg);
  const dir = path.join(root, `station-${index}`);

  // hands#104: clean up the theme file this station's `add` created — it
  // lives under ~/.claude/themes/, outside the worktree, so `git worktree
  // remove` below never touches it. Gated on the CURRENT theming setting: if
  // someone has opted out since this station was created, hands leaves
  // whatever's there alone rather than guessing whether it still owns it.
  if (cfg.stations.theming) {
    try {
      fs.rmSync(themeFilePath(info.slug, index, opts?.env ?? process.env), { force: true });
    } catch {
      // best-effort — a missing/unwritable theme file is not fatal to rm
    }
  }

  // Stop the session's wake Monitor (the station skill's tail); killing the
  // tail ends the watch. The pane/session itself is the human's to close —
  // we never kill a whole terminal that might hold other work.
  try {
    execFileSync("pkill", ["-f", `tail -F -n0 .*station-${index}\\.notify`], { stdio: "ignore", timeout: 5000 });
  } catch {
    // no tail running — fine
  }
  let removed = false;
  if (fs.existsSync(dir)) {
    // Our own seeded permission file makes the worktree dirty, and newer git
    // refuses to remove a dirty worktree (2.43 allows it, ubuntu-latest's does
    // not — which is exactly why this passed locally and broke CI). Clear the
    // scaffolding we put there, but ONLY when it is the sole thing dirtying the
    // tree: real uncommitted work must still block removal without --force.
    if (onlyDirtInWorktreeIsOurs(dir)) unseedStationPermissions(dir);

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
    removeStation(w.id, { cwd, config: cfg, force: opts?.force, env: opts?.env });
    removed.push(w.id);
  }
  return { added: [], removed };
}
