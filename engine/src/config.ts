import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { repoInfo } from "./paths.js";
import { readCredentials } from "./credentials.js";

/**
 * hands configuration. Layered lowest→highest precedence:
 *   built-in defaults  ←  login-derived (hands login)  ←  ~/.claude/hands.config.json (user)  ←  <repoRoot>/hands.config.json (repo)
 *
 * Everything is optional in the files; the merged result is always fully
 * populated. The repo file is the natural home — it travels with the project —
 * while the user file covers machine-wide preferences (e.g. principal name).
 * The login layer sits BELOW both — see the #26/#32 plan §3 — so it only
 * ever fills a gap neither config file already set; a hand-edited
 * `remote.url` always wins, and a user who has never run `hands login`
 * gets byte-identical behavior to before this layer existed (see
 * config.test.ts's "behavior-neutral when logged out" case).
 */
export interface HandsConfig {
  /** The human decider the expo escalates to. */
  principal: { name: string };
  /** strict-hub: server rejects station↔station + station broadcast. open: today's free-for-all. */
  topology: "strict-hub" | "open";
  /** basename: force a specific directory basename to be the expo (null = main-worktree autodetect). */
  expo: { basename: string | null };
  stations: {
    /** default model tier for provisioned stations */
    model: string;
    /** per-station tier overrides, keyed by canonical id ("station-4": "opus") */
    overrides: Record<string, string>;
    /** terminal launcher for provisioned stations */
    launcher: "auto" | "tmux" | "iterm" | "manual";
    /** where managed station worktrees live (null = ~/.hands/worktrees/<slug>) */
    worktreeRoot: string | null;
    /** branch new station worktrees fork from (null = repo default branch) */
    baseBranch: string | null;
    /** may the expo open/close stations itself (launches local processes) */
    allowScaling: boolean;
  };
  /**
   * Durable remote journal (opt-in). When `url` is set, every state-changing
   * bus action is appended to an NDJSON event log inside a git clone of that
   * repo and pushed on the Stop-hook cadence — so the coordination state
   * (tasks, questions, todos, priorities, history) survives machine restarts
   * and moves. Multiplayer is the same mechanism with a shared repo: each
   * fleet writes only under its own `handle` namespace, so writers never
   * conflict. The remote holds message bodies in PLAINTEXT — use a private
   * repo and keep the no-secrets rule absolute.
   */
  remote: {
    /** git URL of the journal repo (null = journaling disabled) */
    url: string | null;
    /** this fleet's namespace in the journal (null = OS username) */
    handle: string | null;
    /**
     * project key inside the journal (null = derived from the project repo's
     * origin as `owner--repo`, else the dir basename). Set explicitly for
     * origin-less repos that sync across machines, or to disambiguate GitLab
     * subgroup collisions.
     */
    project: string | null;
  };
  /** Review/merge authority the principal has delegated to the expo. */
  merge: {
    /**
     * true = the expo may admin-merge LOW-RISK station PRs itself (green or
     * blocked only by a known-flaky non-required check; never compliance gates
     * or risky diffs). false = it always escalates the merge click.
     */
    adminMergeLowRisk: boolean;
  };
  gh: { poll: boolean };
}

export const DEFAULT_CONFIG: HandsConfig = {
  principal: { name: "Michael" },
  topology: "strict-hub",
  expo: { basename: null },
  stations: {
    model: "sonnet",
    overrides: {},
    launcher: "auto",
    worktreeRoot: null,
    baseBranch: null,
    allowScaling: true,
  },
  remote: { url: null, handle: null, project: null },
  merge: { adminMergeLowRisk: false },
  gh: { poll: true },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function readJson(file: string): DeepPartial<HandsConfig> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as DeepPartial<HandsConfig>) : null;
  } catch (err) {
    // A malformed config should be loud (silently falling back to defaults
    // would mask a typo'd topology/principal), but must not kill the server.
    process.stderr.write(`[hands] ignoring malformed config ${file}: ${String(err)}\n`);
    return null;
  }
}

function merge(base: HandsConfig, layer: DeepPartial<HandsConfig> | null): HandsConfig {
  if (!layer) return base;
  const expoLayer = layer.expo;
  const stationsLayer = layer.stations;
  const overrides: Record<string, string> = { ...base.stations.overrides };
  for (const [key, value] of Object.entries(stationsLayer?.overrides ?? {})) {
    if (typeof value === "string") overrides[key] = value;
  }
  return {
    principal: { name: layer.principal?.name ?? base.principal.name },
    topology: layer.topology === "open" || layer.topology === "strict-hub" ? layer.topology : base.topology,
    expo: {
      basename: expoLayer?.basename !== undefined ? expoLayer.basename : base.expo.basename,
    },
    stations: {
      model: stationsLayer?.model ?? base.stations.model,
      overrides,
      launcher: stationsLayer?.launcher ?? base.stations.launcher,
      worktreeRoot:
        stationsLayer?.worktreeRoot !== undefined ? stationsLayer.worktreeRoot : base.stations.worktreeRoot,
      baseBranch:
        stationsLayer?.baseBranch !== undefined ? stationsLayer.baseBranch : base.stations.baseBranch,
      allowScaling: stationsLayer?.allowScaling ?? base.stations.allowScaling,
    },
    remote: {
      url: layer.remote?.url !== undefined ? layer.remote.url : base.remote.url,
      handle: layer.remote?.handle !== undefined ? layer.remote.handle : base.remote.handle,
      project: layer.remote?.project !== undefined ? layer.remote.project : base.remote.project,
    },
    merge: { adminMergeLowRisk: layer.merge?.adminMergeLowRisk ?? base.merge.adminMergeLowRisk },
    gh: { poll: layer.gh?.poll ?? base.gh.poll },
  };
}

export const CONFIG_BASENAME = "hands.config.json";

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HANDS_TEST_HOME?.trim() || os.homedir();
  return path.join(home, ".claude", CONFIG_BASENAME);
}

/**
 * A test that WANTS repo-config layering exercised (paths.test.ts, and
 * mcp-install.test.ts's resolveBooksTarget) creates its own fully-isolated
 * fixture repo (a fresh `git init`'d temp dir, `cwd` pointing AT it) and
 * expects that repo's own committed hands.config.json to be found — same
 * general shape (HANDS_HOME set, repoInfo resolving somewhere) as the buggy
 * case below, so neither "HANDS_HOME is set" nor "repoRoot != cwd" can tell
 * the two apart structurally. Needs an explicit, narrowly-scoped opt-out
 * instead: HANDS_NO_REPO_CONFIG, set ONLY by tests that don't create their
 * own fixture repo and would otherwise silently inherit whatever REAL repo
 * the test process happens to be running from — in a worktree of a
 * dogfooded checkout (this repo included) that's the MAIN checkout's real
 * hands.config.json via `--git-common-dir`, bleeding real remote.url/handle
 * into a test that never intended to exercise the repo-config layer at all.
 */
export function repoConfigPath(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.HANDS_NO_REPO_CONFIG?.trim()) return null;
  const info = repoInfo(cwd);
  return info ? path.join(info.repoRoot, CONFIG_BASENAME) : null;
}

/**
 * The `hands login` layer — fills remote.url/handle from the CLI's local
 * credential store (~/.hands/credentials.json) when a login happened AND it
 * resolved a cloud books repo, so `hands books <url>` was never required to
 * try the product. Never touches anything the user/repo config already set
 * (see `merge`'s precedence) and returns null (no-op) whenever there's no
 * credentials file or no cloudBooksUrl on it — the common case for every
 * user who has never run `hands login`.
 */
function readLoginDerivedLayer(env: NodeJS.ProcessEnv): DeepPartial<HandsConfig> | null {
  const creds = readCredentials(env);
  if (!creds?.cloudBooksUrl) return null;
  const url = creds.cloudBooksUrl.endsWith(".git") ? creds.cloudBooksUrl : `${creds.cloudBooksUrl}.git`;
  return { remote: { url, handle: creds.githubLogin, project: null } };
}

/**
 * Load the merged config for a working directory. Cheap (three small file
 * reads) but cached per cwd anyway, since the server calls it on every tool
 * build.
 */
const cache = new Map<string, HandsConfig>();

export function loadConfig(options?: { cwd?: string; env?: NodeJS.ProcessEnv }): HandsConfig {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const key = `${cwd} ${env.HANDS_TEST_HOME ?? ""} ${env.HANDS_NO_REPO_CONFIG ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let cfg = merge(DEFAULT_CONFIG, readLoginDerivedLayer(env));
  cfg = merge(cfg, readJson(userConfigPath(env)));
  const repoFile = repoConfigPath(cwd, env);
  if (repoFile) cfg = merge(cfg, readJson(repoFile));
  cache.set(key, cfg);
  return cfg;
}

/** Test hook: drop the per-cwd config cache. */
export function resetConfigCache(): void {
  cache.clear();
}
