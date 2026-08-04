#!/usr/bin/env node
/**
 * yes-chef CLI — provisioning + setup. The user thinks in stations:
 *
 *   yes-chef init                per-repo config scaffold
 *   yes-chef books <url>         attach the books (durable journal) to this repo's config
 *   yes-chef station add [-n N]   open N stations (worktree hidden inside)
 *   yes-chef station ls           list this repo's stations
 *   yes-chef station rm <id>      retire a station (idempotent; --force discards)
 *   yes-chef scale <N>           reconcile the brigade to exactly N stations
 *   yes-chef restore             rebuild local bus state from the remote journal
 *   yes-chef sync                push pending journal appends now
 *   yes-chef paths               where this cwd resolves (debug)
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
  listProjects,
  openJournal,
  readEvents,
  replayInto,
  syncPull,
  syncPush,
  validateJournal,
} from "./remote.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store.js";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`yes-chef: ${message}\n`);
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
    out(`\nStations register with the expo on their first turn (yc_peers to check).`);
    return;
  }
  if (sub === "ls") {
    const stations = listStations();
    if (stations.length === 0) {
      out("no stations — open some: yes-chef station add -n 2");
      return;
    }
    for (const w of stations) out(`${w.id}\t${w.branch}\t${w.dir}`);
    return;
  }
  if (sub === "rm") {
    const id = argv[1];
    if (!id || id.startsWith("-")) fail("usage: yes-chef station rm station-<n> [--force]");
    const res = removeStation(id, { force: flag(argv, "--force") });
    out(res.removed ? `✔ ${id} retired` : `${id} was not provisioned (nothing to do)`);
    return;
  }
  fail("usage: yes-chef station <add|ls|rm>");
}

function cmdScale(argv: string[]): void {
  const target = Number.parseInt(argv[0] ?? "", 10);
  if (!Number.isInteger(target) || target < 0) fail("usage: yes-chef scale <N>");
  const { added, removed } = scaleStations(target, { force: flag(argv, "--force") });
  reportPlans(added);
  for (const id of removed) out(`✔ ${id} retired`);
  if (added.length === 0 && removed.length === 0) out(`already at ${target} stations`);
}

/**
 * Attach (or inspect) the books — the durable journal — on this repo's
 * existing config. `yes-chef init` covers the fresh-scaffold path; this is
 * the "I set up the kitchen first, books later" path.
 */
function cmdBooks(argv: string[]): void {
  const info = repoInfo(process.cwd());
  if (!info) fail("not inside a git repo — run from your repo's main checkout");
  const configPath = path.join(info.repoRoot, CONFIG_BASENAME);
  if (!fs.existsSync(configPath)) fail(`no ${CONFIG_BASENAME} here — run: yes-chef init`);

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
      out("no books attached — attach with: yes-chef books <private-git-url> [--handle <name>]");
    }
    return;
  }

  const hi = argv.indexOf("--handle");
  const handleArg =
    hi !== -1 ? argv[hi + 1] : argv.find((a) => a.startsWith("--handle="))?.slice("--handle=".length);
  cfg.remote = {
    ...remote,
    url,
    handle: handleArg ?? remote.handle ?? os.userInfo().username,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  out(`✔ books attached: ${url} (handle "${String((cfg.remote as Record<string, unknown>).handle)}")`);
  out("  next: yes-chef sync   (initializes the journal; --adopt if the repo is non-empty)");
  out("  (restart running Claude Code sessions so the bus picks up the config change)");
}

function requireRemote() {
  const j = openJournal();
  if (!j) {
    fail("no books attached — run: yes-chef books git@github.com:you/yes-chef-books.git");
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
  const res = syncPush(j, { force: true, adopt: flag(argv, "--adopt") });
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
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("usage: yes-chef digest [--date YYYY-MM-DD]");
  const changed = regenerateDigests(j, date ? new Set([date]) : undefined);
  if (changed.length === 0) {
    out("digests already up to date");
    return;
  }
  for (const f of changed) out(`✔ ${f}`);
  out("(committed + pushed on the next sync — or run: yes-chef sync)");
}

function cmdPaths(): void {
  const cfg = loadConfig();
  const agentId = resolveAgentId({ expoBasename: cfg.expo.basename });
  out(JSON.stringify(pathsReport(agentId, cfg), null, 2));
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
      case "serve":
      case "dashboard": {
        const { serve } = await import("./serve.js");
        const handle = await serve();
        out(`yes-chef dashboard → ${handle.url}\n(Ctrl-C to stop)`);
        return; // the http server keeps the process alive
      }
      case "paths":
        return cmdPaths();
      default: {
        out("yes-chef — an expo/station agent fleet for Claude Code");
        out("");
        out(`  yes-chef init                scaffold ${CONFIG_BASENAME}`);
        out("  yes-chef books [<url>]       attach the books (durable journal) to this repo's config");
        out("  yes-chef station add [-n N]   open N stations");
        out("  yes-chef station ls           list this repo's stations");
        out("  yes-chef station rm <id>      retire a station (--force discards uncommitted work)");
        out("  yes-chef scale <N>           reconcile the brigade to exactly N stations");
        out("  yes-chef restore             rebuild local bus state from the remote journal (remote.url)");
        out("  yes-chef sync [--adopt]      push pending journal appends now (--adopt initializes a");
        out("                                non-empty repo as a journal — explicit by design)");
        out("  yes-chef digest [--date D]  re-render journal digests (normally automatic on sync)");
        out("  yes-chef serve               live dashboard → http://localhost:4319");
        out("  yes-chef paths               show where this directory resolves (debug)");
        process.exit(cmd ? 2 : 0);
      }
    }
  } catch (err) {
    if (err instanceof ProvisionError) fail(err.message);
    throw err;
  }
}

main().catch((err) => {
  console.error("yes-chef fatal:", err);
  process.exit(1);
});
