import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { repoInfo } from "./paths.js";
import { openJournal, syncPull, validateJournal } from "./remote.js";

/**
 * `hands mcp install` — bridges the live, cwd/git-derived bus config to a
 * standalone MCP server registration a client outside the repo (Claude
 * Desktop) can run. Resolution happens once, here, inside the repo; the
 * books server itself (books-server.ts) never re-derives identity from cwd.
 */

export interface BooksMcpTarget {
  /** local git clone of the books repo */
  dir: string;
  project: string;
  handle: string;
  url: string;
}

export type ResolveBooksTargetResult =
  | { ok: true; target: BooksMcpTarget }
  | { ok: false; reason: string };

const NO_BOOKS_REASON = "books are unavailable in this environment — git isn't working (run: hands doctor)";

/**
 * Resolve + freshen the local journal clone for this repo's books MCP. Must
 * run inside the repo (cwd-based, same precondition as `hands books`/`hands
 * restore`). `remote.url` may be a real git URL or a plain local filesystem
 * path — git treats both as valid remotes, so no special-casing is needed
 * beyond not assuming a network fetch will succeed.
 */
export function resolveBooksTarget(opts?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ResolveBooksTargetResult {
  const cwd = opts?.cwd ?? process.cwd();
  const env = opts?.env ?? process.env;
  if (!repoInfo(cwd)) {
    return { ok: false, reason: "not inside a git repo — run from your repo's main checkout" };
  }
  const config = loadConfig({ cwd, env });

  const j = openJournal({ cwd, env, config });
  if (!j) return { ok: false, reason: NO_BOOKS_REASON };
  if (!fs.existsSync(path.join(j.dir, ".git"))) {
    return { ok: false, reason: `could not set up the journal clone at ${j.dir}` };
  }
  syncPull(j.dir); // best-effort freshen — offline or a not-yet-pushed local path just leaves the existing clone as-is
  const shape = validateJournal(j.dir);
  if (!shape.ok) return { ok: false, reason: shape.reason ?? "journal repo failed validation" };
  return { ok: true, target: { dir: j.dir, project: j.project, handle: j.handle, url: j.url } };
}

/**
 * Locate the bundled books-server entry next to the running CLI module
 * (plugin/dist in an installed plugin) — falls back to the committed
 * plugin/dist copy for a dev `tsx src/cli.ts` checkout, where this module's
 * own directory is engine/src, not a bundle output dir.
 */
export function resolveBooksServerEntry(
  here: string = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
  const bundled = path.join(here, "books-server.mjs");
  if (fs.existsSync(bundled)) return bundled;
  const devFallback = path.resolve(here, "..", "..", "plugin", "dist", "books-server.mjs");
  if (fs.existsSync(devFallback)) return devFallback;
  return null;
}

/**
 * Locate the bundled hands MCP server entry (the Node-floor-checked wrapper,
 * same file Claude Code itself spawns per plugin/mcp.json) next to the
 * running CLI module — falls back to the committed plugin/dist copy for a
 * dev `tsx src/cli.ts` checkout, same shape as resolveBooksServerEntry above.
 */
export function resolveHandsServerEntry(
  here: string = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
  const bundled = path.join(here, "server.mjs");
  if (fs.existsSync(bundled)) return bundled;
  const devFallback = path.resolve(here, "..", "..", "plugin", "dist", "server.mjs");
  if (fs.existsSync(devFallback)) return devFallback;
  return null;
}

/**
 * Locate the Claude Agent SDK's entry point in engine/node_modules — dev
 * checkout only, deliberately. Its platform optional-dependency vendors a
 * ~280MB copy of the `claude` CLI binary, which cannot be esbuild-bundled or
 * committed into plugin/dist (that bundle is a plain, npm-install-free copy
 * on every plugin install). So the dashboard chat feature only lights up
 * when hands is run from a source checkout with `npm install` already done
 * in engine/ — never from a marketplace/plugin-cache install. Both call
 * sites (`tsx src/...` dev execution, and the bundled plugin/dist/*.mjs
 * output) sit exactly two directories below the repo root, so one relative
 * path resolves correctly from either.
 */
export function resolveAgentSdkEntry(
  here: string = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
  const devOnly = path.resolve(here, "..", "..", "engine", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
  if (fs.existsSync(devOnly)) return devOnly;
  return null;
}

export function desktopConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HANDS_TEST_DESKTOP_CONFIG?.trim();
  if (override) return override;
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function serverName(project: string): string {
  return `hands-books-${project}`;
}

export function booksMcpEntry(serverEntryPath: string, target: BooksMcpTarget): McpServerEntry {
  return {
    command: "node",
    args: ["--no-warnings", serverEntryPath],
    env: { HANDS_BOOKS_DIR: target.dir, HANDS_BOOKS_PROJECT: target.project },
  };
}

/**
 * Merge one server entry into a Claude Desktop-style config file, creating
 * it if absent. An existing file that fails to parse is left untouched and
 * reported — never silently reset, which would drop the user's other
 * configured MCP servers.
 */
export function writeDesktopConfig(
  configPath: string,
  name: string,
  entry: McpServerEntry,
): { ok: true } | { ok: false; reason: string } {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, reason: `${configPath} is not valid JSON — fix or remove it, then retry (${String(err)})` };
    }
  }
  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === "object"
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};
  servers[name] = entry;
  parsed.mcpServers = servers;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { ok: true };
}
