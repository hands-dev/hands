import * as fs from "node:fs";
import * as path from "node:path";
import type { HandsConfig } from "./config.js";
import { type CraftScope, craftFiles, personalCraftsDir, sanitizeSegment, sharedCraftsDir } from "./remote.js";
import type { CraftBriefRow, Store } from "./store.js";

/**
 * Crafts as sub-agent-deployed specializations (hands#81/#96/#49). A craft is
 * PULLED into a short-lived sub-agent at spawn time (hands_brief → hands_mise)
 * rather than pushed into a long-lived station — see server.ts's
 * craftRosterContext() for the (small, roster-only) content stations/expo get
 * injected at connect, and the new hands_brief/hands_mise/hands_fold/
 * hands_fold_done MCP tools for the actual deploy/return loop.
 *
 * Sub-agents never write craft files directly — they append notes
 * (Store.insertCraftNote); a single leased fold pass (Store.acquireCraftFoldLease
 * + hands_fold/hands_fold_done) distills pending notes into the book/mise/skill,
 * in place, never by appending to the files themselves.
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

function readFileSafe(p: string): string | null {
  try {
    const body = fs.readFileSync(p, "utf8").trim();
    return body || null;
  } catch {
    return null;
  }
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

/** The full roster across both tiers — shared wins a slug collision (matches craftFiles()'s own resolution). */
export function listCrafts(
  store: Store,
  config: HandsConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): CraftRosterEntry[] {
  const shared = sharedCraftsDir(config, cwd);
  const personal = personalCraftsDir(config, env, cwd);
  const seen = new Map<string, CraftRosterEntry>();
  for (const [dir, scope] of [
    [shared, "shared"] as const,
    [personal, "personal"] as const,
  ]) {
    for (const slug of listSlugsIn(dir)) {
      if (seen.has(slug) || !dir) continue;
      const { covers, distilled } = parseCraftHeader(readFileSafe(path.join(dir, `${slug}.md`)));
      seen.set(slug, { slug, scope, covers, distilled, pendingNotes: store.pendingCraftNotes(slug).length });
    }
  }
  return [...seen.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The roster injected into every station's AND the expo's MCP instructions at
 * connect (server.ts's craftRosterContext) — a summary, not content, so the
 * orchestrator's own context cost stays constant regardless of how fat a book
 * gets. Capped like the old per-file craftContext() injection was.
 */
export function formatRosterContext(entries: CraftRosterEntry[]): string {
  if (entries.length === 0) {
    return (
      "\n\nNo crafts founded yet. Crafts are dispatched as sub-agents (hands_brief), not held — " +
      "found one via /hands:crafts only for a durable, recurring beat."
    );
  }
  const lines = entries.map((e) => {
    const staleness = e.distilled ? "" : " (never distilled)";
    const pending = e.pendingNotes ? ` · ${e.pendingNotes} pending note(s)` : "";
    return `- craft-${e.slug} [${e.scope}] — ${e.covers ?? "no covers stated yet"}${staleness}${pending}`;
  });
  const cap = 1500;
  let body = lines.join("\n");
  const points = Array.from(body);
  if (points.length > cap) body = `${points.slice(0, cap).join("")}\n…(see hands_crafts for the rest)`;
  return (
    "\n\n## Crafts available (dispatch as sub-agents — don't do their work yourself)\n" +
    body +
    '\nDispatch: hands_brief({ craft: "<slug>" }), paste the returned chit into the Agent tool\'s ' +
    "prompt. Read-only (plan mode) only for now. hands_crafts gives the full roster on demand."
  );
}

/** The ~16-line pointer an orchestrator pastes into the Agent tool's `prompt` — never the craft's content itself. */
export function composeChit(brief: CraftBriefRow, covers: string | null): string {
  const lines = [
    `You are carrying the craft "${brief.craft_slug}" (brief #${brief.id}, mode: ${brief.mode}) for this one turn.`,
    covers ? `Covers: ${covers}` : null,
    "",
    `FIRST ACTION, before anything else: call hands_mise({ briefId: ${brief.id} }).`,
    "  Fallback if that tool is unavailable: Read these files, in this order — the craft's " +
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

export const FOLD_INSTRUCTIONS =
  "Distill: rewrite the book/mise/skill IN PLACE from the pending notes below plus what's already " +
  "there — never append. Placement rule: a path or command is MISE; a sequence of steps is SKILL; a " +
  "decision, a why, or a fact is BOOK. Discard notes that merely restate what's already written — " +
  "that discard step is what keeps a craft from turning into a growing log instead of a " +
  "distillation. Keep the book ≤150 lines. Stamp the header when done: " +
  "`> covers: <domains> · distilled: <today> from <n> learnings`. Then call hands_fold_done with " +
  "the same throughNoteId this call returned.";

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
