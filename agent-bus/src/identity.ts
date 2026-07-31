import * as path from "node:path";

/**
 * Human display names for the worktree agents — a PURE PRESENTATION layer.
 *
 * The cast is The West Wing senior staff: the foreman (main checkout / command
 * center) is Leo McGarry, the Chief of Staff who runs the staff for the
 * President (Michael) — the same relationship the foreman has to Michael. The
 * numbered worktrees are the senior staff who report through Leo.
 *
 * The canonical agent id (`wt<n>`, `foreman`) remains the routing key
 * everywhere: DB `from_id`/`to_id`, read cursors, notify targets, and git
 * branches (`wt3/home`) are all keyed on it and MUST NOT change. These names
 * exist only so the human-facing output reads as real people. Ids without a
 * mapping (mobile, api, ampersand, ad-hoc) render as themselves.
 */
export const AGENT_DISPLAY_NAMES: Record<string, string> = {
  foreman: "Leo",
  wt1: "Josh",
  wt2: "Toby",
  wt3: "Sam",
  wt4: "C.J.",
  wt5: "Donna",
  wt6: "Charlie",
};

/**
 * Pronouns per agent, so the staff reference each other correctly ("C.J. posted
 * her findings", "ask Toby for his diff"). Follows the West Wing cast. Presented
 * everywhere the roster is shown (peers, board, dashboard, server instructions).
 * An unmapped id has no stated pronouns — callers fall back to they/them.
 */
export const AGENT_PRONOUNS: Record<string, string> = {
  foreman: "he/him", // Leo
  wt1: "he/him", // Josh
  wt2: "he/him", // Toby
  wt3: "he/him", // Sam
  wt4: "she/her", // C.J.
  wt5: "she/her", // Donna
  wt6: "he/him", // Charlie
};

/** Stated pronouns for an agent id, or `they/them` when none is on file. */
export function pronounsFor(id: string): string {
  return AGENT_PRONOUNS[id] ?? "they/them";
}

/** `"C.J. (wt4, she/her)"` — the full roster label used where agents meet each other. */
export function displayNameWithPronouns(id: string): string {
  const name = AGENT_DISPLAY_NAMES[id];
  return name ? `${name} (${id}, ${pronounsFor(id)})` : id;
}

/** Lowercased human name → canonical id, derived once from the forward map. */
const NAME_TO_ID: Map<string, string> = new Map(
  Object.entries(AGENT_DISPLAY_NAMES).map(([id, name]) => [name.toLowerCase(), id]),
);

/**
 * Human label for an agent id: `"Riley (wt4)"` when the id is mapped, otherwise
 * the id unchanged (`"foreman"`, `"api"`, …). Keeps the `wt<n>` visible so the
 * routing key is never hidden from a human reading the board.
 */
export function displayName(id: string): string {
  const name = AGENT_DISPLAY_NAMES[id];
  return name ? `${name} (${id})` : id;
}

/**
 * Resolve a human ref back to the canonical agent id for routing. Accepts the
 * bare name (`"Riley"`, case-insensitive), the decorated label (`"Riley (wt4)"`),
 * or the id itself (`"wt4"`). `"*"` (broadcast) and any unmapped ref pass through
 * unchanged, so `foreman`/`api`/etc. still address correctly.
 */
export function resolveAgentRef(nameOrId: string): string {
  const raw = nameOrId.trim();
  if (raw === "*" || raw === "") return raw;
  // Decorated label "Riley (wt4)" → take the parenthesised id.
  const decorated = raw.match(/\(([^)]+)\)\s*$/);
  if (decorated) return decorated[1]!.trim();
  // Bare human name (case-insensitive) → its id.
  const byName = NAME_TO_ID.get(raw.toLowerCase());
  if (byName) return byName;
  // Already an id (mapped or not) → unchanged.
  return raw;
}

/**
 * Parse a trailing worktree index from a directory basename.
 *
 * Mirrors `indexFromDirName` in `scripts/lib/worktree-ports.ts` (the source of
 * truth for worktree naming). Matches only the `…worktree-2` / `…-wt2`
 * conventions — NOT a bare trailing number — so a branch-named worktree like
 * `fix-eng-642` does not resolve to a bogus index. Returns null for the main
 * checkout (no recognized index).
 */
export function indexFromDirName(dir: string): number | null {
  const base = path.basename(dir);
  const match = base.match(/(?:worktree-|-wt)(\d+)$/i);
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
 *   1. `AGENT_BUS_ID` env var
 *   2. `--agent-id <name>` launch arg
 *   3. `wt<n>` derived from the cwd basename (`…worktree-n` / `…-wtn`)
 *   4. the cwd basename itself (covers the main checkout, e.g. `main`/`ampersand`)
 *
 * The `.mcp.json` entry is committed and shared across every worktree, so the id
 * must be derived at runtime from the cwd — never a static launch arg baked into
 * shared config.
 */
export function resolveAgentId(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
}): string {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const argv = options?.argv ?? process.argv;

  const fromEnv = env.AGENT_BUS_ID?.trim();
  if (fromEnv) return fromEnv;

  const fromArg = agentIdFromArgv(argv)?.trim();
  if (fromArg) return fromArg;

  const index = indexFromDirName(cwd);
  if (index !== null) return `wt${index}`;

  // The main checkout (no worktree suffix) is the foreman / command center.
  const foremanBasename = env.AGENT_BUS_FOREMAN_BASENAME?.trim() || "ampersand";
  const base = path.basename(cwd);
  if (base === foremanBasename) return "foreman";

  return base;
}
