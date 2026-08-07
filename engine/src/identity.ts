import * as path from "node:path";
import { repoInfo } from "./paths.js";

/**
 * Agent identity — kitchen-brigade vocabulary, no persona layer:
 *   `expo`          the repo's main checkout — the expeditor at the pass:
 *                   all the context, none of the cooking
 *   `station-<n>`   a provisioned station (hosted in a managed worktree — a
 *                   hidden isolation detail, never surfaced in addressing)
 *   `sous`          the sous chef (hands#87/#171) — composes tickets, is the
 *                   expo's escalation hop, signs off completeness, and
 *                   stewards crafts. No cwd-based autodetection like expo/
 *                   station (there's no "sous worktree" convention) — a sous
 *                   session is always explicit: `HANDS_ID=sous` or
 *                   `--agent-id sous`, same mechanism any custom id uses.
 *
 * The canonical id is the routing key everywhere: DB `from_id`/`to_id`, read
 * cursors, notify targets. Anything else (the principal's name, a stray dir
 * basename) passes through as-is.
 */

const STATION_ID = /^station-(\d+)$/;

/** True for a canonical station id (`station-1`, …). */
export function isStation(id: string): boolean {
  return STATION_ID.test(id);
}

export function isExpo(id: string): boolean {
  return id === "expo";
}

export function isSous(id: string): boolean {
  return id === "sous";
}

/**
 * Resolve a recipient ref to the canonical routing id: trims and preserves
 * `"*"` (broadcast) and canonical ids as-is.
 */
export function resolveAgentRef(nameOrId: string): string {
  return nameOrId.trim();
}

/**
 * Parse a station index from a directory basename. Matches the managed
 * `station-<n>` dirs the provisioner creates, plus the generic
 * `…worktree-<n>` / `…-wt<n>` conventions — NOT a bare trailing number, so a
 * branch-named worktree like `fix-eng-642` never resolves to a bogus index.
 * Returns null for anything else (e.g. a main checkout).
 */
export function indexFromDirName(dir: string): number | null {
  const base = path.basename(dir);
  const match = base.match(/(?:^station-|worktree-|-wt)(\d+)$/i);
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
 *   1. `HANDS_ID` env var — what the provisioner sets on managed stations
 *   2. `--agent-id <name>` launch arg
 *   3. expo-basename override — `HANDS_EXPO_BASENAME` env, or the
 *      `expo.basename` config passed by the caller
 *   4. main-worktree autodetect: cwd inside a repo's MAIN worktree → `expo`
 *      (this is what gives every repo its own expo, regardless of name)
 *   5. `station-<n>` derived from the cwd basename (managed station dirs and
 *      the generic `…worktree-n` / `…-wtn` conventions)
 *   6. the cwd basename itself (stray dirs)
 *
 * The MCP registration is shared machine-wide, so the id must be derived at
 * runtime from env + cwd — never a static launch arg baked into shared config.
 */
export function resolveAgentId(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  /** config `expo.basename` (env HANDS_EXPO_BASENAME still wins) */
  expoBasename?: string | null;
}): string {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const argv = options?.argv ?? process.argv;

  const fromEnv = env.HANDS_ID?.trim();
  if (fromEnv) return resolveAgentRef(fromEnv);

  const fromArg = agentIdFromArgv(argv)?.trim();
  if (fromArg) return resolveAgentRef(fromArg);

  const base = path.basename(cwd);
  const expoBasename = env.HANDS_EXPO_BASENAME?.trim() || options?.expoBasename;
  if (expoBasename && base === expoBasename) return "expo";

  if (repoInfo(cwd)?.isMainWorktree) return "expo";

  const index = indexFromDirName(cwd);
  if (index !== null) return `station-${index}`;

  return base;
}
