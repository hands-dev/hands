import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { repoInfo } from "./paths.js";

/**
 * The launcher's kitchen registry — `~/.hands/projects.json`.
 *
 * Machine-wide, not per-repo: `hands ampersand` has to resolve a name from
 * anywhere on the box, including from outside any git repo, so this cannot
 * live in a repo's coordination dir. Same reasoning (and the same file
 * conventions) as `credentials.ts` — see its header for why `~/.hands/` rather
 * than `~/.claude/`.
 *
 * Deliberately a registry rather than a directory scan: scanning guesses, and
 * a wrong guess sends the principal's session to the wrong repo. Kitchens
 * enroll themselves at `hands init` time, or explicitly via `hands register`.
 */
export interface ProjectEntry {
  /** resolution key — defaults to the basename of repoRoot */
  name: string;
  repoRoot: string;
  /** from repoInfo() — disambiguates same-named repos in the books and the bus */
  slug: string;
  registeredAt: number;
}

export interface ProjectRegistry {
  projects: ProjectEntry[];
}

export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HANDS_TEST_HOME?.trim() || os.homedir();
  return path.join(home, ".hands", "projects.json");
}

/**
 * Returns an empty registry on any read/parse failure. "Absent" and "corrupt"
 * are handled identically — both mean "nothing resolves, re-register" — so
 * callers never branch on which it was.
 */
export function readRegistry(env: NodeJS.ProcessEnv = process.env): ProjectRegistry {
  try {
    const raw = fs.readFileSync(registryPath(env), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { projects: [] };
    const list = (parsed as Record<string, unknown>).projects;
    if (!Array.isArray(list)) return { projects: [] };
    return { projects: list.filter(isProjectEntry) };
  } catch {
    return { projects: [] };
  }
}

function isProjectEntry(value: unknown): value is ProjectEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.repoRoot === "string" &&
    typeof v.slug === "string" &&
    typeof v.registeredAt === "number"
  );
}

export function writeRegistry(
  registry: ProjectRegistry,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = registryPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Enroll (or re-point) a kitchen. Idempotent by name: re-registering an
 * existing name updates its paths rather than adding a duplicate, so moving a
 * repo and re-running `hands register` heals the entry.
 *
 * Returns null when `cwd` isn't a git repo — the caller decides whether that's
 * an error (explicit `hands register`) or a silent skip (`hands init` outside
 * a repo, which already warns on its own).
 */
export function registerProject(
  cwd: string = process.cwd(),
  opts?: { name?: string; env?: NodeJS.ProcessEnv; now?: number },
): ProjectEntry | null {
  const info = repoInfo(cwd);
  if (!info) return null;
  const env = opts?.env ?? process.env;
  const entry: ProjectEntry = {
    name: opts?.name?.trim() || path.basename(info.repoRoot),
    repoRoot: info.repoRoot,
    slug: info.slug,
    registeredAt: opts?.now ?? Date.now(),
  };
  const registry = readRegistry(env);
  const others = registry.projects.filter((p) => p.name !== entry.name);
  writeRegistry({ projects: [...others, entry] }, env);
  return entry;
}

/**
 * Exact-match resolution. Entries whose repoRoot no longer exists are pruned
 * rather than returned — a kitchen that was deleted or moved should read as
 * "not found" (and re-register), never as a path that fails later inside a
 * spawned session where the error is much harder to trace.
 */
export function resolveProject(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectEntry | null {
  const match = readRegistry(env).projects.find((p) => p.name === name);
  if (!match) return null;
  if (!fs.existsSync(match.repoRoot)) {
    pruneMissing(env);
    return null;
  }
  return match;
}

/** Drop entries whose repoRoot is gone. Called on a resolution miss; safe to call anytime. */
export function pruneMissing(env: NodeJS.ProcessEnv = process.env): number {
  const registry = readRegistry(env);
  const live = registry.projects.filter((p) => fs.existsSync(p.repoRoot));
  const dropped = registry.projects.length - live.length;
  if (dropped > 0) writeRegistry({ projects: live }, env);
  return dropped;
}

/**
 * Registered kitchens, name-sorted — backs `hands register` output and, later, `hands ls`.
 * Named `listRegisteredProjects`, not `listProjects`: `remote.ts` already exports
 * `listProjects` for kitchens visible in the BOOKS, which is a different set.
 */
export function listRegisteredProjects(env: NodeJS.ProcessEnv = process.env): ProjectEntry[] {
  return readRegistry(env).projects.slice().sort((a, b) => a.name.localeCompare(b.name));
}
