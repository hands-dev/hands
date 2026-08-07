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
    /** default model tier for provisioned stations (null = inherit the principal's own default) */
    model: string | null;
    /** per-station tier overrides, keyed by canonical id ("station-4": "opus") */
    overrides: Record<string, string>;
    /** where managed station worktrees live (null = ~/.hands/worktrees/<slug>) */
    worktreeRoot: string | null;
    /** branch new station worktrees fork from (null = repo default branch) */
    baseBranch: string | null;
    /** may the expo open/close stations itself (launches local processes) */
    allowScaling: boolean;
    /**
     * Assign each provisioned station a deterministic theme colour
     * (~/.claude/themes/<slug>-station-<n>.json, selected via the worktree's
     * `.claude/settings.local.json`) and a session name (hands#104). Default
     * true because the point is that it should just work; set false to opt
     * out entirely — e.g. for someone who already hand-rolls their own
     * per-station theme files and doesn't want hands writing over them.
     */
    theming: boolean;
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
  /**
   * Crafts (hands#81/#96/#49): named, portable specializations dispatched as
   * sub-agents. Personal-tier crafts need no config (they resolve under the
   * books/coordination dir exactly as before); this only configures the
   * SHARED tier, which is plain repo content.
   */
  crafts: {
    /** repo-relative dir for shared crafts (null = ".hands/crafts") */
    sharedDir: string | null;
  };
  /**
   * A global economy dial (`hands usage low|normal`, `/hands:low-usage`/`/hands:normal-usage`).
   * "low" tells the expo/stations to raise the bar on sub-agent fan-out, shift review depth down
   * one notch (never past the irreversible-action gates), and lean tickets toward the cheaper
   * model tier — see plugin/skills/expo/SKILL.md's "Usage mode" section for the actual judgment.
   * This field is normally only ever set in the USER layer (~/.claude/hands.config.json, via
   * `hands usage`), which is why it's global by construction — but a repo can still commit its
   * own `usage.mode` to override that for everyone working in it, same as any other field.
   */
  usage: { mode: "low" | "normal" };
  /** Review/merge authority the principal has delegated to the expo. */
  /** Dispatch policy — what the expo is allowed to fire a ticket at. */
  dispatch: {
    /**
     * true (default) = hands_delegate REFUSES a station with no current
     * attestation (hands#157). A ticket is only as good as the picture behind
     * it, and a station carrying leftovers from a previous shift produces work
     * against stale code. Enforced server-side rather than in prose: prose asks
     * a model to comply, the server makes it true.
     *
     * `force: true` on the call overrides for a single ticket. Setting this to
     * false disables the gate entirely — reasonable while a kitchen is
     * migrating, since every station is unattested on first deploy.
     */
    requireAttestation: boolean;
  };
  merge: {
    /**
     * true = the expo may admin-merge LOW-RISK station PRs itself (green or
     * blocked only by a known-flaky non-required check; never compliance gates
     * or risky diffs). false = it always escalates the merge click.
     */
    adminMergeLowRisk: boolean;
  };
  gh: { poll: boolean };
  /**
   * The sous chef (hands#87/#171) — composes tickets, is the expo's
   * escalation hop, signs off ticket completeness, and stewards crafts.
   * Off by default: a kitchen with no sous session running shouldn't have
   * `hands_escalate` waking an identity nobody's listening as. Flip on once
   * a sous pane actually exists for this repo.
   */
  sous: { enabled: boolean };
}

export const DEFAULT_CONFIG: HandsConfig = {
  principal: { name: "Michael" },
  topology: "strict-hub",
  expo: { basename: null },
  stations: {
    model: null,
    overrides: {},
    worktreeRoot: null,
    baseBranch: null,
    allowScaling: true,
    theming: true,
  },
  remote: { url: null, handle: null, project: null },
  crafts: { sharedDir: null },
  usage: { mode: "normal" },
  dispatch: { requireAttestation: true },
  merge: { adminMergeLowRisk: false },
  gh: { poll: true },
  sous: { enabled: false },
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
      model: stationsLayer?.model !== undefined ? stationsLayer.model : base.stations.model,
      overrides,
      worktreeRoot:
        stationsLayer?.worktreeRoot !== undefined ? stationsLayer.worktreeRoot : base.stations.worktreeRoot,
      baseBranch:
        stationsLayer?.baseBranch !== undefined ? stationsLayer.baseBranch : base.stations.baseBranch,
      allowScaling: stationsLayer?.allowScaling ?? base.stations.allowScaling,
      theming: stationsLayer?.theming ?? base.stations.theming,
    },
    remote: {
      url: layer.remote?.url !== undefined ? layer.remote.url : base.remote.url,
      handle: layer.remote?.handle !== undefined ? layer.remote.handle : base.remote.handle,
      project: layer.remote?.project !== undefined ? layer.remote.project : base.remote.project,
    },
    crafts: {
      sharedDir: layer.crafts?.sharedDir !== undefined ? layer.crafts.sharedDir : base.crafts.sharedDir,
    },
    usage: {
      mode: layer.usage?.mode === "low" || layer.usage?.mode === "normal" ? layer.usage.mode : base.usage.mode,
    },
    dispatch: {
      requireAttestation:
        layer.dispatch?.requireAttestation ?? base.dispatch.requireAttestation,
    },
    merge: { adminMergeLowRisk: layer.merge?.adminMergeLowRisk ?? base.merge.adminMergeLowRisk },
    gh: { poll: layer.gh?.poll ?? base.gh.poll },
    sous: { enabled: layer.sous?.enabled ?? base.sous.enabled },
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

/**
 * Fresh, UNCACHED read of just `usage.mode` — deliberately bypasses
 * `loadConfig()`'s per-process cache. Everything else in `hands.config.json`
 * is cold setup config, fine to cache for a session's lifetime; `usage.mode`
 * is a hot toggle (`hands usage low|normal`, `/hands:low-usage`) meant to
 * reach an already-running expo/station pane on its very next `hands_board`
 * poll — if this went through the cached `loadConfig()` instead, a
 * long-lived MCP server process would freeze the mode at whatever it was
 * when the connection started and never see a later toggle. Same
 * repo-overrides-user precedence as `loadConfig()`, just for this one field.
 */
export function currentUsageMode(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): HandsConfig["usage"]["mode"] {
  const repoFile = repoConfigPath(cwd, env);
  const repoMode = repoFile ? readJson(repoFile)?.usage?.mode : undefined;
  if (repoMode === "low" || repoMode === "normal") return repoMode;
  const userMode = readJson(userConfigPath(env))?.usage?.mode;
  if (userMode === "low" || userMode === "normal") return userMode;
  return DEFAULT_CONFIG.usage.mode;
}
