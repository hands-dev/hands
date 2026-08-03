import * as path from "node:path";
import { repoInfo } from "./paths.js";

/**
 * Agent identity — two canonical roles, no persona layer:
 *   `foreman`      the repo's main checkout (command center)
 *   `worker-<n>`   a provisioned worker (hosted in a managed worktree — a
 *                  hidden isolation detail, never surfaced in addressing)
 *
 * The canonical id is the routing key everywhere: DB `from_id`/`to_id`, read
 * cursors, notify targets. Anything else (the principal's name, a stray dir
 * basename) passes through as-is.
 */

const WORKER_ID = /^worker-(\d+)$/;

/** True for a canonical worker id (`worker-1`, `worker-12`, …). */
export function isWorker(id: string): boolean {
  return WORKER_ID.test(id);
}

export function isForeman(id: string): boolean {
  return id === "foreman";
}

/**
 * Resolve a recipient ref to the canonical routing id. Pure passthrough now
 * that there is no name→id roster: trims, and preserves `"*"` (broadcast).
 */
export function resolveAgentRef(nameOrId: string): string {
  return nameOrId.trim();
}

/**
 * Parse a worker index from a directory basename. Matches the managed
 * `worker-<n>` dirs the provisioner creates, plus the legacy `…worktree-<n>` /
 * `…-wt<n>` conventions — NOT a bare trailing number, so a branch-named
 * worktree like `fix-eng-642` never resolves to a bogus index. Returns null
 * for anything else (e.g. a main checkout).
 */
export function indexFromDirName(dir: string): number | null {
  const base = path.basename(dir);
  const match = base.match(/(?:^worker-|worktree-|-wt)(\d+)$/i);
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
 *   1. `AGENT_BUS_ID` env var — what the provisioner sets on managed workers
 *   2. `--agent-id <name>` launch arg
 *   3. foreman-basename override — `AGENT_BUS_FOREMAN_BASENAME` env, or the
 *      `foreman.basename` config passed by the caller
 *   4. main-worktree autodetect: cwd inside a repo's MAIN worktree → `foreman`
 *      (this is what gives every repo its own foreman, regardless of name)
 *   5. `worker-<n>` derived from the cwd basename (managed worker dirs and the
 *      legacy `…worktree-n` / `…-wtn` conventions)
 *   6. the cwd basename itself (stray dirs)
 *
 * The MCP registration is shared machine-wide, so the id must be derived at
 * runtime from env + cwd — never a static launch arg baked into shared config.
 */
export function resolveAgentId(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  /** config `foreman.basename` (env AGENT_BUS_FOREMAN_BASENAME still wins) */
  foremanBasename?: string | null;
}): string {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const argv = options?.argv ?? process.argv;

  const fromEnv = env.AGENT_BUS_ID?.trim();
  if (fromEnv) return fromEnv;

  const fromArg = agentIdFromArgv(argv)?.trim();
  if (fromArg) return fromArg;

  const base = path.basename(cwd);
  const foremanBasename = env.AGENT_BUS_FOREMAN_BASENAME?.trim() || options?.foremanBasename;
  if (foremanBasename && base === foremanBasename) return "foreman";

  if (repoInfo(cwd)?.isMainWorktree) return "foreman";

  const index = indexFromDirName(cwd);
  if (index !== null) return `worker-${index}`;

  return base;
}
