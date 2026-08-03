import * as path from "node:path";
import { repoInfo } from "./paths.js";

/**
 * Agent identity — two canonical roles (kitchen-brigade vocabulary), no
 * persona layer:
 *   `expo`          the repo's main checkout — the expeditor at the pass:
 *                   all the context, none of the cooking
 *   `station-<n>`   a provisioned station (hosted in a managed worktree — a
 *                   hidden isolation detail, never surfaced in addressing)
 *
 * The canonical id is the routing key everywhere: DB `from_id`/`to_id`, read
 * cursors, notify targets. Anything else (the principal's name, a stray dir
 * basename) passes through as-is.
 *
 * Legacy ids from the pre-brigade era (`foreman`, `worker-<n>`) are accepted
 * as aliases so existing buses, journals, and habits keep routing.
 */

const STATION_ID = /^(?:station|worker)-(\d+)$/;

/** True for a canonical station id (`station-1`, …; legacy `worker-<n>` accepted). */
export function isStation(id: string): boolean {
  return STATION_ID.test(id);
}

export function isExpo(id: string): boolean {
  return id === "expo" || id === "foreman"; // legacy alias
}

/** @deprecated legacy name — use isStation */
export const isWorker = isStation;
/** @deprecated legacy name — use isExpo */
export const isForeman = isExpo;

/**
 * Resolve a recipient ref to the canonical routing id: trims, preserves `"*"`
 * (broadcast), and canonicalizes legacy role names (`foreman` → `expo`,
 * `worker-3` → `station-3`) so old messages, configs, and muscle memory still
 * land.
 */
export function resolveAgentRef(nameOrId: string): string {
  const raw = nameOrId.trim();
  if (raw === "foreman") return "expo";
  const legacyStation = raw.match(/^worker-(\d+)$/);
  if (legacyStation) return `station-${legacyStation[1]}`;
  return raw;
}

/**
 * Parse a station index from a directory basename. Matches the managed
 * `station-<n>` dirs the provisioner creates, plus the legacy `worker-<n>` /
 * `…worktree-<n>` / `…-wt<n>` conventions — NOT a bare trailing number, so a
 * branch-named worktree like `fix-eng-642` never resolves to a bogus index.
 * Returns null for anything else (e.g. a main checkout).
 */
export function indexFromDirName(dir: string): number | null {
  const base = path.basename(dir);
  const match = base.match(/(?:^station-|^worker-|worktree-|-wt)(\d+)$/i);
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Read an explicit agent id from `--agent-id <name>` / `--agent-id=<name>` in
 * the given argv (defaults to `process.argv`). Returns null when absent.
 */
export function agentIdFromArgv(argv: readonly string[] = process.argv): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--agent-id") {
      const next = argv[i + 1];
      return next && !next.startsWith("--") ? next : null;
    }
    if (arg.startsWith("--agent-id=")) {
      return arg.slice("--agent-id=".length) || null;
    }
  }
  return null;
}

/**
 * Resolve this instance's agent id. Precedence:
 *   1. `AGENT_BUS_ID` env var — what the provisioner sets on managed stations
 *      (legacy role names canonicalize)
 *   2. `--agent-id <name>` launch arg
 *   3. expo-basename override — `AGENT_BUS_FOREMAN_BASENAME` env, or the
 *      `expo.basename` config passed by the caller
 *   4. main-worktree autodetect: cwd inside a repo's MAIN worktree → `expo`
 *      (this is what gives every repo its own expo, regardless of name)
 *   5. `station-<n>` derived from the cwd basename (managed station dirs and
 *      the legacy `worker-n` / `…worktree-n` / `…-wtn` conventions)
 *   6. the cwd basename itself (stray dirs)
 *
 * The MCP registration is shared machine-wide, so the id must be derived at
 * runtime from env + cwd — never a static launch arg baked into shared config.
 */
export function resolveAgentId(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  /** config `expo.basename` (env AGENT_BUS_FOREMAN_BASENAME still wins) */
  foremanBasename?: string | null;
}): string {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const argv = options?.argv ?? process.argv;

  const fromEnv = env.AGENT_BUS_ID?.trim();
  if (fromEnv) return resolveAgentRef(fromEnv);

  const fromArg = agentIdFromArgv(argv)?.trim();
  if (fromArg) return resolveAgentRef(fromArg);

  const base = path.basename(cwd);
  const expoBasename = env.AGENT_BUS_FOREMAN_BASENAME?.trim() || options?.foremanBasename;
  if (expoBasename && base === expoBasename) return "expo";

  if (repoInfo(cwd)?.isMainWorktree) return "expo";

  const index = indexFromDirName(cwd);
  if (index !== null) return `station-${index}`;

  return base;
}
