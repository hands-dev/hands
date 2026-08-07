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
 * subagent-stop.ts into Store.insertCraftNote. Durability and visibility are
 * two different concerns, though: a note that only reaches the DB is durable
 * but invisible to the next dispatch's `hands craft mise`. So every note also
 * gets applied to the actual file the moment it's harvested
 * (applyImmediateCraftNote, below) — mechanically for mise.md (a key-value
 * upsert, no judgment needed) and as a durable, clearly-delimited raw append
 * for book.md/skill.md (real curation — discarding restatements, keeping the
 * book bounded — still needs a model, so it moves to a single predictable
 * trigger, `/hands:last-call`, instead of an ad hoc idle-wake fold; see
 * hands#118). `hands craft fold`/`fold-done` is what last-call runs to
 * distill the raw sections into curated prose, in place, never by appending.
 */

export interface CraftRosterEntry {
  slug: string;
  scope: CraftScope;
  covers: string | null;
  /** parsed from the book's header line; null = never distilled */
  distilled: string | null;
  pendingNotes: number;
}

const COVERS_RE = /^>\s*covers:\s*(.*?)\s*(?:·|$)/;
// Tolerates the pre-cutover header key too (hands#129-style parse tolerance) —
// a craft distilled for the first time under this build rewrites it to `distilled:`.
const DISTILLED_RE = /(?:distilled|last held):\s*(\S+)/;

export function parseCraftHeader(bookContent: string | null): { covers: string | null; distilled: string | null } {
  if (!bookContent) return { covers: null, distilled: null };
  const line = bookContent.split("\n").find((l) => l.trim().startsWith(">")) ?? "";
  return {
    covers: COVERS_RE.exec(line)?.[1]?.trim() || null,
    distilled: DISTILLED_RE.exec(line)?.[1] ?? null,
  };
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

/** Like readFileSafe, but capped — for handing content to a model or over the wire (dashboard). */
export function readCraftFileCapped(p: string, cap = 6000): string | null {
  const body = readFileSafe(p);
  if (!body) return null;
  const points = Array.from(body);
  return points.length <= cap ? body : `${points.slice(0, cap).join("")}\n…(truncated — trim this file)`;
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
      const { covers, distilled } = parseCraftHeader(readFileSafe(path.join(dir, `${slug}.md`)));
      seen.set(slug, { slug, scope, covers, distilled });
    }
  }
  return [...seen.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Whether `slug` (already resolved by `craftFiles` — so any `craft-` alias is already stripped)
 * is a real, founded craft, plus the full known-slug list for a "closest match" suggestion.
 * `hands craft brief` uses this to refuse an unknown slug loudly instead of silently writing a
 * phantom `craft_briefs` row (hands#165) — `mise`/`fold`/`promote`/`localize` have their own
 * existing checks (an open brief, a moved file count, a pending-note backlog) and don't need this.
 */
export function craftKnown(
  slug: string,
  config: HandsConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): { known: boolean; slugs: string[] } {
  const slugs = listCraftFiles(config, env, cwd).map((e) => e.slug);
  return { known: slugs.includes(slug), slugs };
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

/** The full roster across both tiers, enriched with each craft's pending-note count. */
export function listCrafts(
  store: Store,
  config: HandsConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): CraftRosterEntry[] {
  return listCraftFiles(config, env, cwd).map((e) => ({
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

function generatedCraftAgent(entry: CraftFileEntry): string {
  return `---
name: craft-${entry.slug}
description: ${entry.covers ?? entry.slug} — dispatch for any work in this craft's area (hands#81/#96). Generated by \`hands craft sync\` — do not hand-edit, edits are overwritten on the next sync.
---

You are the **${entry.slug}** craft, dispatched for one ticket-slice — not a generalist.

1. Run \`hands craft brief ${entry.slug} --task "<one line — what you were asked to do>"\` first
   — add \`--ticket <id>\` too if the caller's prompt names a ticket id you're working. This
   registers the dispatch and PRINTS a chit — the first line names your \`briefId\`, note it,
   you need it below. The chit may say \`Usage mode: low\` — honor it if so.
2. Invoke \`Skill({ skill: "craft-${entry.slug}" })\` — your operating manual. It tells you how to
   pull your current book/mise (\`hands craft mise <briefId>\`, from step 1) before you start.
3. Do the work the caller's prompt describes.
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
friction: <the book/skill/mise was wrong, or a check was slow>
spillover(<other-craft-slug>): <something you learned that belongs to a DIFFERENT craft>
\`\`\`

Zero or more mise/book/skill/friction/spillover lines, each one learning. "nothing-new: true" is
correct and welcome — never invent learnings to fill the block.
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
  const roster = listCraftFiles(config, env, cwd);
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
    const ready = fs.existsSync(craftAgentPath(targetDir, e.slug));
    // "brief-only" (not "not yet synced" — hands#167): this craft is fully dispatchable right
    // now via `hands craft brief`, just not through the one-call Agent-tool path yet. The old
    // wording read as "unavailable" and a generalist reasonably chose not to dispatch at all.
    return `- ${e.slug} [${e.scope}${ready ? "" : ", brief-only"}] — ${e.covers ?? "no covers stated yet"}${staleness}${pending}`;
  });
  const cap = 1500;
  let body = lines.join("\n");
  const points = Array.from(body);
  if (points.length > cap) body = `${points.slice(0, cap).join("")}\n…(see hands craft ls for the rest)`;
  const rate =
    dispatchRate && dispatchRate.ticketsFinished > 0
      ? `\nDispatch rate (7d): ${dispatchRate.ticketsWithCraftBrief} of ${dispatchRate.ticketsFinished} finished ticket(s) went through a craft.`
      : "";
  return (
    "\n\n## Crafts available (dispatch as sub-agents — don't do their work yourself)\n" +
    body +
    '\nSynced: Agent({ agentType: "craft-<slug>", prompt: "<task>" }) — e.g. "craft-' +
    `${entries[0]!.slug}" for the first one above; it briefs and equips itself. "brief-only" → run ` +
    "`hands craft brief <slug>` yourself — the BARE slug shown above, no `craft-` prefix " +
    "(add `--ticket <id>` if you're working one), then paste the printed chit into a " +
    "general-purpose Agent's prompt. `hands craft ls` gives the full roster on demand." +
    rate
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
    "friction: <the craft's book/skill/mise was wrong, or a check was slow — one line>",
    "spillover(<other-craft-slug>): <something you learned that belongs to a DIFFERENT craft>",
    "```",
    "Zero or more of mise/book/skill/friction/spillover lines, each is one learning. " +
      '"nothing-new: true" is a correct and welcome answer — never invent learnings to fill the block.',
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

export interface ParsedCraftNoteLine {
  kind: "mise" | "book" | "skill" | "friction" | "spillover";
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
const KV_RE = /^(mise|book|skill|friction):\s*(.+)$/;
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

function formatRawTaggedLine(note: CraftNoteRow): string {
  if (note.kind === "book") return `[book] ${note.body}`;
  if (note.kind === "friction") return `[friction] ${note.body}`;
  if (note.kind === "spillover") return `[spillover · from ${note.spillover_craft ?? "unknown"}] ${note.body}`;
  return note.body; // skill — untagged, the file itself supplies the type
}

const IMMEDIATE_WRITE_LEASE_TTL_MS = 15_000;

/**
 * Apply one harvested note to its craft's actual file, right now — best-effort, never the only
 * path to durability (the note is already journaled in craft_notes regardless). Returns false on
 * lease contention (a concurrent harvest, or a last-call distillation already holding the
 * book/skill lease); the caller should treat that as "fine, it'll be caught on the next pass,"
 * never as an error. mise gets its OWN lease key (`<slug>:mise`, same table+mechanism as the
 * book/skill fold lease, just a different resource id) so a long-running last-call rewrite of
 * book.md/skill.md never blocks a mise write — they don't touch the same file.
 */
export function applyImmediateCraftNote(store: Store, files: CraftFiles, note: CraftNoteRow, holder: string): boolean {
  if (note.kind === "mise") {
    const leaseKey = `${files.slug}:mise`;
    if (!store.acquireCraftFoldLease(leaseKey, holder, IMMEDIATE_WRITE_LEASE_TTL_MS)) return false;
    try {
      fs.mkdirSync(files.dir, { recursive: true });
      fs.writeFileSync(files.mise, upsertMiseLine(readFileSafe(files.mise), note.body));
      store.markCraftNoteFolded(note.id);
      return true;
    } finally {
      store.releaseCraftFoldLease(leaseKey, holder);
    }
  }

  const target = note.kind === "skill" ? files.skill : files.book;
  if (!store.acquireCraftFoldLease(files.slug, holder, IMMEDIATE_WRITE_LEASE_TTL_MS)) return false;
  try {
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(target, appendRawNote(readFileSafe(target), formatRawTaggedLine(note)));
    return true;
  } finally {
    store.releaseCraftFoldLease(files.slug, holder);
  }
}

/**
 * Catch-up sweep for any mise notes that missed their immediate write (lease contention at
 * harvest time) — belt-and-suspenders so a mise learning can never get permanently stuck. Called
 * from `hands craft fold` (via buildFoldContext) and, transitively, by last-call.
 */
export function applyPendingMiseNotes(store: Store, files: CraftFiles, holder: string): number {
  const pending = store.pendingCraftNotes(files.slug).filter((n) => n.kind === "mise");
  let applied = 0;
  for (const note of pending) {
    if (applyImmediateCraftNote(store, files, note, holder)) applied++;
  }
  return applied;
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

/** Read everything a fold pass needs — called after the caller has already acquired the lease. */
export function buildFoldContext(
  store: Store,
  craft: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): FoldContext {
  const files = craftFiles(craft, env, cwd);
  // Catch up any mise notes that missed their immediate write at harvest time (lease
  // contention) — never leaves a mise learning permanently stuck, and means pendingNotes below
  // naturally excludes mise entries without any extra filtering.
  applyPendingMiseNotes(store, files, `fold-catchup:${process.pid}`);
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
