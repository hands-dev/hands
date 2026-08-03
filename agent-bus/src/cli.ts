#!/usr/bin/env node
/**
 * agent-bus CLI — provisioning + setup. The user thinks in workers:
 *
 *   agent-bus init                one-time setup for this machine + repo
 *   agent-bus worker add [-n N]   spin up N workers (worktree hidden inside)
 *   agent-bus worker ls           list this repo's workers
 *   agent-bus worker rm <id>      retire a worker (idempotent; --force discards)
 *   agent-bus scale <N>           reconcile the pool to exactly N workers
 *   agent-bus paths               where this cwd resolves (debug)
 *
 * The MCP server itself stays `server.js` (registered by `init`); this bin is
 * the human/foreman-facing lifecycle tool.
 */
import { loadConfig } from "./config.js";
import { resolveAgentId } from "./identity.js";
import { coordinationDir, dbPath, notifyPath, repoInfo } from "./paths.js";
import {
  addWorkers,
  type LaunchPlan,
  listWorkers,
  ProvisionError,
  removeWorker,
  scaleWorkers,
} from "./provision.js";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`agent-bus: ${message}\n`);
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
      out("no workers — add some: agent-bus worker add -n 2");
      return;
    }
    for (const w of workers) out(`${w.id}\t${w.branch}\t${w.dir}`);
    return;
  }
  if (sub === "rm") {
    const id = argv[1];
    if (!id || id.startsWith("-")) fail("usage: agent-bus worker rm worker-<n> [--force]");
    const res = removeWorker(id, { force: flag(argv, "--force") });
    out(res.removed ? `✔ ${id} retired` : `${id} was not provisioned (nothing to do)`);
    return;
  }
  fail("usage: agent-bus worker <add|ls|rm>");
}

function cmdScale(argv: string[]): void {
  const target = Number.parseInt(argv[0] ?? "", 10);
  if (!Number.isInteger(target) || target < 0) fail("usage: agent-bus scale <N>");
  const { added, removed } = scaleWorkers(target, { force: flag(argv, "--force") });
  reportPlans(added);
  for (const id of removed) out(`✔ ${id} retired`);
  if (added.length === 0 && removed.length === 0) out(`already at ${target} workers`);
}

function cmdPaths(): void {
  const info = repoInfo();
  const agentId = resolveAgentId({ foremanBasename: loadConfig().foreman.basename });
  out(
    JSON.stringify(
      {
        cwd: process.cwd(),
        agentId,
        repoRoot: info?.repoRoot ?? null,
        isMainWorktree: info?.isMainWorktree ?? null,
        slug: info?.slug ?? "_global",
        coordinationDir: coordinationDir(),
        db: dbPath(),
        notify: notifyPath(agentId),
      },
      null,
      2,
    ),
  );
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
      case "paths":
        return cmdPaths();
      default: {
        out("agent-bus — foreman/worker fleet for Claude Code");
        out("");
        out("  agent-bus init                one-time setup (build, register MCP, hooks, skills, config)");
        out("  agent-bus worker add [-n N]   spin up N workers");
        out("  agent-bus worker ls           list this repo's workers");
        out("  agent-bus worker rm <id>      retire a worker (--force discards uncommitted work)");
        out("  agent-bus scale <N>           reconcile the pool to exactly N workers");
        out("  agent-bus paths               show where this directory resolves (debug)");
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
