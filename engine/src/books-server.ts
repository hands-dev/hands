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
import { listProjects, syncPull } from "./remote.js";

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
  return project;
}

function listHandles(dir: string, project: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, "journal", project), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Dates with a rendered digest for one handle, newest first — from disk, matching what's actually readable (not the raw event log). */
function listDigestDates(dir: string, project: string, handle: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, "journal", project, handle))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse();
  } catch {
    return [];
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
          `books_list_projects / books_list_handles, then books_read_digest.`
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
      return asToolResult({ project: p, handle, days: listDigestDates(cfg.dir, p, handle) });
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
      const file = path.join(cfg.dir, "journal", p, handle, "README.md");
      try {
        return asToolResult({ project: p, handle, markdown: fs.readFileSync(file, "utf8") });
      } catch {
        return errorResult(`no index for ${p}/${handle} — check books_list_handles`);
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
      const file = path.join(cfg.dir, "journal", p, handle, `${date}.md`);
      try {
        return asToolResult({ project: p, handle, date, markdown: fs.readFileSync(file, "utf8") });
      } catch {
        return errorResult(`no digest for ${p}/${handle}/${date} — check books_list_days`);
      }
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
