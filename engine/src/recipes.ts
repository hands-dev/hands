import * as fs from "node:fs";
import * as path from "node:path";
import type { HandsConfig } from "./config.js";
import { type JournalEvent, recipesDir, sanitizeSegment } from "./remote.js";

/**
 * Menu + Recipes (hands#96/#137) — replaces `priorities.md`/`hands_priorities`. A recipe is a
 * principal-authored markdown file: one owner, no shared/personal tier split like crafts have.
 * State (`book` | `menu`) and rank live on the file's own header line — the same durable-judgment
 * pattern the crafts readiness gate (hands#92) already proved, not a new mechanism. "Only a few
 * menu items in play" is a filter + sort over that header, not a second table.
 *
 * Acceptance criteria are GitHub-flavored-markdown checkboxes under a fixed `## Acceptance
 * criteria` heading — the format the principal already writes fluently everywhere else, and
 * mechanically parseable (`- [ ]` / `- [x]`) without forcing structured Given/When/Then fields per
 * criterion. Deliberately gherkin-*flavored*: each criterion is one loosely Given/When/Then-shaped
 * sentence, not three separate form fields — over-structuring authoring is how a format gets
 * abandoned.
 *
 * Menu MEMBERSHIP OVER TIME is a derived read over the journal (`recipe.promoted`/`recipe.demoted`
 * events), not new storage — the current menu stays a cheap file-header scan (what the expo reads
 * every pass); "what was on the menu on day D" is a fold over history (menuOnDay, below), which is
 * not a hot path and can afford to walk the log.
 */

export type RecipeState = "book" | "menu";

export interface AcceptanceCriterion {
  text: string;
  done: boolean;
}

export interface Recipe {
  slug: string;
  state: RecipeState;
  /** only meaningful when state === "menu" */
  rank: number | null;
  title: string | null;
  criteria: AcceptanceCriterion[];
  criteriaDone: number;
  criteriaTotal: number;
}

const HEADER_RE = /^>\s*state:\s*(\w+)(?:\s*·\s*rank:\s*(\d+))?/;
const TITLE_RE = /^#\s+(.+)$/;
const CRITERIA_HEADING_RE = /^##\s*Acceptance criteria/i;
const SECTION_HEADING_RE = /^##\s/;
const CRITERION_RE = /^-\s*\[([ xX])\]\s*(.+)$/;

function readFileSafe(p: string): string | null {
  try {
    const body = fs.readFileSync(p, "utf8").trim();
    return body || null;
  } catch {
    return null;
  }
}

/** Parse one recipe file's content. A missing/empty file parses as a titleless, criterion-less `book`-state recipe — never throws. */
export function parseRecipe(slug: string, content: string | null): Recipe {
  if (!content) {
    return { slug, state: "book", rank: null, title: null, criteria: [], criteriaDone: 0, criteriaTotal: 0 };
  }
  const lines = content.split("\n");
  const titleLine = lines.find((l) => TITLE_RE.test(l.trim()));
  const title = titleLine ? (TITLE_RE.exec(titleLine.trim())?.[1]?.trim() ?? null) : null;
  const headerLine = lines.find((l) => l.trim().startsWith(">")) ?? "";
  const m = HEADER_RE.exec(headerLine.trim());
  const state: RecipeState = m?.[1] === "menu" ? "menu" : "book";
  const rank = state === "menu" && m?.[2] ? Number(m[2]) : null;

  const criteria: AcceptanceCriterion[] = [];
  let inCriteria = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (CRITERIA_HEADING_RE.test(line)) {
      inCriteria = true;
      continue;
    }
    if (inCriteria && SECTION_HEADING_RE.test(line)) {
      inCriteria = false;
      continue;
    }
    if (inCriteria) {
      const cm = CRITERION_RE.exec(line);
      if (cm) criteria.push({ text: cm[2]!.trim(), done: cm[1]!.toLowerCase() === "x" });
    }
  }
  return { slug, state, rank, title, criteria, criteriaDone: criteria.filter((c) => c.done).length, criteriaTotal: criteria.length };
}

/**
 * Stamp a recipe's state/rank onto its header line — mechanical, same edit shape as
 * `stampCraftReadiness`. `rank` is ignored (and dropped) unless `state` is `"menu"`. Inserts a
 * header line right after the title if none exists yet; prepends one if there's no title either.
 */
export function stampRecipeState(content: string, state: RecipeState, rank: number | null): string {
  const lines = content.split("\n");
  const newLine = `> state: ${state}${state === "menu" && rank != null ? ` · rank: ${rank}` : ""}`;
  const idx = lines.findIndex((l) => l.trim().startsWith(">"));
  if (idx !== -1) {
    lines[idx] = newLine;
    return lines.join("\n");
  }
  const titleIdx = lines.findIndex((l) => TITLE_RE.test(l.trim()));
  if (titleIdx !== -1) {
    lines.splice(titleIdx + 1, 0, newLine);
    return lines.join("\n");
  }
  return `${newLine}\n${content}`;
}

export interface RecipeFiles {
  dir: string;
  slug: string;
  path: string;
}

export function recipeFiles(
  name: string,
  config: HandsConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): RecipeFiles {
  const dir = recipesDir(config, env, cwd);
  const slug = sanitizeSegment(name, "unnamed");
  return { dir, slug, path: path.join(dir, `${slug}.md`) };
}

/** Every recipe on disk, book and menu alike — pure filesystem enumeration, no Store needed. */
export function listRecipes(
  config: HandsConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Recipe[] {
  const dir = recipesDir(config, env, cwd);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -".md".length))
    .map((slug) => parseRecipe(slug, readFileSafe(path.join(dir, `${slug}.md`))))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The current menu — `state: menu` recipes, ranked. This is the expo's hot-path read: a plain file-header scan, never the journal. */
export function currentMenu(recipes: Recipe[]): Recipe[] {
  return recipes.filter((r) => r.state === "menu").sort((a, b) => (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY));
}

/** A fresh charter stub for `/hands:recipe`/`hands recipe new` — identity + an empty criterion, never guessed content. */
export function newRecipeStub(title: string): string {
  return `# ${title}\n> state: book\n\n\n\n## Acceptance criteria\n- [ ] \n`;
}

/**
 * Menu membership as of the end of `day` (a "YYYY-MM-DD" UTC date key, matching `digest.ts`'s
 * `dayOf`) — a pure fold over journal events, oldest-first (the shape `readEvents` already
 * returns). NOT the hot path: this walks history on demand (`hands recipe history <date>`), while
 * `currentMenu` above never touches the journal at all.
 */
export function menuOnDay(events: readonly JournalEvent[], day: string): string[] {
  const cutoff = Date.parse(`${day}T23:59:59.999Z`);
  const onMenu = new Map<string, boolean>();
  for (const e of events) {
    if (e.ts > cutoff) break; // events are ts-sorted — nothing after this can matter
    if (e.type === "recipe.promoted" && typeof e.data.slug === "string") onMenu.set(e.data.slug, true);
    else if (e.type === "recipe.demoted" && typeof e.data.slug === "string") onMenu.set(e.data.slug, false);
  }
  return [...onMenu.entries()].filter(([, on]) => on).map(([slug]) => slug);
}
