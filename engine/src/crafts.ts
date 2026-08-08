import * as fs from "node:fs";
import * as path from "node:path";
import type { HandsConfig } from "./config.js";
import {
  type CraftFiles,
  type CraftScope,
  craftFiles,
  personalCraftsDir,
  sanitizeSegment,
  sharedCraftsDir,
} from "./remote.js";
import type { CraftBriefRow, CraftNoteRow, Store } from "./store.js";

/**
 * Crafts as sub-agent-deployed specializations (hands#81/#96/#49). A craft is
 * PULLED into a short-lived sub-agent at spawn time (`hands craft brief` →
 * `hands craft mise`) rather than pushed into a long-lived station — see
 * server.ts's craftRosterContext() for the (small, roster-only) content
 * stations/expo get injected at connect, and `hands craft brief|mise|fold|
 * fold-done` (cli.ts) for the actual deploy/return loop. Plain CLI
 * subcommands over Bash, deliberately NOT MCP tools — an MCP tool's schema
 * loads into every station/expo session's context on every turn, even the
 * many turns that never touch a craft, and Bash sidesteps the open question
 * of whether a spawned sub-agent even inherits its parent's MCP connections.
 *
 * Sub-agents never write craft files directly — they emit notes, harvested by
 * subagent-stop.ts into Store.insertCraftNote (the coordination DB — one per
 * kitchen, concurrency-safe, the actual source of truth). The git-committed
 * file is a downstream, best-effort EXPORT (`exportPendingCraftNotes`,
 * below), never written per-dispatch: mise.md is REBUILT WHOLESALE from every
 * mise note ever inserted (mechanical, no judgment needed, convergent
 * regardless of which caller exports it), book.md/skill.md's raw-notes
 * section is rebuilt from every currently-pending note for that target (real
 * curation into prose still needs a model, so it moves to a single
 * predictable trigger, `/hands:last-call`, instead of an ad hoc idle-wake
 * fold; see hands#118). `hands craft fold`/`fold-done` is what last-call runs
 * to distill the raw sections into curated prose, in place. (hands#114/#223:
 * an earlier design applied each note incrementally, straight onto whatever
 * the shared file already had. The corrected root cause, verified directly
 * (paths.ts's repoInfo, which sharedCraftsDir builds on): `--git-common-dir`
 * is the SAME physical directory from every worktree of a repo by design —
 * `repoInfo(cwd).repoRoot` resolves to the MAIN checkout regardless of which
 * worktree's `cwd` calls it, so `.hands/crafts/*.md` was never "one file per
 * worktree" in the first place — every station's runtime writes land on the
 * SAME on-disk file in the main checkout, uncommitted, racing each other with
 * only a short-TTL try-once lease between them. Divergent byte counts across
 * different worktrees came from each one pulling whatever got committed at a
 * different moment, not from separate local copies drifting apart. Wholesale
 * rebuild from the DB fixes this regardless of the exact mechanism: the file
 * becomes a derived, always-reconstructable snapshot, safe to commit whenever,
 * instead of a target multiple uncoordinated writers mutate directly.)
 */

/**
 * Role crafts (hands#139/#91/#95) — a craft in every mechanical sense (book +
 * mise + skill, dispatched the same `hands craft brief`/`mise` way, its notes
 * fold through the same pipeline) but NOT a codebase-domain specialization a
 * station picks ad hoc: it judges the whole board, not one ticket's slice,
 * and its founding charter isn't user-authored. Deliberately NOT a separate
 * storage tier — it lives in the shared tier like any other craft (so
 * `craftFiles`/`craftKnown`/`hands craft brief|mise|fold` all resolve it for
 * free, no new resolution path to build or keep in sync) — only EXCLUDED,
 * explicitly, from the surfaces a user browses or mutates: the roster
 * (`hands craft ls`, the roster context injected into sessions),
 * `sync`'s Agent/Skill materialization sweep, `promote`/`localize`, and
 * `ready`/`unready` (a role craft never writes files, so it never needs
 * execute mode — see crafts.ts's CDC section for why that's structural, not
 * a missing certification).
 */
export const ROLE_CRAFT_SLUGS: ReadonlySet<string> = new Set(["cdc"]);

export function isRoleCraft(slug: string): boolean {
  return ROLE_CRAFT_SLUGS.has(slug);
}

/** Who marked a craft ready for execute-mode dispatch, and when — a judgment, not a mechanical fact (hands#92). */
export interface CraftReadiness {
  at: string;
  by: string;
}

export interface CraftRosterEntry {
  slug: string;
  scope: CraftScope;
  covers: string | null;
  /** parsed from the book's header line; null = never distilled */
  distilled: string | null;
  /** null = plan-mode only (default for every new craft, hands#92) */
  ready: CraftReadiness | null;
  pendingNotes: number;
}

const COVERS_RE = /^>\s*covers:\s*(.*?)\s*(?:·|$)/;
// Tolerates the pre-cutover header key too (hands#129-style parse tolerance) —
// a craft distilled for the first time under this build rewrites it to `distilled:`.
const DISTILLED_RE = /(?:distilled|last held):\s*(\S+)/;
const READY_RE = /·\s*ready:\s*(\S+)\s+by\s+(\S+)/;

export function parseCraftHeader(
  bookContent: string | null,
): { covers: string | null; distilled: string | null; ready: CraftReadiness | null } {
  if (!bookContent) return { covers: null, distilled: null, ready: null };
  const line = bookContent.split("\n").find((l) => l.trim().startsWith(">")) ?? "";
  const readyMatch = READY_RE.exec(line);
  return {
    covers: COVERS_RE.exec(line)?.[1]?.trim() || null,
    distilled: DISTILLED_RE.exec(line)?.[1] ?? null,
    ready: readyMatch ? { at: readyMatch[1]!, by: readyMatch[2]! } : null,
  };
}

const READY_CLAUSE_RE = /\s*·\s*ready:\s*\S+\s+by\s+\S+/;

/**
 * Stamp or revoke a craft's `ready` state on its book's header line — hands#92's sous-owned
 * execute-mode gate. `ready: null` revokes (drop the clause, reverting to plan-mode-only, the
 * default for every new craft); a real value adds/replaces it. This is deliberately a judgment
 * recorded in the craft's own file, not a mechanical fact inferred from whether the craft has
 * been synced/materialized — the principal was explicit that those are different things. Header-
 * line only, same mechanical-edit shape as `sweepHeldSeatHeader` — never touches body prose.
 */
export function stampCraftReadiness(bookContent: string, ready: CraftReadiness | null): string {
  const lines = bookContent.split("\n");
  const idx = lines.findIndex((l) => l.trim().startsWith(">"));
  if (idx === -1) {
    // No header line at all — shouldn't happen for a real charter, but don't silently drop the
    // stamp; prepend one rather than lose the caller's intent.
    return ready ? `> ready: ${ready.at} by ${ready.by}\n${bookContent}` : bookContent;
  }
  const stripped = lines[idx]!.replace(READY_CLAUSE_RE, "");
  lines[idx] = ready ? `${stripped} · ready: ${ready.at} by ${ready.by}` : stripped;
  return lines.join("\n");
}

const HELD_SEAT_CLAUSE_RE = /·\s*last held:\s*(\S+)(?:\s+by\s+\S+)?/i;

/**
 * One-time content fix for hands#167: rewrites a book's `last held: DATE by AGENT` header clause
 * (the retired per-station-ownership model — a generalist reading it reasonably concludes the
 * craft belongs to somebody else and doesn't dispatch it) into `distilled: DATE`, dropping the
 * ownership assertion while keeping the timestamp parseCraftHeader already treats as a staleness
 * signal. A no-op (changed: false) when the header carries no such clause. Header-line only —
 * deliberately doesn't touch ownership prose elsewhere in a book's body (e.g. "belongs to another
 * station and must not be written into"), which needs a model's judgment to rewrite safely, not a
 * regex; `hands craft sweep-headers` (cli.ts) is what runs this across a repo's whole roster.
 */
export function sweepHeldSeatHeader(bookContent: string): { content: string; changed: boolean } {
  if (!HELD_SEAT_CLAUSE_RE.test(bookContent)) return { content: bookContent, changed: false };
  return { content: bookContent.replace(HELD_SEAT_CLAUSE_RE, (_m, date: string) => `· distilled: ${date}`), changed: true };
}

function readFileSafe(p: string): string | null {
  try {
    const body = fs.readFileSync(p, "utf8").trim();
    return body || null;
  } catch {
    return null;
  }
}

/** Truncate to `cap` code points, tail replaced with a note — the shared cap logic behind readCraftFileCapped and the merged-read functions below. */
export function capText(text: string | null, cap = 6000): string | null {
  if (!text) return null;
  const points = Array.from(text);
  return points.length <= cap ? text : `${points.slice(0, cap).join("")}\n…(truncated — trim this file)`;
}

/** Like readFileSafe, but capped — for handing content to a model or over the wire (dashboard). */
export function readCraftFileCapped(p: string, cap = 6000): string | null {
  return capText(readFileSafe(p), cap);
}

function listSlugsIn(dir: string | null): string[] {
  if (!dir) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".md") && !f.endsWith(".mise.md") && !f.endsWith(".skill.md"))
    .map((f) => f.slice(0, -".md".length));
}

interface CraftFileEntry {
  slug: string;
  scope: CraftScope;
  covers: string | null;
  distilled: string | null;
  ready: CraftReadiness | null;
}

/**
 * Pure filesystem enumeration — no Store, so provisioning code (which must
 * not open the bus DB) can call this directly. Shared wins a slug collision
 * (matches craftFiles()'s own resolution).
 */
function listCraftFiles(
  config: HandsConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): CraftFileEntry[] {
  const shared = sharedCraftsDir(config, cwd);
  const personal = personalCraftsDir(config, env, cwd);
  const seen = new Map<string, CraftFileEntry>();
  for (const [dir, scope] of [
    [shared, "shared"] as const,
    [personal, "personal"] as const,
  ]) {
    for (const slug of listSlugsIn(dir)) {
      if (seen.has(slug) || !dir) continue;
      const { covers, distilled, ready } = parseCraftHeader(readFileSafe(path.join(dir, `${slug}.md`)));
      seen.set(slug, { slug, scope, covers, distilled, ready });
    }
  }
  return [...seen.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Whether `slug` (already resolved by `craftFiles` — so any `craft-` alias is already stripped)
 * is a real, founded craft, plus a known-slug list for a "closest match" suggestion.
 * `hands craft brief` uses this to refuse an unknown slug loudly instead of silently writing a
 * phantom `craft_briefs` row (hands#165) — `mise`/`fold`/`promote`/`localize` have their own
 * existing checks (an open brief, a moved file count, a pending-note backlog) and don't need this.
 *
 * `known` is checked against the FULL roster, role crafts included — a role craft (hands#139) is
 * still a real dispatch target (`hands craft brief cdc` must resolve), it's only excluded from
 * browsing. `slugs`, by contrast, only ever seeds a typo suggestion (`nearestCraftSlugs`), and
 * role crafts are deliberately left out of it: they're plugin/system-owned, not something a
 * station discovers by browsing or backs into via a near-miss spelling — the one legitimate way
 * to reach one is to already know its exact name.
 */
export function craftKnown(
  slug: string,
  config: HandsConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): { known: boolean; slugs: string[] } {
  const all = listCraftFiles(config, env, cwd).map((e) => e.slug);
  return { known: all.includes(slug), slugs: all.filter((s) => !isRoleCraft(s)) };
}

/** Levenshtein edit distance — small inputs only (craft slugs), no need for a smarter algorithm. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[rows - 1]![cols - 1]!;
}

/** The `limit` known slugs closest to `target` by edit distance — a fix suggestion for a typo'd `hands craft brief` call. */
export function nearestCraftSlugs(target: string, known: string[], limit = 3): string[] {
  return [...known].sort((a, b) => editDistance(target, a) - editDistance(target, b)).slice(0, limit);
}

/**
 * The full roster across both tiers, enriched with each craft's pending-note
 * count. Role crafts (hands#139/#91/#95) are excluded — this is the browsable
 * list a station/expo picks a domain specialization from, not an inventory of
 * everything with a book on disk. `craftKnown`/`hands craft brief` still
 * resolve a role craft directly by slug; only discovery here is filtered.
 */
export function listCrafts(
  store: Store,
  config: HandsConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): CraftRosterEntry[] {
  return listCraftFiles(config, env, cwd)
    .filter((e) => !isRoleCraft(e.slug))
    .map((e) => ({
      ...e,
      pendingNotes: store.pendingCraftNotes(e.slug).length,
    }));
}

/** Where a craft's generated, session-discoverable Agent type lives inside a given checkout/worktree. */
export function craftAgentPath(targetDir: string, slug: string): string {
  return path.join(targetDir, ".claude", "agents", `craft-${slug}.md`);
}

/** Where a craft's generated, session-discoverable Skill lives inside a given checkout/worktree. */
export function craftSkillPath(targetDir: string, slug: string): string {
  return path.join(targetDir, ".claude", "skills", `craft-${slug}`, "SKILL.md");
}

/**
 * hands#92: execute mode is gated on a JUDGMENT (the sous — or, until one runs, whoever operates
 * `hands craft ready` by hand — has deemed this craft's book/mise solid enough to trust with real
 * edits), not a mechanical fact like "has this been synced/materialized." `entry.ready` is that
 * judgment, parsed straight from the craft's own header — a new craft with no book/mise maturity
 * is plan-mode-only by construction (`ready` is null until someone stamps it), no exceptions.
 */
function generatedCraftAgent(entry: CraftFileEntry): string {
  const clearedForExecute = entry.ready !== null;
  const modeNote = clearedForExecute
    ? `Cleared for EXECUTE mode — marked ready for service ${entry.ready!.at} by ${entry.ready!.by}. Edit, ` +
      "write, and commit inside your caller's own worktree; never isolate into a fresh worktree yourself."
    : "PLAN MODE ONLY — this craft hasn't been marked ready for service yet (no maturity judgment " +
      `on file). Read, reason, propose. Do not edit, write, commit, or run mutating commands. \`hands ` +
      `craft ready ${entry.slug}\` is how a craft graduates once its book/mise are solid — that call is ` +
      "the sous's, not yours.";
  const briefCmd = clearedForExecute
    ? `hands craft brief ${entry.slug} --task "<one line — what you were asked to do>" --mode execute`
    : `hands craft brief ${entry.slug} --task "<one line — what you were asked to do>"`;
  return `---
name: craft-${entry.slug}
description: ${entry.covers ?? entry.slug} — dispatch for any work in this craft's area (hands#81/#96). Generated by \`hands craft sync\` — do not hand-edit, edits are overwritten on the next sync.
---

You are the **${entry.slug}** craft, dispatched for one ticket-slice — not a generalist.

${modeNote}

1. Run \`${briefCmd}\` first
   — add \`--ticket <id>\` too if the caller's prompt names a ticket id you're working. This
   registers the dispatch and PRINTS a chit — the first line names your \`briefId\`, note it,
   you need it below. The chit may say \`Usage mode: low\` — honor it if so.
2. Invoke \`Skill({ skill: "craft-${entry.slug}" })\` — your operating manual. It tells you how to
   pull your current book/mise (\`hands craft mise <briefId>\`, from step 1) before you start.
3. Do the work the caller's prompt describes${clearedForExecute ? "" : " — investigate and propose, don't implement"}.
4. Before you return, emit the \`\`\`craft-note\`\`\` block your skill describes, last thing in your
   final message. \`nothing-new: true\` is a correct and welcome answer — never invent learnings.
`;
}

function generatedCraftSkill(entry: CraftFileEntry, skillBody: string | null): string {
  const domain =
    skillBody?.trim() ||
    "(no procedures written yet — you may be founding this craft. Work generically, and note what you learn.)";
  return `---
name: craft-${entry.slug}
description: Operating manual for the ${entry.slug} craft (${entry.covers ?? "no covers stated yet"}). Generated by \`hands craft sync\` from ${entry.scope === "shared" ? "the repo-shared" : "your personal"} craft file — do not hand-edit here; edit the craft's own .skill.md and re-sync.
---

**First**, before anything else: run \`hands craft mise <briefId>\` (the id \`hands craft brief\`
printed) — prints your current book/mise as JSON, the sibling craft roster, and a read-in command
if you're stale. Trust what it tells you before re-deriving anything yourself. It also carries the
current \`usageMode\` — when \`"low"\`, keep your own work terse: skip optional exploration, prefer
the cheapest sufficient approach, don't gold-plate.

## Procedures

${domain}

## Before you return

Emit this block, last thing in your final message:

\`\`\`craft-note
brief: <your briefId>
craft: ${entry.slug}
nothing-new: true|false
mise: <path/command — only if it differs from what hands craft mise told you>
book: <a decision, fact, or gotcha>
skill: <a procedure or check you settled on>
friction: <this craft's OWN book/skill/mise was wrong, or a check was slow>
refactor: <the CODE/domain had friction unrelated to this craft's materials — what would make future work here easier>
spillover(<other-craft-slug>): <something you learned that belongs to a DIFFERENT craft>
\`\`\`

Zero or more mise/book/skill/friction/refactor/spillover lines, each one learning. "nothing-new:
true" is correct and welcome — never invent learnings to fill the block. \`refactor\` is the
principal's "what could have made this work easier, opportunities to refactor" ask (hands#92) —
distinct from \`friction\`, which is about whether YOUR OWN book/skill/mise steered you wrong.
`;
}

/**
 * Materialize every craft's book/mise/skill into a real, session-discoverable Claude Code Agent
 * type + Skill inside `targetDir` (a station worktree or the main checkout) — so dispatch
 * collapses to one call, `Agent({ agentType: "craft-<slug>", prompt: "<task>" })`, with no
 * `hands craft brief`/`mise` round-trip needed by the DISPATCHER (the generated agent runs
 * those itself, per its own system prompt above).
 *
 * MUST run before the target session's Claude Code process starts — Skill/Agent-type discovery
 * is fixed at session start, not live (confirmed empirically: a freshly-created skill/agentType
 * is invisible to a sub-agent spawned in the same already-running session). Provisioning
 * (`addStations`) and `hands craft restart`/`hands craft sync` are the right call sites; a
 * craft founded or edited AFTER a station's session already started still needs
 * `hands craft brief`/`mise` (they open a fresh Store connection each call, so they're always
 * live) until that station restarts.
 *
 * Idempotent and self-cleaning: regenerates every current craft's files unconditionally (cheap,
 * markdown-sized) and removes generated files for any craft no longer on the roster (renamed,
 * localized away, etc.) so a stale agentType never lingers.
 */
export function materializeCraftAgents(
  config: HandsConfig,
  targetDir: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): { written: string[]; removed: string[] } {
  // Role crafts (hands#139/#91/#95) are excluded from the sync sweep — they
  // stay dispatchable via `hands craft brief` (craftKnown/craftFiles are
  // unfiltered), just never materialized as a one-call Agent type. Also
  // self-cleaning: if one was ever materialized before this filter existed,
  // the removal pass below deletes it, since it's no longer in `wantSlugs`.
  const roster = listCraftFiles(config, env, cwd).filter((e) => !isRoleCraft(e.slug));
  const agentsDir = path.join(targetDir, ".claude", "agents");
  const skillsDir = path.join(targetDir, ".claude", "skills");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  const written: string[] = [];
  for (const entry of roster) {
    const files = craftFiles(entry.slug, env, cwd);
    const skillFile = craftSkillPath(targetDir, entry.slug);
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(craftAgentPath(targetDir, entry.slug), generatedCraftAgent(entry));
    fs.writeFileSync(skillFile, generatedCraftSkill(entry, readFileSafe(files.skill)));
    written.push(entry.slug);
  }

  const wantSlugs = new Set(roster.map((c) => c.slug));
  const removed: string[] = [];
  let agentFiles: string[] = [];
  try {
    agentFiles = fs.readdirSync(agentsDir);
  } catch {
    agentFiles = [];
  }
  for (const name of agentFiles) {
    const m = /^craft-(.+)\.md$/.exec(name);
    if (m && !wantSlugs.has(m[1]!)) {
      fs.rmSync(path.join(agentsDir, name), { force: true });
      removed.push(m[1]!);
    }
  }
  let skillDirs: string[] = [];
  try {
    skillDirs = fs.readdirSync(skillsDir);
  } catch {
    skillDirs = [];
  }
  for (const name of skillDirs) {
    const m = /^craft-(.+)$/.exec(name);
    if (m && !wantSlugs.has(m[1]!)) fs.rmSync(path.join(skillsDir, name), { recursive: true, force: true });
  }

  return { written, removed };
}

export interface CraftDispatchRate {
  ticketsFinished: number;
  ticketsWithCraftBrief: number;
  executeDispatches: number;
  planDispatches: number;
}

/** Pending book/skill notes at or above this count are worth folding now rather than waiting for end-of-shift (hands#92). */
export const FOLD_READY_THRESHOLD = 3;

const WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * How many crafts' headers show a `distilled:` stamp inside the last `windowMs` — the operator-
 * facing "is the learning loop actually closing" signal (hands#92/#168): a rising dispatch rate
 * with a flat distilled-count means dispatches are happening but nothing is compounding.
 */
export function booksDistilledRecently(entries: CraftRosterEntry[], now: number, windowMs = WEEK_MS): number {
  return entries.filter((e) => {
    if (!e.distilled) return false;
    const t = Date.parse(e.distilled);
    return !Number.isNaN(t) && now - t <= windowMs && now - t >= 0;
  }).length;
}

/**
 * Fold-readiness for role crafts, surfaced ONLY to the expo (hands#139 follow-up). `listCrafts`
 * excludes role crafts from the browsable roster on purpose (isRoleCraft's doc comment) because
 * they aren't a domain specialization a generalist picks ad hoc — but the fold-readiness nudge
 * (#198) rides on that same filtered roster, so a role craft's book could accumulate notes
 * indefinitely with nobody ever told it was ready to fold. A role craft is dispatched
 * exclusively by the expo (never a station — see plugin/skills/expo/SKILL.md's CDC dispatch),
 * so the expo is the only legitimate audience. Deliberately returned as its own string, never
 * merged into `formatRosterContext`'s bulleted list — that list is what a station browses to
 * pick a craft to dispatch, and role crafts still must not appear there.
 */
export function roleCraftFoldNudges(
  store: Store,
  config: HandsConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const ready = listCraftFiles(config, env, cwd)
    .filter((e) => isRoleCraft(e.slug))
    .map((e) => ({ slug: e.slug, pendingNotes: store.pendingCraftNotes(e.slug).length }))
    .filter((e) => e.pendingNotes >= FOLD_READY_THRESHOLD);
  if (ready.length === 0) return "";
  const lines = ready.map(
    (e) => `${e.slug} has ${e.pendingNotes} pending note(s) — ready to fold (hands craft fold ${e.slug}).`,
  );
  return (
    "\n\nRole craft(s) ready to fold — not on the roster above by design (hands#139), still yours to fold:\n" +
    lines.join("\n")
  );
}

/**
 * The roster injected into every station's AND the expo's MCP instructions at
 * connect (server.ts's craftRosterContext) — a summary, not content, so the
 * orchestrator's own context cost stays constant regardless of how fat a book
 * gets. Capped like the old per-file craftContext() injection was. `targetDir`
 * is this session's OWN checkout/worktree — used only to report which crafts
 * already have a materialized agentType here (the fast dispatch path) vs.
 * which need the `hands craft brief`/`mise` fallback (founded/edited since
 * the last `hands craft sync` or provisioning).
 *
 * Each bullet leads with the BARE slug — the exact string `hands craft brief <slug>` accepts —
 * never the `craft-<slug>` agentType form, and the dispatch line below spells out which string
 * goes where. Getting this backwards is hands#165: a station that read `craft-<slug>` off the
 * roster and passed it straight to `hands craft brief` got a silently-recorded phantom dispatch,
 * because that command never checked the slug was real. It does now (craftKnown, in cli.ts) —
 * this wording is the other half of the same fix, so the mismatch stops happening at the source.
 */
export function formatRosterContext(
  entries: CraftRosterEntry[],
  targetDir: string,
  dispatchRate?: CraftDispatchRate,
  now: number = Date.now(),
): string {
  if (entries.length === 0) {
    return (
      "\n\nNo crafts founded yet. Crafts are dispatched as sub-agents, not held — found one via " +
      "/hands:crafts only for a durable, recurring beat."
    );
  }
  const lines = entries.map((e) => {
    const staleness = e.distilled ? "" : " (never distilled)";
    const pending = e.pendingNotes ? ` · ${e.pendingNotes} pending note(s)` : "";
    const foldReady = e.pendingNotes >= FOLD_READY_THRESHOLD ? " · ready to fold" : "";
    const synced = fs.existsSync(craftAgentPath(targetDir, e.slug));
    // "brief-only" (not "not yet synced" — hands#167): this craft is fully dispatchable right
    // now via `hands craft brief`, just not through the one-call Agent-tool path yet. The old
    // wording read as "unavailable" and a generalist reasonably chose not to dispatch at all.
    // "plan-only" (hands#92): a JUDGMENT, not a mechanical fact — no one has marked this craft's
    // book/mise solid enough to trust with real edits yet (`hands craft ready`, sous-owned).
    const readyLabel = e.ready ? "" : ", plan-only";
    return `- ${e.slug} [${e.scope}${synced ? "" : ", brief-only"}${readyLabel}] — ${e.covers ?? "no covers stated yet"}${staleness}${pending}${foldReady}`;
  });
  const cap = 1500;
  let body = lines.join("\n");
  const points = Array.from(body);
  if (points.length > cap) body = `${points.slice(0, cap).join("")}\n…(see hands craft ls for the rest)`;
  const totalDispatches = dispatchRate ? dispatchRate.executeDispatches + dispatchRate.planDispatches : 0;
  const rate =
    dispatchRate && dispatchRate.ticketsFinished > 0
      ? `\nDispatch rate (7d): ${dispatchRate.ticketsWithCraftBrief} of ${dispatchRate.ticketsFinished} finished ticket(s) went through a craft` +
        (totalDispatches > 0 ? ` (${dispatchRate.executeDispatches} execute, ${dispatchRate.planDispatches} plan).` : ".")
      : "";
  const distilledCount = booksDistilledRecently(entries, now);
  const distilledLine = `\n${distilledCount} book(s) distilled in the last 7 days.`;
  return (
    "\n\n## Crafts available (dispatch as sub-agents — don't do their work yourself)\n" +
    body +
    '\nSynced: Agent({ agentType: "craft-<slug>", prompt: "<task>" }) — e.g. "craft-' +
    `${entries[0]!.slug}" for the first one above; it briefs and equips itself, execute-mode if ` +
    'ready, plan-mode otherwise. "brief-only" → run ' +
    "`hands craft brief <slug>` yourself — the BARE slug shown above, no `craft-` prefix " +
    "(add `--ticket <id>` if you're working one, `--mode execute` only if the craft is ready), " +
    "then paste the printed chit into a general-purpose Agent's prompt. \"plan-only\" means read, " +
    "reason, propose — review its diff before folding an execute-mode craft's work into your own " +
    "branch, same bar as your own work. `hands craft ls` gives the full roster on demand." +
    rate +
    distilledLine
  );
}

/** The ~16-line pointer an orchestrator pastes into the Agent tool's `prompt` — never the craft's content itself. */
export function composeChit(brief: CraftBriefRow, covers: string | null, usageMode: "low" | "normal"): string {
  const lines = [
    `You are carrying the craft "${brief.craft_slug}" (brief #${brief.id}, mode: ${brief.mode}) for this one turn.`,
    covers ? `Covers: ${covers}` : null,
    usageMode === "low"
      ? "Usage mode: low — keep this terse: skip optional exploration, prefer the cheapest sufficient approach, don't gold-plate."
      : null,
    "",
    `FIRST ACTION, before anything else: run \`hands craft mise ${brief.id}\`.`,
    "  Fallback if that command errors: Read these files yourself, in this order — the craft's " +
      "mise, then skill, then book (paths from hands_paths' craftsDir/sharedCraftsDir).",
    "Trust what they tell you before re-deriving it; they are a previous holder's distillation.",
    "",
    brief.mode === "execute"
      ? "EXECUTE: edit only inside your caller's own worktree. Never isolate into a fresh worktree yourself."
      : "PLAN MODE: read, reason, propose. Do not edit, write, commit, or run mutating commands.",
    "",
    "BEFORE YOU RETURN, emit this block verbatim-shaped, last thing in your final message:",
    "```craft-note",
    `brief: ${brief.id}`,
    `craft: ${brief.craft_slug}`,
    "nothing-new: true|false",
    "mise: <path/command — one line, only if it differs from what you were told>",
    "book: <decision/fact/gotcha — one line>",
    "skill: <a procedure or check you settled on — one line>",
    "friction: <the craft's OWN book/skill/mise was wrong, or a check was slow — one line>",
    "refactor: <the CODE/domain had friction unrelated to this craft's materials — what would make future work here easier>",
    "spillover(<other-craft-slug>): <something you learned that belongs to a DIFFERENT craft>",
    "```",
    "Zero or more of mise/book/skill/friction/refactor/spillover lines, each is one learning. " +
      '"nothing-new: true" is a correct and welcome answer — never invent learnings to fill the block.',
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

export interface ParsedCraftNoteLine {
  kind: "mise" | "book" | "skill" | "friction" | "refactor" | "spillover";
  body: string;
  spilloverCraft?: string;
}

export interface ParsedCraftNote {
  briefId: number | null;
  craftSlug: string | null;
  nothingNew: boolean;
  entries: ParsedCraftNoteLine[];
}

const NOTE_BLOCK_RE = /```craft-note\r?\n([\s\S]*?)```/;
const KV_RE = /^(mise|book|skill|friction|refactor):\s*(.+)$/;
const SPILLOVER_RE = /^spillover\(([a-z0-9._-]+)\):\s*(.+)$/i;

/** Pull the last ```craft-note``` block out of a finished sub-agent's transcript text. Mechanical, not a model call. */
export function parseCraftNoteBlock(text: string): ParsedCraftNote | null {
  let last: RegExpExecArray | null = null;
  const re = new RegExp(NOTE_BLOCK_RE, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return null;
  const body = last[1] ?? "";
  let briefId: number | null = null;
  let craftSlug: string | null = null;
  let nothingNew = false;
  const entries: ParsedCraftNoteLine[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const brief = /^brief:\s*(\d+)/.exec(line);
    if (brief) {
      briefId = Number(brief[1]);
      continue;
    }
    const craft = /^craft:\s*(\S+)/.exec(line);
    if (craft) {
      craftSlug = sanitizeSegment(craft[1]!, "unnamed");
      continue;
    }
    const nn = /^nothing-new:\s*(true|false)/.exec(line);
    if (nn) {
      nothingNew = nn[1] === "true";
      continue;
    }
    const kv = KV_RE.exec(line);
    if (kv) {
      entries.push({ kind: kv[1] as ParsedCraftNoteLine["kind"], body: kv[2]! });
      continue;
    }
    const spill = SPILLOVER_RE.exec(line);
    if (spill) {
      entries.push({ kind: "spillover", body: spill[2]!, spilloverCraft: sanitizeSegment(spill[1]!) });
    }
  }
  return { briefId, craftSlug, nothingNew, entries };
}

const MISE_KEY_DELIM_RE = /\s(?:—|->|→)\s|:\s/;

/**
 * The substring before the entry's first ` — `/` -> `/` → `/`: ` delimiter, else the whole
 * trimmed line. Used only to match an existing bullet for upsert — getting this wrong costs a
 * duplicate line, never a lost note, which is the bias we want.
 */
function extractMiseKey(entry: string): string {
  const trimmed = entry.trim();
  const m = MISE_KEY_DELIM_RE.exec(trimmed);
  return (m ? trimmed.slice(0, m.index) : trimmed).trim();
}

/** Mechanical upsert-by-key into mise.md's flat bullet list — no model needed, mise is already structured. */
export function upsertMiseLine(text: string | null, entry: string): string {
  const line = entry.trim();
  const key = extractMiseKey(line);
  const lines = (text ?? "").split("\n");
  let replaced = false;
  const next = lines.map((l) => {
    const m = /^- (.*)$/.exec(l);
    if (m && !replaced && extractMiseKey(m[1]!) === key) {
      replaced = true;
      return `- ${line}`;
    }
    return l;
  });
  if (!replaced) {
    while (next.length > 0 && next[next.length - 1]!.trim() === "") next.pop();
    next.push(`- ${line}`);
  }
  return `${next.join("\n").trim()}\n`;
}

const RAW_NOTES_HEADING = "## Raw notes (unfolded)";

/**
 * Durable, immediate append into book.md/skill.md's trailing raw-notes section — real curation
 * (discard restatements, keep it bounded) still needs a model, so this only guarantees the note
 * is never lost or invisible before that happens; it does not attempt to merge into the curated
 * prose above the section.
 */
export function appendRawNote(text: string | null, taggedLine: string): string {
  const body = (text ?? "").replace(/\s+$/, "");
  const line = `- ${taggedLine.trim()}`;
  if (body.includes(RAW_NOTES_HEADING)) return `${body}\n${line}\n`;
  const prefix = body ? `${body}\n\n` : "";
  return `${prefix}${RAW_NOTES_HEADING}\n${line}\n`;
}

/** Everything above the raw-notes section — the curated prose a fold pass owns, untouched by mechanical export. */
function stripRawSection(text: string | null): string {
  if (!text) return "";
  const idx = text.indexOf(RAW_NOTES_HEADING);
  return (idx === -1 ? text : text.slice(0, idx)).replace(/\s+$/, "");
}

/**
 * Rebuild book.md's/skill.md's raw-notes section from scratch against `pendingForTarget` (already
 * filtered to the right kind/target), on top of the file's stable curated prefix — a pure
 * function of (prefix, pending), not an incremental append (hands#114/#223): any two callers
 * computing this from the same prefix and the same pending set converge on byte-identical output,
 * regardless of which worktree wrote what when. Empty `pendingForTarget` returns just the
 * prefix — correct once everything's been distilled and fold's own rewrite already removed the
 * section (FOLD_INSTRUCTIONS has it delete the section as part of its rewrite).
 */
export function rebuildRawSection(currentFileContent: string | null, pendingForTarget: readonly CraftNoteRow[]): string {
  const prefix = stripRawSection(currentFileContent);
  if (pendingForTarget.length === 0) return prefix ? `${prefix}\n` : "";
  let text: string | null = prefix || null;
  for (const note of pendingForTarget) text = appendRawNote(text, formatRawTaggedLine(note));
  return text ?? "";
}

/** Exported for readRawMerged/exportPendingCraftNotes below — the same rendering the real write path uses. */
export function formatRawTaggedLine(note: CraftNoteRow): string {
  if (note.kind === "book") return `[book] ${note.body}`;
  if (note.kind === "friction") return `[friction] ${note.body}`;
  if (note.kind === "refactor") return `[refactor] ${note.body}`;
  if (note.kind === "spillover") return `[spillover · from ${note.spillover_craft ?? "unknown"}] ${note.body}`;
  return note.body; // skill — untagged, the file itself supplies the type
}

/** `pending` (any mix of kinds) filtered to the raw-append target a note belongs to — book for everything except mise/skill. */
function forTarget(pending: readonly CraftNoteRow[], target: "book" | "skill"): CraftNoteRow[] {
  return pending.filter((n) => n.kind !== "mise" && (n.kind === "skill") === (target === "skill"));
}

const EXPORT_LEASE_TTL_MS = 15_000;

/**
 * The ONLY write path into a craft's git-committed files (hands#114/#223's storage fix). Every
 * note is already durable the instant it's harvested — `insertCraftNote` writes to `craft_notes`
 * in the coordination DB, one shared DB per kitchen, concurrency-safe by construction. The
 * git-committed file is downstream of that: a periodic, best-effort, WHOLESALE-REBUILD export,
 * never an incremental per-note append every dispatch races to make.
 *
 * Previously (hands#118) the harvester called an incremental per-note apply directly on every
 * dispatch's finish, appending straight onto whatever the shared file already had at that moment.
 * Root cause, verified directly against paths.ts's repoInfo (which sharedCraftsDir builds on):
 * `--git-common-dir` resolves to the SAME physical directory from every worktree of a repo by
 * design, so `repoInfo(cwd).repoRoot` — and therefore `.hands/crafts/*.md` — is the MAIN
 * checkout's path regardless of which worktree's `cwd` calls it. Every station's dispatch was
 * writing the SAME on-disk file, uncommitted, racing every other station's dispatch with only a
 * short-TTL try-once lease between them; the divergent byte counts different worktrees later
 * observed (6461/6857/4269/4269, one checkout clobbered to one line) reflect each one pulling
 * whatever got committed at a different moment, not separate local copies drifting apart on their
 * own. AND, worse: a mise note was marked "resolved" globally the instant any dispatch applied
 * it, so if that write then got overwritten by a losing race before anyone committed it, the note
 * could vanish from the file entirely while still reading as "handled" — even though the DB
 * itself never lost anything. Rebuilding wholesale fixes both: mise.md is replayed from
 * Store.allMiseCraftNotes (every mise note ever inserted for this slug, not just
 * currently-pending ones — see that method's own doc comment), and book.md/skill.md's raw section
 * is rebuilt from ALL currently-pending notes for that target, never appended onto file-specific
 * history. Any caller computing either from the same DB state gets byte-identical output,
 * regardless of race timing.
 *
 * Called from `hands craft fold` (guaranteed, lease-already-held) and opportunistically from
 * `hands craft mise` (best-effort, its own lease attempt — contention just means this round
 * skips; readMiseMerged/readRawMerged cover reads regardless of whether export landed anything).
 * Returns how many notes' content is now reflected on disk this round (0 if both leases were
 * contended).
 */
export function exportPendingCraftNotes(store: Store, files: CraftFiles, holder: string): number {
  let touched = 0;

  const miseLease = `${files.slug}:mise`;
  if (store.acquireCraftFoldLease(miseLease, holder, EXPORT_LEASE_TTL_MS)) {
    try {
      const allMise = store.allMiseCraftNotes(files.slug);
      const newlyUnfolded = allMise.filter((n) => !n.folded_at);
      // Only rewrite (and count as "touched") when there's genuinely new content — mise.md is
      // purely a browsability snapshot now (readMiseMerged never reads it), so re-writing
      // identical content on every export call would just be wasted I/O with no correctness
      // benefit, and would make this function look like it's doing work when it isn't.
      if (newlyUnfolded.length > 0) {
        let text: string | null = null;
        for (const note of allMise) text = upsertMiseLine(text, note.body);
        fs.mkdirSync(files.dir, { recursive: true });
        fs.writeFileSync(files.mise, text ?? "");
        for (const note of newlyUnfolded) store.markCraftNoteFolded(note.id);
        touched += newlyUnfolded.length;
      }
    } finally {
      store.releaseCraftFoldLease(miseLease, holder);
    }
  }

  if (store.acquireCraftFoldLease(files.slug, holder, EXPORT_LEASE_TTL_MS)) {
    try {
      const pending = store.pendingCraftNotes(files.slug);
      for (const [path, target] of [[files.book, "book"], [files.skill, "skill"]] as const) {
        const relevant = forTarget(pending, target);
        if (relevant.length === 0) continue;
        fs.mkdirSync(files.dir, { recursive: true });
        fs.writeFileSync(path, rebuildRawSection(readFileSafe(path), relevant));
        touched += relevant.length;
      }
    } finally {
      store.releaseCraftFoldLease(files.slug, holder);
    }
  }

  return touched;
}

/**
 * mise.md's content as any dispatch should see it — purely derived from the DB
 * (Store.allMiseCraftNotes), never from the file (hands#114/#223): this is what makes it
 * convergent across worktrees regardless of which one's file happens to be current, or whether
 * an export has ever run at all.
 */
export function readMiseMerged(store: Store, slug: string, cap = 6000): string | null {
  let text: string | null = null;
  for (const note of store.allMiseCraftNotes(slug)) text = upsertMiseLine(text, note.body);
  return capText(text, cap);
}

/**
 * book.md's or skill.md's content as any dispatch should see it: the file's stable prefix plus a
 * freshly rebuilt raw-notes section from every currently-pending note for `target` — convergent
 * for the same reason readMiseMerged is (hands#114/#223). `pending` is the full pending set for
 * the slug (any mix of kinds); this filters to `target` itself.
 */
export function readRawMerged(
  path: string,
  pending: readonly CraftNoteRow[],
  target: "book" | "skill",
  cap = 6000,
): string | null {
  const rebuilt = rebuildRawSection(readFileSafe(path), forTarget(pending, target));
  return capText(rebuilt || null, cap);
}

export const FOLD_INSTRUCTIONS =
  "Distill: rewrite the book/skill IN PLACE from the pending notes below plus what's already " +
  "there — never append. The book/skill text you were given already contains a " +
  "`## Raw notes (unfolded)` section (the same entries listed in pendingNotes below) — fold them " +
  "into the curated prose above, then remove that section entirely as part of your rewrite. " +
  "Placement rule: a sequence of steps is SKILL; a decision, a why, or a fact is BOOK. (mise.md " +
  "maintains itself automatically now — nothing to do there unless correcting something wrong.) " +
  "Discard notes that merely restate what's already written — that discard step is what keeps a " +
  "craft from turning into a growing log instead of a distillation. Keep the book ≤150 lines. " +
  "Stamp the header when done: `> covers: <domains> · distilled: <today> from <n> learnings`. " +
  "Then run `hands craft fold-done <craft> --through <n>` with the same throughNoteId this printed.";

export interface FoldContext {
  craftSlug: string;
  scope: CraftScope;
  book: string | null;
  mise: string | null;
  skill: string | null;
  bookPath: string;
  misePath: string;
  skillPath: string;
  pendingNotes: Array<{ id: number; kind: string; body: string; sourceAgent: string; spilloverCraft: string | null }>;
  throughNoteId: number;
  instructions: string;
}

/**
 * Read everything a fold pass needs — called after the caller has already acquired the fold
 * lease with `holder`. `holder` MUST be the same identity used for that lease acquisition:
 * exportPendingCraftNotes's book/skill writes reacquire the SAME lease key
 * (`acquireCraftFoldLease` is reentrant for a matching holder, not for a different one), so a
 * mismatched holder here would make every book/skill export silently look like contention.
 */
export function buildFoldContext(
  store: Store,
  craft: string,
  holder: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): FoldContext {
  const files = craftFiles(craft, env, cwd);
  // Force every pending note (mise AND book/skill) into the file before reading it — hands#114/
  // #223's storage fix removed the per-dispatch immediate write, so without this the file could
  // be arbitrarily behind `pendingNotes`, breaking FOLD_INSTRUCTIONS' assumption that the two
  // already match. This also means pendingNotes below naturally excludes mise entries (they're
  // marked folded the instant they're mechanically applied) without any extra filtering.
  exportPendingCraftNotes(store, files, holder);
  const pending = store.pendingCraftNotes(files.slug);
  return {
    craftSlug: files.slug,
    scope: files.scope,
    book: readFileSafe(files.book),
    mise: readFileSafe(files.mise),
    skill: readFileSafe(files.skill),
    bookPath: files.book,
    misePath: files.mise,
    skillPath: files.skill,
    pendingNotes: pending.map((n) => ({
      id: n.id,
      kind: n.kind,
      body: n.body,
      sourceAgent: n.source_agent,
      spilloverCraft: n.spillover_craft,
    })),
    throughNoteId: pending.reduce((max, n) => Math.max(max, n.id), 0),
    instructions: FOLD_INSTRUCTIONS,
  };
}
