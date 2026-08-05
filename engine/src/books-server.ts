#!/usr/bin/env node
/**
 * hands-books — a read-only stdio MCP server for browsing the books (the
 * durable journal) from any MCP client, including Claude Desktop, where the
 * process never runs from inside the source repo.
 *
 * Deliberately independent of `Store`/`node:sqlite` (no write side effect on
 * open, no Node >=22.5 floor) and of cwd/git-based identity (`hands mcp
 * install` resolves the journal clone dir + project once, from inside the
 * repo, and bakes them into the HANDS_BOOKS_DIR / HANDS_BOOKS_PROJECT env
 * vars on the client's server registration — this process reads those env
 * vars only, never git or hands.config.json).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listProjects, sanitizeSegment, syncPull } from "./remote.js";

function asToolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: string) {
  return { ...asToolResult({ ok: false, error }), isError: true };
}

export interface BooksConfig {
  /** local git clone of the books repo (a `hands.json`-marked journal root) */
  dir: string;
  /** default project key; tools may still be called with an explicit `project` */
  project: string | null;
}

const NOT_CONFIGURED =
  "not configured — HANDS_BOOKS_DIR is unset. Run `hands mcp install` from the repo whose " +
  "books you want to browse (requires books already attached via `hands books <url>`).";

export function resolveBooksConfig(env: NodeJS.ProcessEnv = process.env): BooksConfig | null {
  const dir = env.HANDS_BOOKS_DIR?.trim();
  if (!dir) return null;
  return { dir, project: env.HANDS_BOOKS_PROJECT?.trim() || null };
}

function requireProject(cfg: BooksConfig, input?: string): string | { error: string } {
  const project = input?.trim() || cfg.project;
  if (!project) return { error: "no project given and HANDS_BOOKS_PROJECT is not set — pass `project`" };
  return sanitizeSegment(project);
}

/**
 * Resolve `journal/<segments...>` under `dir`, guaranteed to stay inside it.
 * This is a read-only MCP server reachable by any connected client (tool
 * arguments may be adversarial, including prompt-injection-driven calls), so
 * every path segment built from tool input is untrusted. `sanitizeSegment`
 * (the codebase's standard guard — strips path separators, so a single
 * segment can never smuggle a "/") already makes escape impossible on its
 * own; the resolved-path containment check is belt-and-suspenders on top of
 * that, in case a future segment reaches here unsanitized.
 */
export function journalPath(dir: string, ...segments: string[]): string | null {
  const root = path.resolve(dir, "journal");
  const full = path.resolve(root, ...segments.map((s) => sanitizeSegment(s)));
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return null;
  return full;
}

function listHandles(dir: string, project: string): string[] {
  const p = journalPath(dir, project);
  if (!p) return [];
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Dates with a rendered digest for one handle, newest first — from disk, matching what's actually readable (not the raw event log). */
function listDigestDates(dir: string, project: string, handle: string): string[] {
  const p = journalPath(dir, project, handle);
  if (!p) return [];
  try {
    return fs
      .readdirSync(p)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Craft slugs one handle holds, derived from its crafts/ dir (a slug may have a book, a skill, or both). */
function listCraftSlugs(dir: string, project: string, handle: string): string[] {
  const p = journalPath(dir, project, handle, "crafts");
  if (!p) return [];
  try {
    const files = fs.readdirSync(p);
    const slugs = new Set(
      files
        .filter((f) => f.endsWith(".md"))
        .map((f) => (f.endsWith(".skill.md") ? f.slice(0, -".skill.md".length) : f.slice(0, -".md".length))),
    );
    return [...slugs].sort();
  } catch {
    return [];
  }
}

function readCraftFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function buildBooksServer(cfg: BooksConfig | null): McpServer {
  const server = new McpServer(
    { name: "hands-books", version: "0.1.0" },
    {
      instructions: cfg
        ? `Read-only browser for the hands books — a durable journal of kitchen activity. Scoped ` +
          `to ${cfg.dir}${cfg.project ? ` (default project "${cfg.project}")` : ""}. Digests are ` +
          `pre-rendered markdown, one per contributor per day; message bodies are never included ` +
          `(a content policy of the books themselves, not this server). Start with ` +
          `books_list_projects / books_list_handles, then books_read_digest. books_list_crafts / ` +
          `books_read_craft browse every handle's crafts in the project (the shared roster read — ` +
          `each kitchen still writes only its own copy).`
        : NOT_CONFIGURED,
    },
  );

  server.registerTool(
    "books_list_projects",
    {
      title: "List projects in the books",
      description: "Project keys (code repos) present in this books clone.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      if (!cfg) return errorResult(NOT_CONFIGURED);
      return asToolResult({ projects: listProjects(cfg.dir), default: cfg.project });
    },
  );

  server.registerTool(
    "books_list_handles",
    {
      title: "List contributors (handles) for a project",
      description: "Handles (contributors) with a namespace under the given project.",
      inputSchema: { project: z.string().optional().describe("defaults to HANDS_BOOKS_PROJECT") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ project }) => {
      if (!cfg) return errorResult(NOT_CONFIGURED);
      const p = requireProject(cfg, project);
      if (typeof p !== "string") return errorResult(p.error);
      return asToolResult({ project: p, handles: listHandles(cfg.dir, p) });
    },
  );

  server.registerTool(
    "books_list_days",
    {
      title: "List digest days for a handle",
      description: "Dates (YYYY-MM-DD) with a rendered digest for one handle, newest first.",
      inputSchema: {
        handle: z.string(),
        project: z.string().optional().describe("defaults to HANDS_BOOKS_PROJECT"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ handle, project }) => {
      if (!cfg) return errorResult(NOT_CONFIGURED);
      const p = requireProject(cfg, project);
      if (typeof p !== "string") return errorResult(p.error);
      const h = sanitizeSegment(handle);
      return asToolResult({ project: p, handle: h, days: listDigestDates(cfg.dir, p, h) });
    },
  );

  server.registerTool(
    "books_read_index",
    {
      title: "Read a handle's digest index",
      description: "The per-handle README.md — a newest-first index of digest days with one-line summaries.",
      inputSchema: {
        handle: z.string(),
        project: z.string().optional().describe("defaults to HANDS_BOOKS_PROJECT"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ handle, project }) => {
      if (!cfg) return errorResult(NOT_CONFIGURED);
      const p = requireProject(cfg, project);
      if (typeof p !== "string") return errorResult(p.error);
      const h = sanitizeSegment(handle);
      // journalPath sanitizes EVERY segment (lowercases among other things),
      // which is right for user-controlled path/handle but corrupts a
      // hardcoded literal filename with real uppercase letters — resolve the
      // handle dir through the traversal guard, then join the literal name.
      const handleDir = journalPath(cfg.dir, p, h);
      try {
        if (!handleDir) throw new Error("path escaped the journal root");
        const file = path.join(handleDir, "README.md");
        return asToolResult({ project: p, handle: h, markdown: fs.readFileSync(file, "utf8") });
      } catch {
        return errorResult(`no index for ${p}/${h} — check books_list_handles`);
      }
    },
  );

  server.registerTool(
    "books_read_digest",
    {
      title: "Read one day's digest",
      description: "One handle's rendered digest markdown for one date (YYYY-MM-DD).",
      inputSchema: {
        handle: z.string(),
        date: z.string().describe("YYYY-MM-DD"),
        project: z.string().optional().describe("defaults to HANDS_BOOKS_PROJECT"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ handle, date, project }) => {
      if (!cfg) return errorResult(NOT_CONFIGURED);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errorResult("date must be YYYY-MM-DD");
      const p = requireProject(cfg, project);
      if (typeof p !== "string") return errorResult(p.error);
      const h = sanitizeSegment(handle);
      const file = journalPath(cfg.dir, p, h, `${date}.md`);
      try {
        if (!file) throw new Error("path escaped the journal root");
        return asToolResult({ project: p, handle: h, date, markdown: fs.readFileSync(file, "utf8") });
      } catch {
        return errorResult(`no digest for ${p}/${h}/${date} — check books_list_days`);
      }
    },
  );

  server.registerTool(
    "books_list_crafts",
    {
      title: "List crafts across handles",
      description:
        "Every craft slug held by any handle in the project — the shared craft roster read " +
        "(each kitchen still writes only its own copy; see books_read_craft for the content).",
      inputSchema: { project: z.string().optional().describe("defaults to HANDS_BOOKS_PROJECT") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ project }) => {
      if (!cfg) return errorResult(NOT_CONFIGURED);
      const p = requireProject(cfg, project);
      if (typeof p !== "string") return errorResult(p.error);
      const crafts = listHandles(cfg.dir, p).flatMap((handle) =>
        listCraftSlugs(cfg.dir, p, handle).map((slug) => ({ handle, slug })),
      );
      return asToolResult({ project: p, crafts });
    },
  );

  server.registerTool(
    "books_read_craft",
    {
      title: "Read one handle's craft book + skill",
      description: "A craft's prep book and skill file for one handle — either half may be null if that file doesn't exist.",
      inputSchema: {
        handle: z.string(),
        slug: z.string().describe('craft slug, e.g. from books_list_crafts — "ordering-api"'),
        project: z.string().optional().describe("defaults to HANDS_BOOKS_PROJECT"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ handle, slug, project }) => {
      if (!cfg) return errorResult(NOT_CONFIGURED);
      const p = requireProject(cfg, project);
      if (typeof p !== "string") return errorResult(p.error);
      const h = sanitizeSegment(handle);
      const s = sanitizeSegment(slug);
      const craftsDir = journalPath(cfg.dir, p, h, "crafts");
      if (!craftsDir) return errorResult(`no craft "${s}" for ${p}/${h} — check books_list_crafts`);
      const book = readCraftFile(path.join(craftsDir, `${s}.md`));
      const skill = readCraftFile(path.join(craftsDir, `${s}.skill.md`));
      if (book === null && skill === null) {
        return errorResult(`no craft "${s}" for ${p}/${h} — check books_list_crafts`);
      }
      return asToolResult({ project: p, handle: h, slug: s, book, skill });
    },
  );

  server.registerTool(
    "books_sync",
    {
      title: "Pull the latest books",
      description: "Fetch + integrate the latest from the books remote into the local clone (read-only towards the remote — this never pushes).",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      if (!cfg) return errorResult(NOT_CONFIGURED);
      return asToolResult(syncPull(cfg.dir));
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildBooksServer(resolveBooksConfig());
  await server.connect(new StdioServerTransport());
}

// Only run when executed directly (not when imported by tests) — same idiom as server.ts.
const invokedDirectly = (() => {
  if (process.env.HANDS_FORCE_MAIN === "1") return true;
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    const entry = pathToFileURL(fs.realpathSync(argv1)).href;
    const self = pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;
    return entry === self;
  } catch {
    return import.meta.url === pathToFileURL(argv1).href;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[hands-books] fatal:", err);
    process.exit(1);
  });
}
