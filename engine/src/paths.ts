import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RepoInfo {
  /** absolute path of the repo's main checkout (parent of the shared .git dir) */
  repoRoot: string;
  /** true when cwd is inside the MAIN worktree (not a linked `git worktree add`) */
  isMainWorktree: boolean;
  /** coordination-dir slug: `<basename>-<shortHash(repoRoot)>` */
  slug: string;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

function realpathBestEffort(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

const repoInfoCache = new Map<string, RepoInfo | null>();

/**
 * Introspect the git repo containing `cwd` (cached per cwd; one repo resolves
 * identically from every worktree).
 *
 * `--git-common-dir` is SHARED by all worktrees of a repo (the main `.git`),
 * while `--git-dir` is per-worktree (`.git/worktrees/<name>` when linked). Both
 * may print relative paths, so resolve them against cwd before comparing:
 * equal ⇒ cwd is the main worktree. Returns null outside any git repo (or when
 * git itself is unavailable).
 */
export function repoInfo(cwd: string = process.cwd()): RepoInfo | null {
  const cached = repoInfoCache.get(cwd);
  if (cached !== undefined) return cached;

  let info: RepoInfo | null = null;
  const rawCommon = git(cwd, ["rev-parse", "--git-common-dir"]);
  const rawGitDir = git(cwd, ["rev-parse", "--git-dir"]);
  if (rawCommon && rawGitDir) {
    // realpath so macOS symlinks (/tmp → /private/tmp) can't split one repo
    // into two slugs depending on how the path was spelled.
    const commonDir = realpathBestEffort(path.resolve(cwd, rawCommon));
    const gitDir = realpathBestEffort(path.resolve(cwd, rawGitDir));
    const repoRoot = path.dirname(commonDir);
    const hash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 8);
    info = {
      repoRoot,
      isMainWorktree: gitDir === commonDir,
      slug: `${path.basename(repoRoot)}-${hash}`,
    };
  }
  repoInfoCache.set(cwd, info);
  return info;
}

/** Test hook: drop the per-cwd repo cache. */
export function resetRepoInfoCache(): void {
  repoInfoCache.clear();
}

/**
 * Root for this repo's yes-chef state — auto-scoped per git repo so two
 * projects on one machine never share a bus:
 *   1. `YES_CHEF_HOME` set → returned verbatim (explicit override; tests use it).
 *   2. cwd inside a git repo → `~/.claude/coordination/<basename>-<hash>` — the
 *      slug derives from the shared git common-dir, so every worktree of a repo
 *      lands on the SAME dir while a different repo gets its own.
 *   3. otherwise → `~/.claude/coordination/_global` (stray non-git dirs).
 */
export function coordinationDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const override = env.YES_CHEF_HOME?.trim();
  if (override) return override;
  const info = repoInfo(cwd);
  return path.join(os.homedir(), ".claude", "coordination", info?.slug ?? "_global");
}

export function dbPath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return path.join(coordinationDir(env, cwd), "yes-chef.db");
}

export function notifyPath(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  return path.join(coordinationDir(env, cwd), `${agentId}.notify`);
}
