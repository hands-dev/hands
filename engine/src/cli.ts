#!/usr/bin/env node
/**
 * hands CLI — provisioning + setup. The user thinks in stations:
 *
 *   hands init                per-repo config scaffold
 *   hands books <url>         attach the books (durable journal) to this repo's config
 *   hands station add [-n N]   open N stations (worktree hidden inside)
 *   hands station ls           list this repo's stations
 *   hands station rm <id>      retire a station (idempotent; --force discards)
 *   hands scale <N>           reconcile the brigade to exactly N stations
 *   hands restore             rebuild local bus state from the remote journal
 *   hands sync                push pending journal appends now
 *   hands mcp install         install a read-only books MCP for Claude Desktop
 *   hands login               sign in with GitHub (optional — free tier never needs it)
 *   hands logout              clear the local sign-in
 *   hands whoami               show the signed-in identity (local only, no network call)
 *   hands paths               where this cwd resolves (debug)
 *
 * The MCP server, hooks, and skills are registered by the PLUGIN; this bin is
 * the human/expo-facing lifecycle tool (on the Bash PATH via plugin/bin).
 */
import * as os from "node:os";
import { CONFIG_BASENAME, loadConfig } from "./config.js";
import { resolveAgentId } from "./identity.js";
import { dbPath, repoInfo } from "./paths.js";
import { pathsReport } from "./server.js";
import {
  addStations,
  type LaunchPlan,
  listStations,
  ProvisionError,
  removeStation,
  scaleStations,
} from "./provision.js";
import { regenerateDigests } from "./digest.js";
import {
  githubUsername,
  listProjects,
  openJournal,
  readEvents,
  replayInto,
  syncPull,
  syncPush,
  validateJournal,
} from "./remote.js";
import {
  booksMcpEntry,
  desktopConfigPath,
  resolveBooksServerEntry,
  resolveBooksTarget,
  serverName,
  writeDesktopConfig,
} from "./mcp-install.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store.js";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`hands: ${message}\n`);
  process.exit(1);
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function intOpt(argv: string[], name: string, fallback: number): number {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = Number.parseInt(argv[i + 1] ?? "", 10);
  if (!Number.isInteger(v) || v < 0) fail(`${name} needs a non-negative integer`);
  return v;
}

function reportPlans(plans: LaunchPlan[]): void {
  for (const p of plans) {
    if (p.launched) {
      out(`✔ ${p.id} up (${p.model}, via ${p.launcher})`);
    } else {
      out(`● ${p.id} provisioned (${p.model}) — start it by pasting into a new terminal:`);
      out(`    ${p.command}`);
    }
  }
}

function cmdStation(argv: string[]): void {
  const sub = argv[0];
  if (sub === "add") {
    const n = intOpt(argv, "-n", 1);
    const plans = addStations(n);
    if (plans.length === 0) out("nothing to add");
    reportPlans(plans);
    out(`\nStations register with the expo on their first turn (hands_peers to check).`);
    return;
  }
  if (sub === "ls") {
    const stations = listStations();
    if (stations.length === 0) {
      out("no stations — open some: hands station add -n 2");
      return;
    }
    for (const w of stations) out(`${w.id}\t${w.branch}\t${w.dir}`);
    return;
  }
  if (sub === "rm") {
    const id = argv[1];
    if (!id || id.startsWith("-")) fail("usage: hands station rm station-<n> [--force]");
    const res = removeStation(id, { force: flag(argv, "--force") });
    // No craft bookkeeping here: the craft outlives the seat — closing a
    // station is not a craft event. Its files stay on the roster untouched.
    out(res.removed ? `✔ ${id} retired` : `${id} was not provisioned (nothing to do)`);
    return;
  }
  fail("usage: hands station <add|ls|rm>");
}

function cmdScale(argv: string[]): void {
  const target = Number.parseInt(argv[0] ?? "", 10);
  if (!Number.isInteger(target) || target < 0) fail("usage: hands scale <N>");
  const { added, removed } = scaleStations(target, { force: flag(argv, "--force") });
  reportPlans(added);
  for (const id of removed) out(`✔ ${id} retired`);
  if (added.length === 0 && removed.length === 0) out(`already at ${target} stations`);
}

/**
 * Attach (or inspect) the books — the durable journal — on this repo's
 * existing config. `hands init` covers the fresh-scaffold path; this is
 * the "I set up the kitchen first, books later" path.
 */
function cmdBooks(argv: string[]): void {
  const info = repoInfo(process.cwd());
  if (!info) fail("not inside a git repo — run from your repo's main checkout");
  const configPath = path.join(info.repoRoot, CONFIG_BASENAME);
  if (!fs.existsSync(configPath)) fail(`no ${CONFIG_BASENAME} here — run: hands init`);

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    fail(`${configPath} is not valid JSON: ${String(err)}`);
  }
  const remote = (cfg.remote ?? {}) as Record<string, unknown>;

  const url = argv.find((a) => !a.startsWith("--"));
  if (!url) {
    if (typeof remote.url === "string" && remote.url) {
      out(`books: ${remote.url} (handle "${String(remote.handle ?? os.userInfo().username)}")`);
    } else {
      out("no books attached — attach with: hands books <private-git-url> [--handle <name>]");
    }
    return;
  }

  const hi = argv.indexOf("--handle");
  const handleArg =
    hi !== -1 ? argv[hi + 1] : argv.find((a) => a.startsWith("--handle="))?.slice("--handle=".length);
  cfg.remote = {
    ...remote,
    url,
    handle: handleArg ?? remote.handle ?? githubUsername() ?? os.userInfo().username,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  out(`✔ books attached: ${url} (handle "${String((cfg.remote as Record<string, unknown>).handle)}")`);
  out("  next: hands sync   (initializes the journal; --adopt if the repo is non-empty)");
  out("  (restart running Claude Code sessions so the bus picks up the config change)");
}

function requireRemote() {
  const j = openJournal();
  if (!j) {
    fail("no books attached — run: hands books git@github.com:you/hands-books.git");
  }
  if (!fs.existsSync(path.join(j.dir, ".git"))) fail(`could not set up the journal clone at ${j.dir}`);
  return j;
}

/** Pull the remote journal and materialize this project+handle's events into the local bus. */
function cmdRestore(): void {
  const { dir, project, handle } = requireRemote();
  const pulled = syncPull(dir);
  if (!pulled.ok) fail(`could not pull the journal remote (${pulled.reason ?? "unknown"}; an empty repo is fine, a failed fetch is not)`);
  const shape = validateJournal(dir); // read mode: layout-version gate only
  if (!shape.ok) fail(shape.reason ?? "journal repo failed validation");
  const events = readEvents(dir, project, handle);
  if (events.length === 0) {
    out(`no events for project "${project}" / handle "${handle}" — nothing to restore`);
    const projects = listProjects(dir);
    if (projects.length > 0) {
      out(`  journal has projects: ${projects.join(", ")}`);
      out(`  (a different key? set remote.project in ${CONFIG_BASENAME} — origin-less repos derive it from the dir name, which varies per machine)`);
    }
    return;
  }
  const store = new Store(); // deliberately NOT journal-wired: replay must not re-append
  try {
    const res = replayInto(store, events);
    out(`✔ restored ${res.applied} event(s) for "${handle}" into ${dbPath()}`);
    if (res.skipped > 0) out(`  (${res.skipped} event(s) of unknown type skipped — journal written by a newer build?)`);
  } finally {
    store.close();
  }
}

/** Push any pending journal appends now (no debounce) — also the `--adopt` entry point. */
function cmdSync(argv: string[]): void {
  const j = requireRemote();
  const { handle } = j;
  const store = new Store();
  let res: ReturnType<typeof syncPush>;
  try {
    res = syncPush(j, { force: true, adopt: flag(argv, "--adopt"), store });
  } finally {
    store.close();
  }
  if (res.status === "error") fail(`sync failed: ${res.detail}`);
  if (res.status === "invalid") fail(res.detail ?? "journal repo failed validation");
  out(`✔ journal ${res.status} (handle "${handle}")`);
}

/** Manually (re)render digests — normally automatic on every sync. */
function cmdDigest(argv: string[]): void {
  const j = requireRemote();
  syncPull(j.dir); // best-effort — render from the freshest merged view we have
  const i = argv.indexOf("--date");
  const date = i !== -1 ? argv[i + 1] : undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("usage: hands digest [--date YYYY-MM-DD]");
  const changed = regenerateDigests(j, date ? new Set([date]) : undefined);
  if (changed.length === 0) {
    out("digests already up to date");
    return;
  }
  for (const f of changed) out(`✔ ${f}`);
  out("(committed + pushed on the next sync — or run: hands sync)");
}

/**
 * Bridge the live, cwd/git-derived books config to a standalone MCP server
 * registration a client outside the repo (Claude Desktop) can run. Requires
 * books already attached (`hands books <url>`) — this only ever points a
 * viewer at an existing journal, never creates one.
 */
function cmdMcp(argv: string[]): void {
  const sub = argv[0];
  if (sub !== "install") fail("usage: hands mcp install [--print]");
  const rest = argv.slice(1);

  const resolved = resolveBooksTarget();
  if (!resolved.ok) fail(resolved.reason);
  const { target } = resolved;

  const entryPath = resolveBooksServerEntry();
  if (!entryPath) {
    fail(
      "could not find the books MCP server bundle — run `npm run bundle` in engine/ (dev checkout) " +
        "or reinstall the hands plugin",
    );
  }

  const name = serverName(target.project);
  const entry = booksMcpEntry(entryPath, target);

  if (flag(rest, "--print")) {
    out(JSON.stringify({ [name]: entry }, null, 2));
    out("");
    out('paste the above into any MCP client\'s config under "mcpServers"');
    return;
  }

  const configPath = desktopConfigPath();
  const written = writeDesktopConfig(configPath, name, entry);
  if (!written.ok) fail(written.reason);
  out(`✔ installed "${name}" → ${configPath}`);
  out(`  reads: ${target.dir} (project "${target.project}")`);
  out("  restart Claude Desktop to pick it up");
}

/**
 * Sign in with GitHub via browser-handoff OAuth against the same Descope
 * project the hosted books MCP authenticates against — see engine/src/
 * login.ts. Entirely optional: `hands.config.json`'s `remote.url` (hand-set
 * via `hands books`) always wins over anything login would derive, and
 * every other command works identically whether or not this has ever run.
 */
async function cmdLogin(): Promise<void> {
  const { login, localWhoami } = await import("./login.js");
  const existing = localWhoami();
  if (existing.loggedIn) {
    out(`already signed in as ${existing.githubLogin} (${existing.tier} tier) — run \`hands logout\` first to switch accounts`);
    return;
  }
  const result = await login({ out });
  if (!result.ok) fail(result.reason);
  out(`✔ signed in as ${result.githubLogin} (${result.tier} tier)`);
}

async function cmdLogout(): Promise<void> {
  const { logout } = await import("./login.js");
  out(logout() ? "✔ signed out" : "not signed in — nothing to do");
}

/** Local-only identity check (cached from the last `hands login` / `hands sync`'s refresh) — never calls the network, so it's safe to run often. */
async function cmdWhoami(): Promise<void> {
  const { localWhoami } = await import("./login.js");
  const status = localWhoami();
  if (!status.loggedIn) {
    out("not signed in — run: hands login");
    return;
  }
  out(`${status.githubLogin} (${status.tier} tier)`);
}

function cmdPaths(): void {
  const cfg = loadConfig();
  const agentId = resolveAgentId({ expoBasename: cfg.expo.basename });
  let focus: string | null = null;
  if (fs.existsSync(dbPath())) {
    const store = new Store();
    try {
      focus = store.getFocus(agentId);
    } finally {
      store.close();
    }
  }
  out(JSON.stringify(pathsReport(agentId, cfg, focus), null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "init": {
        const { runInit } = await import("./init.js");
        await runInit(rest);
        return;
      }
      case "station":
        return cmdStation(rest);
      case "books":
        return cmdBooks(rest);
      case "scale":
        return cmdScale(rest);
      case "restore":
        return cmdRestore();
      case "sync":
        return cmdSync(rest);
      case "digest":
        return cmdDigest(rest);
      case "mcp":
        return cmdMcp(rest);
      case "login":
        return await cmdLogin();
      case "logout":
        return await cmdLogout();
      case "whoami":
        return await cmdWhoami();
      case "serve":
      case "dashboard": {
        const { serve } = await import("./serve.js");
        const handle = await serve();
        out(`hands dashboard → ${handle.url}\n(Ctrl-C to stop)`);
        return; // the http server keeps the process alive
      }
      case "paths":
        return cmdPaths();
      default: {
        out("hands — an expo/station agent fleet for Claude Code");
        out("");
        out(`  hands init                scaffold ${CONFIG_BASENAME}`);
        out("  hands books [<url>]       attach the books (durable journal) to this repo's config");
        out("  hands station add [-n N]   open N stations");
        out("  hands station ls           list this repo's stations");
        out("  hands station rm <id>      retire a station (--force discards uncommitted work)");
        out("  hands scale <N>           reconcile the brigade to exactly N stations");
        out("  hands restore             rebuild local bus state from the remote journal (remote.url)");
        out("  hands sync [--adopt]      push pending journal appends now (--adopt initializes a");
        out("                                non-empty repo as a journal — explicit by design)");
        out("  hands digest [--date D]  re-render journal digests (normally automatic on sync)");
        out("  hands mcp install [--print]  install a read-only books MCP for Claude Desktop (or");
        out("                                any MCP client, with --print) — requires books attached");
        out("  hands login               sign in with GitHub (optional — free tier never needs it)");
        out("  hands logout              clear the local sign-in");
        out("  hands whoami               show the signed-in identity (local only, no network call)");
        out("  hands serve               live dashboard → http://localhost:4319");
        out("  hands paths               show where this directory resolves (debug)");
        process.exit(cmd ? 2 : 0);
      }
    }
  } catch (err) {
    if (err instanceof ProvisionError) fail(err.message);
    throw err;
  }
}

main().catch((err) => {
  console.error("hands fatal:", err);
  process.exit(1);
});
