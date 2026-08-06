#!/usr/bin/env node
/**
 * hands CLI — launcher + provisioning + setup. The user thinks in stations:
 *
 *   hands [<project>]         open the pass (expo) here, or in a registered kitchen
 *   hands [<project>] station-N  open a station's seat
 *   hands go <project> [...]  explicit form (scripts / names that collide with subcommands)
 *   hands register [path]     enroll a kitchen so it resolves by name
 *   hands init                per-repo config scaffold
 *   hands books <url>         attach the books (durable journal) to this repo's config
 *   hands station add [-n N]   open N stations (worktree hidden inside)
 *   hands station ls           list this repo's stations
 *   hands station rm <id>      retire a station (idempotent; --force discards)
 *   hands attach <station-N>  resume a station's own Claude Code session in this terminal
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
import { execFileSync, spawnSync } from "node:child_process";
import * as os from "node:os";
import { CONFIG_BASENAME, loadConfig } from "./config.js";
import { resolveAgentId } from "./identity.js";
import { dbPath, repoInfo } from "./paths.js";
import { pathsReport } from "./server.js";
import {
  addStations,
  launch,
  launchCommand,
  type LaunchPlan,
  listStations,
  ProvisionError,
  removeStation,
  scaleStations,
} from "./provision.js";
import { listRegisteredProjects, registerProject, resolveProject } from "./projects.js";
import { seedStationPermissions } from "./seed-permissions.js";
import { idleMs, latestSessionId, recentActivity, transcriptDir } from "./station-logs.js";
import { runDoctor } from "./doctor.js";
import { buildInfo, describe, otherInstall } from "./version.js";
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
    if (p.sessionName) out(`    theme: ${p.sessionName}`);
  }
}

/**
 * hands#104: session names are hands-owned and assigned at provisioning time
 * (provision.ts computes them deterministically), but the DB row is the
 * durable source of truth — persist here so it survives independent of
 * whether/when the station's own process ever takes a turn.
 */
function persistSessionNames(plans: LaunchPlan[]): void {
  const named = plans.filter((p) => p.sessionName);
  if (named.length === 0) return;
  const store = new Store();
  try {
    for (const p of named) store.setSessionName(p.id, p.sessionName!);
  } finally {
    store.close();
  }
}

function cmdStation(argv: string[]): void {
  const sub = argv[0];
  if (sub === "add") {
    const n = intOpt(argv, "-n", 1);
    const plans = addStations(n);
    if (plans.length === 0) out("nothing to add");
    persistSessionNames(plans);
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
  persistSessionNames(added);
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

/** File a note to the plugin's maintainer as a GitHub issue on hands-dev/hands — the CLI entry point both `/hands:feedback` and the dashboard's feedback form call, so the filing mechanics (footer, label fallback) live in exactly one place. */
async function cmdFeedback(argv: string[]): Promise<void> {
  const body = argv[0];
  if (!body || body.startsWith("--")) fail('usage: hands feedback "<body>" [--title "<title>"]');
  const i = argv.indexOf("--title");
  const title = i !== -1 ? argv[i + 1] : undefined;
  const { fileFeedback } = await import("./feedback.js");
  const result = fileFeedback({ body, title });
  if (!result.ok) fail(result.error ?? "filing failed");
  out(`✔ ${result.url}`);
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

const STATION_ID = /^station-\d+$/;

/**
 * Split argv into bare words and flags, consuming the VALUE of any flag that
 * takes one. Without this, `hands logs station-2 -n 12` reads "12" as a project
 * name — the same bug `--name` had.
 */
function parseArgs(argv: string[], valueFlags: readonly string[]): { words: string[]; flags: Map<string, string> } {
  const words: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (valueFlags.includes(arg)) {
      flags.set(arg, argv[++i] ?? "");
      continue;
    }
    if (arg.startsWith("-")) {
      flags.set(arg, "");
      continue;
    }
    words.push(arg);
  }
  return { words, flags };
}

/** Resolve `[<project>] <station-N>`-style args to a concrete seat, for logs/restart. */
function requireStation(argv: string[], verb: string): { repoRoot: string; id: string; dir: string } {
  const { words } = parseArgs(argv, ["-n"]);
  const seat = words.find((w) => STATION_ID.test(w));
  if (!seat) fail(`usage: hands ${verb} [<project>] <station-N>`);
  const projectWord = words.find((w) => !STATION_ID.test(w));
  let repoRoot: string;
  if (projectWord) {
    const project = resolveProject(projectWord);
    if (!project) fail(`no project named "${projectWord}"`);
    repoRoot = project.repoRoot;
  } else {
    const info = repoInfo(process.cwd());
    if (!info) fail(`not inside a git repo — use \`hands ${verb} <project> ${seat}\``);
    repoRoot = info.repoRoot;
  }
  const cfg = loadConfig({ cwd: repoRoot });
  const match = listStations(repoRoot, cfg).find((s) => s.id === seat);
  if (!match) fail(`no ${seat} in ${repoRoot}`);
  return { repoRoot, id: match.id, dir: match.dir };
}

/**
 * `hands logs [<project>] <station-N>` — what the station is actually doing,
 * from its own transcript rather than what it chose to say on the bus (#60).
 */
function cmdLogs(argv: string[]): void {
  const { id, dir } = requireStation(argv, "logs");
  const { flags } = parseArgs(argv, ["-n"]);
  const limit = Number(flags.get("-n")) || 20;
  const { file, events } = recentActivity(dir, { limit });

  if (!file) {
    out(`${id}: no transcript yet — it has never taken a turn`);
    return;
  }
  if (argv.includes("--json")) {
    out(JSON.stringify({ station: id, file, events }, null, 2));
    return;
  }
  const idle = idleMs(dir);
  out(`${id} — ${events.length} recent event(s)${idle === null ? "" : `, last activity ${Math.round(idle / 1000)}s ago`}`);
  out("");
  for (const e of events) {
    const t = e.at ? new Date(e.at).toISOString().slice(11, 19) : "  --  ";
    const mark = e.kind === "error" ? "✗" : e.kind === "tool" ? "→" : e.kind === "result" ? "←" : "·";
    out(`  ${t} ${mark} ${e.label}`);
    if (e.kind === "error" && e.detail) out(`             ${e.detail}`);
  }
}

/** `hands restart [<project>] <station-N>` — recycle a wedged seat. */
function cmdRestart(argv: string[]): void {
  const { repoRoot, id, dir } = requireStation(argv, "restart");
  const cfg = loadConfig({ cwd: repoRoot });
  // Re-seed on the way through: a seat opened before seeding existed, or one
  // whose settings were removed, would otherwise come back up just as stuck.
  const seeded = seedStationPermissions(dir);
  if (seeded.written) out(`  seeded missing permission allowlist`);
  const model = cfg.stations.overrides[id] ?? cfg.stations.model;
  const command = launchCommand({ id, dir, model }, "station");
  // tmux names each station's window by its id (see provision.ts), so a
  // respawn targets the existing pane rather than piling up new ones.
  try {
    execFileSync("tmux", ["respawn-pane", "-k", "-t", id, command], {
      stdio: "ignore",
      timeout: 10_000,
    });
    out(`✔ ${id} restarted in its existing pane`);
    return;
  } catch {
    // no such window, or no tmux — fall back to a normal launch
  }
  const res = launch({ id, dir, model }, cfg.stations.launcher, process.env, "station");
  if (res.launched) out(`✔ ${id} relaunched (${res.launcher})`);
  else out(`launcher unavailable — paste this into a terminal:\n\n  ${command}\n`);
}

/**
 * `hands attach [<project>] <station-N>` — resume a station's own Claude
 * Code session in the current terminal. The recovery path for a pane that
 * died (or one you just want to check in on): no new session, no lost
 * context — the actual conversation, picked up where it left off.
 */
function cmdAttach(argv: string[]): void {
  const { repoRoot, id, dir } = requireStation(argv, "attach");
  const cfg = loadConfig({ cwd: repoRoot });
  const model = cfg.stations.overrides[id] ?? cfg.stations.model;
  const sessionId = latestSessionId(dir);
  if (!sessionId) {
    fail(`no Claude Code session found for ${id} — it has never taken a turn (transcripts checked at ${transcriptDir(dir)})`);
  }
  out(`attaching to ${id} — resuming ${sessionId} (${model})`);
  // stdio: "inherit" hands the current terminal straight to the resumed
  // session — this command's whole point is putting a human back in the seat.
  const res = spawnSync("claude", ["--model", model, "--resume", sessionId], {
    cwd: dir,
    stdio: "inherit",
    env: { ...process.env, HANDS_ID: id },
  });
  process.exit(res.status ?? 1);
}

/** `hands ls` — registered kitchens and whether they're reachable. */
function cmdLs(): void {
  const projects = listRegisteredProjects();
  if (projects.length === 0) {
    out("no kitchens registered — run `hands register` from a repo's main checkout");
    return;
  }
  for (const p of projects) {
    const configured = fs.existsSync(path.join(p.repoRoot, CONFIG_BASENAME));
    let seats = "";
    try {
      if (configured) {
        const stations = listStations(p.repoRoot, loadConfig({ cwd: p.repoRoot }));
        seats = stations.length ? ` · ${stations.length} station(s)` : " · no stations";
      }
    } catch {
      // an unreadable config shouldn't break the listing
    }
    out(`${p.name.padEnd(18)} ${p.repoRoot}${configured ? "" : "  (no hands.config.json)"}${seats}`);
  }
}

/**
 * `hands version` — which build is running, and whether a second install
 * disagrees with it. The second half is the point: a standalone CLI and a
 * plugin cache at different vintages means the command you type and the MCP
 * server your sessions talk to are different software.
 *
 * `--json` is for scripts/skills (the expo's session-start version check) —
 * the same `BuildInfo` this command already prints, just structured.
 */
function cmdVersion(argv: string[] = []): void {
  const info = buildInfo();
  if (flag(argv, "--json")) {
    process.stdout.write(`${JSON.stringify(info)}\n`);
    return;
  }
  out(`hands ${describe(info)}`);
  out(`  ${info.entry}`);
  const other = otherInstall(info.kind);
  if (!other) return;
  const same = other.stamp.commit && other.stamp.commit === info.commit;
  out("");
  out(`also installed: ${other.kind} — ${other.stamp.version}${other.stamp.commit ? ` (${other.stamp.commit})` : ""}`);
  if (!same) {
    out("  ⚠ the two installs are different builds — `hands` and your sessions' MCP server may disagree");
  }
}

/** `hands doctor [--fix]` — see doctor.ts; every check maps to a real failure. */
function cmdDoctor(argv: string[]): void {
  const report = runDoctor({ fix: argv.includes("--fix") });
  for (const c of report.checks) {
    const mark = c.severity === "ok" ? "✔" : c.severity === "warn" ? "!" : "✗";
    out(`${mark} ${c.name.padEnd(24)} ${c.detail}`);
  }
  out("");
  const fixable = report.checks.filter((c) => c.fixable);
  if (fixable.length > 0 && !argv.includes("--fix")) {
    out(`${fixable.length} issue(s) are repairable — re-run with --fix`);
  }
  if (report.worst === "fail") process.exit(1);
}

/**
 * Bring up a session in `dir`. Stations run their configured tier; the expo
 * inherits the principal's own default (there is no expo model config, and
 * choosing one for them would silently downgrade the pass).
 */
function launchAt(dir: string, mode: "expo" | "station", id: string, model?: string): void {
  const cfg = loadConfig({ cwd: dir });
  const res = launch({ id, dir, model }, cfg.stations.launcher, process.env, mode);
  if (res.launched) {
    out(`✔ ${id} → ${dir} (${res.launcher})`);
    return;
  }
  // `manual` is the zero-assumption fallback, not a failure: print the exact
  // command so the principal can paste it into whatever terminal they use.
  out(`launcher unavailable — paste this into a terminal:\n\n  ${launchCommand({ id, dir, model }, mode)}\n`);
}

/** Open a station seat by id within `repoRoot`, or fail naming what exists. */
function launchStation(repoRoot: string, stationId: string): void {
  const cfg = loadConfig({ cwd: repoRoot });
  const stations = listStations(repoRoot, cfg);
  const match = stations.find((s) => s.id === stationId);
  if (!match) {
    const known = stations.map((s) => s.id).join(", ") || "none open";
    fail(`no ${stationId} in ${repoRoot} — stations: ${known}`);
  }
  if (!match.present) fail(`${stationId}'s worktree is missing (${match.dir}) — re-open it with \`hands station add\``);
  launchStationSeat(repoRoot, match.id, match.dir, cfg);
}

function launchStationSeat(
  _repoRoot: string,
  id: string,
  dir: string,
  cfg: ReturnType<typeof loadConfig>,
): void {
  // Seed here too, not just at `station add`: a seat opened by hand, or one
  // created before seeding existed, would otherwise still stall on prompts.
  seedStationPermissions(dir);
  launchAt(dir, "station", id, cfg.stations.overrides[id] ?? cfg.stations.model);
}

/**
 * Resolve a bare word as a kitchen or a station and launch it.
 * Returns false when it resolves to neither, so the caller can fall through to
 * usage rather than this swallowing every typo.
 */
function tryLaunch(cmd: string | undefined, rest: string[]): boolean {
  // `hands` bare → the pass, here.
  if (!cmd) {
    const info = repoInfo(process.cwd());
    if (!info || !fs.existsSync(path.join(info.repoRoot, CONFIG_BASENAME))) return false;
    launchAt(info.repoRoot, "expo", "expo");
    return true;
  }

  // `hands station-2` → that seat in the current kitchen.
  if (STATION_ID.test(cmd)) {
    const info = repoInfo(process.cwd());
    if (!info) fail(`not inside a git repo — use \`hands <project> ${cmd}\``);
    launchStation(info.repoRoot, cmd);
    return true;
  }

  // `hands ampersand [station-2]` → someone else's kitchen.
  const project = resolveProject(cmd);
  if (!project) return false;
  const seat = rest[0];
  if (seat && STATION_ID.test(seat)) launchStation(project.repoRoot, seat);
  else launchAt(project.repoRoot, "expo", "expo");
  return true;
}

/** `hands go <project> [station-N]` — explicit form, for scripts and names that collide with subcommands. */
function cmdGo(argv: string[]): void {
  const [name, ...rest] = argv;
  if (!name) fail("usage: hands go <project> [station-N]");
  if (!tryLaunch(name, rest)) {
    fail(`no project named "${name}" — register it with \`hands register\` from its main checkout`);
  }
}

/** `hands register [path]` — enroll a kitchen so `hands <name>` resolves it. */
function cmdRegister(argv: string[]): void {
  const { words, flags } = parseArgs(argv, ["--name"]);
  const target = words[0] ?? process.cwd();
  const entry = registerProject(target, { name: flags.get("--name") || undefined });
  if (!entry) fail(`not a git repo: ${target}`);
  out(`✔ registered "${entry.name}" → ${entry.repoRoot}`);
  out(`  open it from anywhere with: hands ${entry.name}`);
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
      case "feedback":
        await cmdFeedback(rest);
        return;
      case "serve":
      case "dashboard": {
        const { serve } = await import("./serve.js");
        const handle = await serve();
        out(`hands dashboard → ${handle.url}\n(Ctrl-C to stop)`);
        // Ctrl-C/a kill has no handler by default, so close() (SSE clients, timers, the DB
        // handle, the pidfile) never ran — this repo's dashboard skill and `hands doctor` now
        // depend on the pidfile actually being cleaned up on a normal stop (hands#77/#82).
        const shutdown = (): void => {
          handle.close();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        return; // the http server keeps the process alive
      }
      case "paths":
        return cmdPaths();
      case "go":
        return cmdGo(rest);
      case "register":
        return cmdRegister(rest);
      case "ls":
        return cmdLs();
      case "logs":
        return cmdLogs(rest);
      case "restart":
        return cmdRestart(rest);
      case "attach":
        return cmdAttach(rest);
      case "doctor":
        return cmdDoctor(rest);
      case "version":
      case "--version":
      case "-v":
        return cmdVersion(rest);
      default: {
        // Not a subcommand — try to read it as a kitchen or a station before
        // giving up. `hands` bare inside a kitchen opens the pass; `hands
        // ampersand` opens someone else's; `hands station-2` opens a seat.
        const askedForHelp = cmd === "--help" || cmd === "-h" || cmd === "help";
        if (!askedForHelp && tryLaunch(cmd, rest)) return;
        if (cmd && !askedForHelp) {
          fail(
            `no project or station named "${cmd}" — register this repo with \`hands register\`, or see \`hands\` for commands`,
          );
        }
        out("hands — an expo/station agent fleet for Claude Code");
        out("");
        out("  hands [<project>]         open the pass (expo) here, or in <project>");
        out("  hands [<project>] station-N  open a station's seat");
        out("  hands go <project> [station-N]  same, explicit (for scripts / name collisions)");
        out("  hands register [path]     enroll a kitchen so it resolves by name");
        out("  hands ls                  registered kitchens");
        out("");
        out("  hands doctor [--fix]      health check (--fix repairs what's safe to repair)");
        out("  hands logs <station-N>    what a station is actually doing (its own transcript)");
        out("  hands restart <station-N>  recycle a wedged station");
        out("  hands version             which build is running (and whether two installs disagree)");
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
        out('  hands feedback "<body>" [--title "<title>"]  file a note to the maintainer (GitHub issue)');
        out("  hands serve               live dashboard → http://localhost:4319");
        out("  hands paths               show where this directory resolves (debug)");
        // Asking for help is not an error; an unrecognized word is.
        process.exit(cmd && !askedForHelp ? 2 : 0);
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
