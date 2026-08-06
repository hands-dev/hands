import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Seed a station worktree with a Claude Code permission allowlist before its
 * session is spawned.
 *
 * WHY THIS EXISTS: a station launched into a fresh worktree with no settings
 * file stalls on a permission prompt before it can read a single file, and
 * every *new* tool it reaches for produces another prompt. A kitchen in that
 * state looks alive — panes up, tickets assigned — while doing no work at all.
 * Observed cost on 2026-08-05: five stations, five tickets, ~14 hours, zero
 * progress until settings were written by hand and the panes restarted.
 *
 * A permissive `defaultMode` is NOT a substitute for this list. Measured on
 * the same day: under `bypassPermissions`, commands flagged by the security
 * heuristics (`simple_expansion`, expansion obfuscation) and `git add` /
 * `git commit` still prompt. Bypass reduces the treadmill; it doesn't end it.
 *
 * The grant is deliberately investigate-but-don't-ship: reads and read-only
 * shell so a station can diagnose and plan, `Edit`/`Write` left prompting, and
 * an explicit deny on the operations that would let a station push, rewrite
 * history, merge, or restructure the line. A station proposes on its own
 * branch; a human merges.
 */
export interface SeedResult {
  path: string;
  /** false when a settings file was already present — existing settings are never overwritten */
  written: boolean;
}

/** Read-only shell. Enumerated per-subcommand rather than `git *` so `push`/`reset` can't ride along. */
const ALLOW: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Monitor",
  "Bash(git log *)",
  "Bash(git status *)",
  "Bash(git diff *)",
  "Bash(git show *)",
  "Bash(git blame *)",
  "Bash(git branch *)",
  "Bash(git rev-list *)",
  "Bash(git rev-parse *)",
  "Bash(gh issue view *)",
  "Bash(gh issue list *)",
  "Bash(gh pr view *)",
  "Bash(gh pr list *)",
  "Bash(rg *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(wc *)",
  "Bash(find *)",
  "Bash(hands paths *)",
  "Bash(hands station ls *)",
  "mcp__plugin_hands_hands__hands_paths",
  "mcp__plugin_hands_hands__hands_receive",
  "mcp__plugin_hands_hands__hands_send",
  "mcp__plugin_hands_hands__hands_tasks",
  "mcp__plugin_hands_hands__hands_task_update",
  "mcp__plugin_hands_hands__hands_focus",
  "mcp__plugin_hands_hands__hands_ask",
  "mcp__plugin_hands_hands__hands_peers",
  "mcp__plugin_hands_hands__hands_board",
  "mcp__plugin_hands_hands__hands_history",
  "mcp__plugin_hands_hands__hands_priorities",
  "mcp__plugin_hands_hands__hands_questions",
  "mcp__plugin_hands_hands__hands_todos",
];

/** A station proposes; it never ships, and it never restructures the line. */
const DENY: readonly string[] = [
  "Bash(git push *)",
  "Bash(git reset --hard *)",
  "Bash(gh pr merge *)",
  "mcp__plugin_hands_hands__hands_scale",
  "mcp__plugin_hands_hands__hands_station_remove",
];

export function stationSettings(): Record<string, unknown> {
  return { permissions: { allow: [...ALLOW], deny: [...DENY] } };
}

/**
 * Write `<dir>/.claude/settings.local.json` if — and only if — it is absent.
 *
 * Never overwrites: a station whose settings were hand-tuned (by the principal
 * or by an earlier run) keeps them, and the caller is told nothing was written
 * so it can say so rather than silently appearing to have applied a policy it
 * didn't.
 *
 * Only ever call this on a worktree hands created. The principal's main
 * checkout is theirs — writing a permission policy into it uninvited would be
 * a surprising side effect of launching a session.
 */
/** The path this module owns, relative to a station worktree. */
export const SEEDED_RELPATH = ".claude/settings.local.json";

/**
 * Remove the seeded settings so a station worktree can be retired.
 *
 * `git worktree remove` refuses to delete a worktree with untracked files, and
 * seeding creates one in every station — which quietly broke `hands station rm`
 * and `hands scale <N>` downward for every seeded seat. (Caught in CI, not
 * locally: git versions differ on whether untracked files block a remove.)
 *
 * Deliberately narrow: the caller must have established that this scaffolding
 * is the ONLY thing dirtying the worktree. Real uncommitted work must still
 * block removal without --force — that guardrail is the point of the check,
 * and this must not become a hole in it.
 */
export function unseedStationPermissions(dir: string): boolean {
  const file = path.join(dir, SEEDED_RELPATH);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  // take the .claude dir too, but only if seeding is all that was in it
  const parent = path.dirname(file);
  try {
    if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch {
    // non-empty or already gone — leave it
  }
  return true;
}

export function seedStationPermissions(dir: string): SeedResult {
  const file = path.join(dir, ".claude", "settings.local.json");
  if (fs.existsSync(file)) return { path: file, written: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(stationSettings(), null, 2)}\n`);
  return { path: file, written: true };
}
