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
 * hands#86: a station SHIPS its own branch now — `git push` and `gh pr
 * create` are granted, not denied. The guardrail that remains is
 * history-rewrite and merge/restructure: `git reset --hard`, `gh pr merge`,
 * and the scaling/removal tools stay denied, because those are the
 * operations a station can't cleanly undo or that touch shared state
 * directly. Opening a PR is as reversible as pushing a branch — it can be
 * closed, and nothing lands without a merge, which is still not a station's
 * to run. Before this, EVERY denied push meant a finished piece of work only
 * reached GitHub if a human (in practice, the expo) cherry-picked the
 * station's local commit onto main and pushed it themselves — a serial
 * bottleneck on shipping, and each cherry-pick was its own opportunity to
 * hand-merge a conflict (`plugin/dist/BUILD.json`, most often) that the
 * station never saw. A station proposes on its own branch, pushes it, and
 * opens its own PR; a human still merges.
 */
export interface SeedResult {
  path: string;
  /** false when a settings file was already present — existing settings are never overwritten */
  written: boolean;
}

/** hands#86: the rules this module grants a station to ship its own work — push the branch, open the PR. */
export const PUSH_RULE = "Bash(git push *)";
export const PR_CREATE_RULE = "Bash(gh pr create *)";
/** Both hands#86 ship rules, grouped for staleness-checking and reconciliation (below). */
export const SHIP_RULES: readonly string[] = [PUSH_RULE, PR_CREATE_RULE];

/** Read-only shell, plus shipping its own branch and PR. Enumerated per-subcommand rather than `git *`/`gh *` so `reset`/`push --force`/`pr merge` variants can't ride along undetected. */
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
  ...SHIP_RULES,
];

/** A station ships its own branch and PR now (SHIP_RULES, above); it never rewrites history or restructures the line itself. */
const DENY: readonly string[] = [
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

function readSettingsPermissions(file: string): { allow: unknown[]; deny: unknown[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // absent, or not valid JSON — nothing this function can safely touch
  }
  const permissions = (parsed as { permissions?: { allow?: unknown; deny?: unknown } } | null)?.permissions;
  return {
    allow: Array.isArray(permissions?.allow) ? permissions!.allow : [],
    deny: Array.isArray(permissions?.deny) ? permissions!.deny : [],
  };
}

/**
 * Whether an EXISTING `settings.local.json` still reflects the pre-hands#86 policy: any
 * `SHIP_RULES` entry present in `deny`, or simply absent from `allow` (a station provisioned
 * before this file existed at all had no ship rules anywhere — same practical effect, still
 * denied by default). Returns false — nothing to reconcile — when there's no settings file yet;
 * that's `seedStationPermissions`'s job, and it already writes the current policy.
 */
export function shipPermissionsStale(dir: string): boolean {
  const permissions = readSettingsPermissions(path.join(dir, SEEDED_RELPATH));
  if (!permissions) return false;
  return SHIP_RULES.some((rule) => permissions.deny.includes(rule) || !permissions.allow.includes(rule));
}

/**
 * hands#86: `seedStationPermissions` deliberately never overwrites an existing settings file, so
 * a station provisioned before `git push`/`gh pr create` moved to ALLOW would otherwise carry the
 * old policy forever. This reconciles JUST the `SHIP_RULES` entries — remove each from `deny`,
 * add each to `allow` — in an EXISTING file, leaving every other hand-tuned entry untouched. A
 * no-op (changed: false) when there's no settings file yet (nothing to reconcile) or every rule is
 * already current. Called from the same sites that already call `seedStationPermissions`
 * (`launchStationSeat` in cli.ts, and `hands doctor --fix`) so an existing seat catches up the
 * next time it's opened/restarted or diagnosed — no separate one-off migration needed, and no seat
 * is silently left behind.
 */
export function reconcileStationShipPermissions(dir: string): { path: string; changed: boolean } {
  const file = path.join(dir, SEEDED_RELPATH);
  const permissions = readSettingsPermissions(file);
  if (!permissions) return { path: file, changed: false };
  const allow = [...permissions.allow];
  const deny = permissions.deny.filter((rule) => !SHIP_RULES.includes(rule as string));
  const denyChanged = deny.length !== permissions.deny.length;
  let allowChanged = false;
  for (const rule of SHIP_RULES) {
    if (!allow.includes(rule)) {
      allow.push(rule);
      allowChanged = true;
    }
  }
  if (!denyChanged && !allowChanged) return { path: file, changed: false };
  const settings = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  settings.permissions = { ...(settings.permissions as object | undefined), allow, deny };
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { path: file, changed: true };
}

/**
 * Merge additional top-level keys into `<dir>/.claude/settings.local.json`
 * WITHOUT clobbering whatever's already there — in practice, the permission
 * allowlist `seedStationPermissions` writes into the exact same file. Used by
 * the theming assignment (hands#104) to set the `theme` key alongside it.
 *
 * Only ever sets a key that isn't already present, same "never overwrite
 * hand-tuned settings" contract as `seedStationPermissions` — a station whose
 * settings already carry a `theme` (principal set one by hand, or a prior run
 * already assigned it) keeps it, and the caller is told nothing was written.
 */
export function mergeStationSettings(
  dir: string,
  patch: Record<string, unknown>,
): { path: string; written: boolean } {
  const file = path.join(dir, SEEDED_RELPATH);
  let existing: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
  } catch {
    // absent or malformed — start fresh rather than fail the caller
    existing = {};
  }
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in existing)) {
      existing[key] = value;
      changed = true;
    }
  }
  if (!changed) return { path: file, written: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`);
  return { path: file, written: true };
}
