#!/usr/bin/env node
/**
 * agent-bus CLI — provisioning + setup. The user thinks in workers:
 *
 *   roundhouse init                per-repo config scaffold + old-install cleanup/migration
 *   roundhouse worker add [-n N]   spin up N workers (worktree hidden inside)
 *   roundhouse worker ls           list this repo's workers
 *   roundhouse worker rm <id>      retire a worker (idempotent; --force discards)
 *   roundhouse scale <N>           reconcile the pool to exactly N workers
 *   roundhouse restore             rebuild local bus state from the remote journal
 *   roundhouse sync                push pending journal appends now
 *   roundhouse paths               where this cwd resolves (debug)
 *
 * The MCP server, hooks, and skills are registered by the PLUGIN; this bin is
 * the human/foreman-facing lifecycle tool (on the Bash PATH via plugin/bin).
 */
import { loadConfig } from "./config.js";
import { resolveAgentId } from "./identity.js";
import { dbPath } from "./paths.js";
import { pathsReport } from "./server.js";
import {
  addWorkers,
  type LaunchPlan,
  listWorkers,
  ProvisionError,
  removeWorker,
  scaleWorkers,
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
  process.stderr.write(`roundhouse: ${message}\n`);
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

function cmdWorker(argv: string[]): void {
  const sub = argv[0];
  if (sub === "add") {
    const n = intOpt(argv, "-n", 1);
    const plans = addWorkers(n);
    if (plans.length === 0) out("nothing to add");
    reportPlans(plans);
    out(`\nWorkers register on the foreman's board on their first turn (agent_bus_peers to check).`);
    return;
  }
  if (sub === "ls") {
    const workers = listWorkers();
    if (workers.length === 0) {
      out("no workers — add some: roundhouse worker add -n 2");
      return;
    }
    for (const w of workers) out(`${w.id}\t${w.branch}\t${w.dir}`);
    return;
  }
  if (sub === "rm") {
    const id = argv[1];
    if (!id || id.startsWith("-")) fail("usage: roundhouse worker rm worker-<n> [--force]");
    const res = removeWorker(id, { force: flag(argv, "--force") });
    out(res.removed ? `✔ ${id} retired` : `${id} was not provisioned (nothing to do)`);
    return;
  }
  fail("usage: roundhouse worker <add|ls|rm>");
}

function cmdScale(argv: string[]): void {
  const target = Number.parseInt(argv[0] ?? "", 10);
  if (!Number.isInteger(target) || target < 0) fail("usage: roundhouse scale <N>");
  const { added, removed } = scaleWorkers(target, { force: flag(argv, "--force") });
  reportPlans(added);
  for (const id of removed) out(`✔ ${id} retired`);
  if (added.length === 0 && removed.length === 0) out(`already at ${target} workers`);
}

function requireRemote() {
  const j = openJournal();
  if (!j) {
    fail('no remote journal configured — set remote.url in agent-bus.config.json, e.g. {"remote":{"url":"git@github.com:you/roundhouse-state.git"}}');
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
      out('  (a different key? set remote.project in agent-bus.config.json — origin-less repos derive it from the dir name, which varies per machine)');
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
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("usage: roundhouse digest [--date YYYY-MM-DD]");
  const changed = regenerateDigests(j, date ? new Set([date]) : undefined);
  if (changed.length === 0) {
    out("digests already up to date");
    return;
  }
  for (const f of changed) out(`✔ ${f}`);
  out("(committed + pushed on the next sync — or run: roundhouse sync)");
}

function cmdPaths(): void {
  const cfg = loadConfig();
  const agentId = resolveAgentId({ foremanBasename: cfg.foreman.basename });
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
      case "worker":
        return cmdWorker(rest);
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
        out(`roundhouse dashboard → ${handle.url}\n(Ctrl-C to stop)`);
        return; // the http server keeps the process alive
      }
      case "paths":
        return cmdPaths();
      default: {
        out("roundhouse — foreman/worker fleet for Claude Code");
        out("");
        out("  roundhouse init                scaffold agent-bus.config.json + clean up pre-plugin installs");
        out("  roundhouse worker add [-n N]   spin up N workers");
        out("  roundhouse worker ls           list this repo's workers");
        out("  roundhouse worker rm <id>      retire a worker (--force discards uncommitted work)");
        out("  roundhouse scale <N>           reconcile the pool to exactly N workers");
        out("  roundhouse restore             rebuild local bus state from the remote journal (remote.url)");
        out("  roundhouse sync [--adopt]      push pending journal appends now (--adopt initializes a");
        out("                                non-empty repo as a journal — explicit by design)");
        out("  roundhouse digest [--date D]  re-render journal digests (normally automatic on sync)");
        out("  roundhouse serve               live dashboard → http://localhost:4319");
        out("  roundhouse paths               show where this directory resolves (debug)");
        process.exit(cmd ? 2 : 0);
      }
    }
  } catch (err) {
    if (err instanceof ProvisionError) fail(err.message);
    throw err;
  }
}

main().catch((err) => {
  console.error("agent-bus fatal:", err);
  process.exit(1);
});
