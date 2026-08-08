#!/usr/bin/env node
/**
 * hands CLI — launcher + provisioning + setup. The user thinks in stations:
 *
 *   hands [<project>]         open the pass (expo) here, or in a registered kitchen
 *   hands [<project>] station-N  open a station's seat [--without-bypass]
 *   hands [<project>] sous    open a sous session (hands#87/#93) — no worktree, runs where invoked
 *   hands go <project> [...]  explicit form (scripts / names that collide with subcommands)
 *   hands register [path]     enroll a kitchen so it resolves by name
 *   hands init                per-repo config scaffold
 *   hands books <url>         attach the books (durable journal) to this repo's config
 *   hands craft ls             the craft roster — scope, ready/plan-only, covers, distilled, notes
 *   hands craft ready <s>      mark ready for service (execute mode) — sous-owned once one exists
 *   hands craft unready <s>    revert to plan-mode only
 *   hands craft focus <s> ["<text>" | --clear]  the LENS a craft's ingest/lint checks against —
 *                              genuinely separate from covers (scope); no arg prints the current one
 *   hands craft sync           materialize crafts as real Agent types + Skills (one-call dispatch)
 *   hands craft sweep-headers  drop retired "last held: DATE by AGENT" ownership clauses (hands#167)
 *   hands craft promote <s>    move a personal craft to the repo-shared tier
 *   hands craft localize <s>   move a shared craft back to the personal tier
 *   hands craft distill [<s>]  list a craft's unfolded book/skill notes (mise is mechanical,
 *                              rebuilt from the DB on every export — nothing to distill there)
 *   hands craft brief <s>      dispatch: open a brief, print the chit (for a general-purpose Agent)
 *                              [--ticket <id>] names the tasks.id it's for, for the dashboard
 *                              [--mode execute] only if the craft is marked ready (hands craft ready)
 *   hands craft mise <id>      a craft sub-agent's first call: prints its book/mise/skill as JSON
 *   hands craft fold <s>       acquire the fold lease, print pending notes to distill (this also
 *                              exports any pending mise/book/skill notes to disk first)
 *   hands craft fold-done <s>  release the lease, mark notes folded (--through <noteId>)
 *   hands recipe ls            every recipe — state, rank, criteria progress (hands#96/#137)
 *   hands recipe new <s>       draft a stub — the principal (or /hands:recipe) fills it in
 *   hands recipe promote <s>   onto the menu [--rank N] (durably journaled — menu history)
 *   hands recipe demote <s>    back to the book (durably journaled)
 *   hands recipe history <d>   which recipes were on the menu on date d (YYYY-MM-DD)
 *   hands recipe sync <s>      re-mirror a recipe's criteria into SQL for grading (hands#116) —
 *                               also runs automatically on new/promote/demote
 *   hands recipe grade <s>     record a grading verdict [--criterion <hash>] --verdict
 *                               met|not_met|partial [--note] [--evidence-task <id>] (hands#116)
 *   hands station add [-n N] [--without-bypass]  open N stations (worktree hidden inside)
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
 *   hands usage [low|normal]  the global economy dial — no arg prints the current mode
 *   hands paths               where this cwd resolves (debug)
 *
 * The MCP server, hooks, and skills are registered by the PLUGIN; this bin is
 * the human/expo-facing lifecycle tool (on the Bash PATH via plugin/bin).
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as os from "node:os";
import { CONFIG_BASENAME, loadConfig, userConfigPath } from "./config.js";
import { isSous, resolveAgentId } from "./identity.js";
import { dbPath, notifyPath, repoInfo } from "./paths.js";
import { pathsReport } from "./server.js";
import {
  addStations,
  launch,
  launchCommand,
  type LaunchMode,
  type LaunchPlan,
  listStations,
  ProvisionError,
  removeStation,
  scaleStations,
} from "./provision.js";
import { listRegisteredProjects, registerProject, resolveProject } from "./projects.js";
import { reconcileStationShipPermissions, seedStationPermissions } from "./seed-permissions.js";
import { idleMs, latestSessionId, recentActivity, transcriptDir } from "./station-logs.js";
import { runDoctor } from "./doctor.js";
import { claimWorktree, releaseWorktree } from "./worktree-lock.js";
import { quiesce, watchersFor } from "./watchers.js";
import { readJournal, readPreviousPage } from "./journal-read.js";
import { assessReadiness, currentWorktreeFacts } from "./attest.js";
import { buildInfo, describe, otherInstall } from "./version.js";
import { regenerateDigests } from "./digest.js";
import {
  checkOriginCompatible,
  craftFiles,
  ensureLocalBooksOrigin,
  githubUsername,
  journalDir,
  listProjects,
  openJournal,
  personalCraftsDir,
  readEvents,
  replayInto,
  // aliased: projects.js already exports an unrelated resolveProject (kitchen-name → repo path);
  // this one resolves the books journal's project KEY for a cwd — different signature, same name.
  resolveProject as resolveJournalProject,
  resolveHandle,
  sharedCraftsDir,
  syncPull,
  syncPush,
  validateJournal,
} from "./remote.js";
import {
  booksDistilledRecently,
  buildFoldContext,
  composeChit,
  craftAgentPath,
  craftKnown,
  exportPendingCraftNotes,
  FOLD_READY_THRESHOLD,
  isRoleCraft,
  listCrafts,
  materializeCraftAgents,
  nearestCraftSlugs,
  parseCraftHeader,
  readMiseMerged,
  readRawMerged,
  stampCraftFocus,
  stampCraftReadiness,
  sweepHeldSeatHeader,
} from "./crafts.js";
import {
  criterionHash,
  currentMenu,
  listRecipes,
  menuOnDay,
  newRecipeStub,
  parseRecipe,
  recipeFiles,
  stampRecipeState,
} from "./recipes.js";
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

/** `--name value` or `--name=value`, either form. */
function strOpt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i !== -1) return argv[i + 1];
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
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
    const model = p.model ?? "default model";
    if (p.launched) {
      out(`✔ ${p.id} up (${model}, via ${p.launcher})`);
    } else {
      out(`● ${p.id} provisioned (${model}) — start it by pasting into a new terminal:`);
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
    const plans = addStations(n, { withoutBypass: flag(argv, "--without-bypass") });
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
      // Books are load-bearing, not optional (hands#129) — nothing configured just means the
      // default local-only origin, never "off". Never written into hands.config.json: that file
      // is repo-level and shared, and this path is per-machine (under coordinationDir).
      const local = ensureLocalBooksOrigin();
      if (local) {
        out(`books: local only — ${local} (handle "${String(remote.handle ?? os.userInfo().username)}")`);
        out("  this machine only — not shared. hands books <url> to sync across machines/collaborators.");
      } else {
        out("books are unavailable in this environment — git isn't working (run: hands doctor)");
      }
    }
    return;
  }

  // hands#181: a clone may already exist under the OLD url (or the local
  // bootstrap origin) with real history. Check compatibility BEFORE writing
  // anything — refusing here, with immediate feedback, beats writing a config
  // that silently orphans the local mirror the next time something opens the
  // journal. ensureRepo() carries the same guard as a backstop for a
  // hand-edited config, but this is the fast, honest path.
  const dir = journalDir();
  if (fs.existsSync(path.join(dir, ".git"))) {
    const compat = checkOriginCompatible(dir, url);
    if (!compat.ok) {
      fail(compat.reason ?? `${dir} and ${url} share no common history — refusing to repoint`);
    }
    if (compat.unverified) {
      out(`  (could not verify ${url}'s history is compatible with the existing local clone — proceeding anyway)`);
    }
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

/**
 * `hands usage [low|normal]` — the global economy dial (`/hands:low-usage`,
 * `/hands:normal-usage`). Writes to the USER-level config
 * (~/.claude/hands.config.json), deliberately NOT the repo file — this is
 * the one write command that's meant to be machine-wide, not per-repo, so a
 * station/expo pane in ANY repo picks it up on its next `hands_board` poll
 * (that tool's handler reads `loadConfig()` fresh every call — no caching
 * surprise, no restart needed).
 */
function cmdUsage(argv: string[]): void {
  const mode = argv.find((a) => !a.startsWith("--"));
  if (!mode) {
    const merged = loadConfig().usage.mode;
    if (merged === "normal") {
      out("usage mode: normal (default)");
      return;
    }
    const userPath = userConfigPath();
    let setByUser = false;
    try {
      const raw = JSON.parse(fs.readFileSync(userPath, "utf8")) as { usage?: { mode?: string } };
      setByUser = raw.usage?.mode === merged;
    } catch {
      // unreadable/missing user file — the repo layer must be the source instead
    }
    out(`usage mode: ${merged} (${setByUser ? "set machine-wide via \`hands usage\`" : "set by this repo's hands.config.json"})`);
    return;
  }
  if (mode !== "low" && mode !== "normal") fail("usage: hands usage [low|normal]");

  const configPath = userConfigPath();
  let cfg: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      fail(`${configPath} is not valid JSON: ${String(err)}`);
    }
  }
  cfg.usage = { mode };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  out(`✔ usage mode: ${mode} (machine-wide — every repo; already-running panes pick it up on their next hands_board poll)`);
}

/**
 * `hands craft ls|sync|promote|localize|distill|brief|mise|fold|fold-done` —
 * crafts are dispatched as sub-agents via `hands craft brief`/`mise`/`fold`,
 * never held by a station (hands#81/#96); these are plain CLI subcommands
 * invoked over Bash rather than MCP tools, so a craft-turn's dispatch never
 * costs every other session an MCP tool schema it doesn't use. `ls`,
 * `promote`, `localize`, and `sync` cover the human-facing, non-agentic
 * slice: seeing the roster, materializing crafts into real
 * session-discoverable Agent types + Skills (`sync`), and moving a craft
 * between scope tiers. Distillation itself is a judgment call (rewrite
 * prose, decide what to discard) that needs a model — `distill` here only
 * surfaces the backlog for a human to read or hand to an agent via
 * `hands craft fold`; it never rewrites a book itself.
 */
function cmdCraft(argv: string[]): void {
  const sub = argv[0];
  const cfg = loadConfig();
  const store = new Store();
  try {
    if (sub === "ls" || !sub) {
      const roster = listCrafts(store, cfg);
      if (roster.length === 0) {
        out("no crafts founded yet — /hands:crafts surveys a repo for the ones worth establishing");
        return;
      }
      const cwd = process.cwd();
      for (const c of roster) {
        const distilled = c.distilled ? `distilled ${c.distilled}` : "never distilled";
        const foldReady = c.pendingNotes >= FOLD_READY_THRESHOLD ? " — ready to fold" : "";
        const pending = c.pendingNotes ? `, ${c.pendingNotes} pending note(s)${foldReady}` : "";
        // "brief-only" (not "not yet synced") — a personal or freshly-founded craft is fully
        // dispatchable right now via `hands craft brief`; it's only the one-call Agent-tool path
        // that needs `hands craft sync` first. The old wording read as "not available" and
        // suppressed dispatch (hands#167).
        const synced = fs.existsSync(craftAgentPath(cwd, c.slug)) ? "" : ", brief-only here";
        // hands#92: readiness is a JUDGMENT (hands craft ready, sous-owned) — never inferred
        // from synced/distilled state. Legible reason, not a mystery, when it's not set.
        const readiness = c.ready
          ? `ready (execute) — ${c.ready.at} by ${c.ready.by}`
          : "plan-mode only — not yet marked ready for service";
        out(`${c.slug}\t[${c.scope}${synced}]\t${readiness}\t${c.covers ?? "no covers stated"}\t${distilled}${pending}`);
      }
      const distilledCount = booksDistilledRecently(roster, Date.now());
      out(`\n${distilledCount} book(s) distilled in the last 7 days.`);
      const orphans = store.orphanCraftBriefSlugs(roster.map((c) => c.slug));
      if (orphans.length > 0) {
        out("");
        out(
          `${orphans.length} slug(s) have recorded dispatches but no matching craft file — likely phantom ` +
            "briefs from a mistyped/stale name (hands#165), not real usage:",
        );
        for (const o of orphans) out(`  "${o.slug}" — ${o.count} brief(s)`);
      }
      return;
    }

    if (sub === "ready" || sub === "unready") {
      // hands#92: execute-mode's trust bar is a JUDGMENT ("the sous has deemed this craft ready
      // for service"), not a mechanical fact — so this command records that judgment rather than
      // computing one. Sous-owned once a sous pane exists (hands#87/#171 — "stewards crafts");
      // hand-operable by anyone until then, but the stamp always names who actually called it, so
      // that's never ambiguous after the fact.
      const slug = argv[1];
      if (!slug) fail(`usage: hands craft ${sub} <slug>`);
      const files = craftFiles(slug!);
      if (isRoleCraft(files.slug)) {
        fail(
          `"${files.slug}" is a role craft (hands#139) — it judges, it never writes files, so it ` +
            "never needs execute mode. Not a missing certification; not markable.",
        );
      }
      if (!fs.existsSync(files.book)) {
        fail(`unknown craft "${files.slug}" — no book found for it (\`hands craft ls\` for the roster)`);
      }
      const raw = fs.readFileSync(files.book, "utf8");
      if (sub === "unready") {
        fs.writeFileSync(files.book, stampCraftReadiness(raw, null));
        out(`✔ "${files.slug}" reverted to plan-mode only`);
        return;
      }
      const agentId = resolveAgentId();
      const at = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(files.book, stampCraftReadiness(raw, { at, by: agentId }));
      out(`✔ "${files.slug}" marked ready for service (execute mode) — ${at} by ${agentId}`);
      if (!isSous(agentId)) {
        out(
          `  note: this is the sous's call once a sous pane exists (hands#87/#171) — recorded as set ` +
            `by "${agentId}" for now, hand-operable until then.`,
        );
      }
      out("  a synced Agent dispatch picks this up on the next `hands craft sync`; `hands craft brief --mode execute` works immediately.");
      return;
    }

    if (sub === "focus") {
      // hands#114: the LENS a craft's ingest/lint discipline checks against — genuinely separate
      // from `covers` (scope). No role-craft gate like ready/unready has: there's no structural
      // reason to forbid an ordinary craft from stating one too, even though covers alone usually
      // already does that job for a domain craft.
      const slug = argv[1];
      if (!slug) fail('usage: hands craft focus <slug> ["<text>" | --clear]');
      const files = craftFiles(slug!);
      if (!fs.existsSync(files.book)) {
        fail(`unknown craft "${files.slug}" — no book found for it (\`hands craft ls\` for the roster)`);
      }
      const raw = fs.readFileSync(files.book, "utf8");
      const rest = argv.slice(2);
      if (rest.length === 0) {
        const { focus } = parseCraftHeader(raw);
        out(focus ? `${files.slug}: ${focus}` : `${files.slug}: no focus set`);
        return;
      }
      if (rest[0] === "--clear") {
        fs.writeFileSync(files.book, stampCraftFocus(raw, null));
        out(`✔ "${files.slug}" focus cleared`);
        return;
      }
      const focus = rest.join(" ").trim();
      fs.writeFileSync(files.book, stampCraftFocus(raw, focus));
      out(`✔ "${files.slug}" focus set: ${focus}`);
      return;
    }

    if (sub === "promote" || sub === "localize") {
      const slug = argv[1];
      if (!slug) fail(`usage: hands craft ${sub} <slug>`);
      const files = craftFiles(slug!);
      if (isRoleCraft(files.slug)) {
        fail(`"${files.slug}" is a role craft (hands#139) — not tier-mutable. It lives in the shared tier by construction.`);
      }
      const wantScope = sub === "promote" ? "shared" : "personal";
      if (files.scope === wantScope) fail(`"${files.slug}" is already ${wantScope}`);
      const info = repoInfo(process.cwd());
      if (!info) fail("not inside a git repo — run from your repo's main checkout");
      const shared = sharedCraftsDir(cfg, info!.repoRoot);
      if (!shared) fail("could not resolve the shared crafts dir");
      const personal = personalCraftsDir(cfg);
      const targetDir = sub === "promote" ? shared! : personal;
      const sourceDir = sub === "promote" ? personal : shared!;

      if (sub === "promote" && fs.existsSync(path.join(shared!, `${files.slug}.md`))) {
        fail(`a shared craft named "${files.slug}" already exists — resolve manually, then localize or edit it directly`);
      }

      fs.mkdirSync(targetDir, { recursive: true });
      const moved: string[] = [];
      for (const name of [`${files.slug}.md`, `${files.slug}.mise.md`, `${files.slug}.skill.md`]) {
        const from = path.join(sourceDir, name);
        if (!fs.existsSync(from)) continue;
        fs.copyFileSync(from, path.join(targetDir, name));
        fs.rmSync(from);
        moved.push(name);
      }
      if (moved.length === 0) fail(`no files found for "${files.slug}" at ${sourceDir}`);
      materializeCraftAgents(cfg, info!.repoRoot, process.env, info!.repoRoot);

      if (sub === "promote") {
        try {
          execFileSync("git", ["add", ...moved.map((m) => path.join(shared!, m))], { cwd: info!.repoRoot, stdio: "ignore" });
        } catch {
          // best-effort — staging failure just means the human runs git add themselves
        }
        out(`✔ "${files.slug}" promoted to shared — staged at ${shared}, not committed`);
        out(`  next: git commit -m "craft: promote ${files.slug} to shared" && open a PR`);
      } else {
        try {
          execFileSync("git", ["rm", "--cached", "-q", ...moved.map((m) => path.join(shared!, m))], {
            cwd: info!.repoRoot,
            stdio: "ignore",
          });
        } catch {
          // best-effort — same as above
        }
        out(`✔ "${files.slug}" localized — copied to ${personal}, unstaged from the repo`);
        out(`  next: git commit -m "craft: localize ${files.slug}" (or git checkout . to keep it shared)`);
      }
      return;
    }

    if (sub === "sync") {
      const info = repoInfo(process.cwd());
      if (!info) fail("not inside a git repo — run from your repo's main checkout");
      const targets: Array<{ label: string; dir: string }> = [{ label: "main checkout", dir: info!.repoRoot }];
      for (const station of listStations(info!.repoRoot, cfg)) {
        if (station.present) targets.push({ label: station.id, dir: station.dir });
      }
      let total = 0;
      for (const t of targets) {
        const res = materializeCraftAgents(cfg, t.dir, process.env, info!.repoRoot);
        if (res.written.length > 0) out(`${t.label}: synced ${res.written.join(", ")}`);
        if (res.removed.length > 0) out(`${t.label}: removed stale ${res.removed.join(", ")}`);
        total += res.written.length;
      }
      if (total === 0) {
        out("no crafts to sync — /hands:crafts surveys a repo for the ones worth establishing");
      } else {
        out(`\n✔ synced ${targets.length} checkout(s)`);
        out("  running stations need a restart to pick this up — hands craft sync doesn't restart them itself");
      }
      return;
    }

    if (sub === "sweep-headers") {
      // hands#167: books founded before the sub-agent dispatch model still carry a `last held:
      // DATE by AGENT` header clause from the retired per-station-ownership model — a generalist
      // reading it reasonably concludes the craft belongs to someone else and skips dispatching
      // it. Mechanical, header-line-only rewrite; body prose ("belongs to another station") needs
      // a model's judgment and isn't touched here.
      const roster = listCrafts(store, cfg);
      let changed = 0;
      for (const c of roster) {
        const files = craftFiles(c.slug, process.env, process.cwd());
        const raw = fs.existsSync(files.book) ? fs.readFileSync(files.book, "utf8") : null;
        if (!raw) continue;
        const swept = sweepHeldSeatHeader(raw);
        if (!swept.changed) continue;
        fs.writeFileSync(files.book, swept.content);
        out(`✔ swept "${c.slug}" (${files.scope}) — dropped the held-seat ownership clause from its header`);
        changed++;
      }
      if (changed === 0) out("no craft headers carry held-seat language — nothing to sweep");
      else out(`\n${changed} book(s) updated — commit any that live in the shared tier.`);
      return;
    }

    if (sub === "distill") {
      const only = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
      const slugs = only ? [only] : store.pendingCraftSlugs();
      if (slugs.length === 0) {
        out("no pending craft notes to distill");
        return;
      }
      for (const slug of slugs) {
        const pending = store.pendingCraftNotes(slug);
        if (pending.length === 0) {
          if (only) out(`"${slug}": no pending notes`);
          continue;
        }
        out(`\n${slug} — ${pending.length} pending note(s):`);
        for (const n of pending) out(`  [${n.kind}] ${n.body} (from ${n.source_agent})`);
      }
      out(
        "\nThis lists the backlog only — distillation is a judgment call (mise notes, if any " +
          "slipped through, apply themselves mechanically the moment `hands craft fold` runs). " +
          "Read it and edit the book/skill by hand, or ask an agent to run " +
          "`hands craft fold <slug>` on this craft — `/hands:last-call` does this for every " +
          "craft with a backlog at end of shift.",
      );
      return;
    }

    // --- brief|mise|fold|fold-done: the craft dispatch/return loop, plain CLI over Bash rather
    // than MCP tools — an MCP tool's schema loads into every station/expo session's context on
    // every turn, even the turns that never touch a craft; Bash has no such per-command cost.
    // It also sidesteps a real unknown: whether a spawned sub-agent even inherits its parent's
    // MCP connections. Every agent has Bash, unconditionally, no discovery question at all.

    if (sub === "brief") {
      const slug = argv[1];
      if (!slug) {
        fail(
          "usage: hands craft brief <slug> [--task <text>] [--ticket <id>] [--mode plan|execute] [--cwd <dir>]",
        );
      }
      const mode = strOpt(argv, "--mode") === "execute" ? "execute" : "plan";
      // NB: `--cwd` is the EXECUTE-lease/brief-record key (which worktree the sub-agent edits
      // in) — the craft's own book/mise/skill always resolve against this command's real
      // process.cwd() (unchanged from before hands#165), same as `craftFiles(slug!)` did.
      const cwd = strOpt(argv, "--cwd") ?? process.cwd();
      const files = craftFiles(slug!);
      const { known, slugs } = craftKnown(files.slug, cfg);
      if (!known) {
        const nearest = nearestCraftSlugs(files.slug, slugs);
        fail(
          `unknown craft "${files.slug}" — no book found for it` +
            (slugs.length === 0
              ? " (no crafts founded yet — /hands:crafts surveys a repo for the ones worth establishing)"
              : nearest.length > 0
                ? `. Closest on the roster: ${nearest.join(", ")}`
                : "") +
            " — `hands craft ls` for the full roster. Not recording a dispatch for it.",
        );
      }
      const bookRaw = fs.existsSync(files.book) ? fs.readFileSync(files.book, "utf8") : null;
      const header = parseCraftHeader(bookRaw);
      if (mode === "execute") {
        // hands#92: "not ready → plan mode, no exceptions" — enforced HERE, the one place every
        // execute-mode request passes through (the generated craft-agent template only ever asks
        // for execute when it already saw `ready` set at sync time, but a hand-typed `--mode
        // execute` must be refused just as hard, or the gate is decorative).
        if (!header.ready) {
          fail(
            `"${files.slug}" is not ready for execute-mode dispatch — no readiness judgment on file ` +
              `(plan mode only). \`hands craft ready ${files.slug}\` is how a craft graduates, once ` +
              "its book/mise are solid — that call is the sous's (hands#87/#171), not this command's.",
          );
        }
        const open = store.openExecuteBrief(files.slug, cwd);
        if (open) {
          fail(
            `execute lease held by brief #${open.id} (opened ${new Date(open.created_at).toISOString()}) ` +
              "— run this plan-mode, or wait",
          );
        }
      }
      const ticketArg = strOpt(argv, "--ticket");
      const ticketId = ticketArg !== undefined ? Number.parseInt(ticketArg, 10) : null;
      if (ticketArg !== undefined && !Number.isInteger(ticketId)) fail("--ticket must be an integer ticket id");
      const briefId = store.createCraftBrief({
        craftSlug: files.slug,
        mode,
        cwd,
        openedBy: resolveAgentId(),
        task: strOpt(argv, "--task") ?? null,
        ticketId,
      });
      const brief = store.getCraftBrief(briefId)!;
      // Raw chit text on stdout, nothing wrapped around it — the caller pastes this straight
      // into the Agent tool's prompt (or captures it via $(...) in a shell).
      out(composeChit(brief, header.covers, cfg.usage.mode));
      return;
    }

    if (sub === "mise") {
      const briefId = Number.parseInt(argv[1] ?? "", 10);
      if (!Number.isInteger(briefId)) fail("usage: hands craft mise <briefId>");
      const brief = store.getCraftBrief(briefId);
      if (!brief) fail(`no such brief: #${briefId}`);
      store.markCraftBriefPickedUp(briefId);
      const files = craftFiles(brief!.craft_slug);
      // hands#114/#223 storage fix: best-effort courtesy export first (keeps the git-committed
      // file caught up for browsability), then read book/mise/skill MERGED with whatever's still
      // pending — the DB is truth, so this response is always complete regardless of whether the
      // export above actually landed (lease contention just means this round skipped it).
      exportPendingCraftNotes(store, files, `mise-read:${process.pid}`);
      const stillPending = store.pendingCraftNotes(files.slug);
      const book = readRawMerged(files.book, stillPending, "book");
      const mise = readMiseMerged(store, files.slug);
      const skill = readRawMerged(files.skill, stillPending, "skill");
      const { covers, distilled, focus } = parseCraftHeader(book);
      const distilledMs = distilled ? Date.parse(distilled) : Number.NaN;
      const staleness =
        !book && !mise && !skill
          ? "cold"
          : Number.isNaN(distilledMs) || Date.now() - distilledMs > 14 * 24 * 60 * 60_000
            ? "stale"
            : "fresh";
      const siblings = listCrafts(store, cfg)
        .filter((c) => c.slug !== files.slug)
        .map((c) => ({ slug: c.slug, covers: c.covers }));
      out(
        JSON.stringify(
          {
            craft: files.slug,
            scope: files.scope,
            covers,
            focus,
            distilled,
            mise,
            skill,
            book,
            siblings,
            staleness,
            usageMode: cfg.usage.mode,
            readIn: staleness !== "fresh" ? `git log --oneline --since "${distilled ?? "30 days ago"}" -- ${covers ?? "."}` : null,
            returnContract:
              "Before you return: emit a fenced ```craft-note block (brief, craft, nothing-new, then " +
              "zero or more mise/book/skill/friction/spillover(<craft>) lines) as the LAST thing in " +
              "your final message.",
          },
          null,
          2,
        ),
      );
      return;
    }

    if (sub === "fold") {
      const slug = argv[1];
      if (!slug) fail("usage: hands craft fold <slug>");
      const files = craftFiles(slug!);
      const holder = resolveAgentId();
      const got = store.acquireCraftFoldLease(files.slug, holder);
      if (!got) fail(`fold lease for "${files.slug}" is held by someone else right now — try again shortly`);
      out(JSON.stringify(buildFoldContext(store, slug!, holder), null, 2));
      return;
    }

    if (sub === "fold-done") {
      const slug = argv[1];
      const through = Number.parseInt(strOpt(argv, "--through") ?? "", 10);
      if (!slug || !Number.isInteger(through)) fail("usage: hands craft fold-done <slug> --through <noteId>");
      const files = craftFiles(slug!);
      store.markCraftNotesFolded(files.slug, through);
      store.releaseCraftFoldLease(files.slug, resolveAgentId());
      out(`✔ folded "${files.slug}" through note #${through}, lease released`);
      return;
    }

    fail(
      "usage: hands craft <ls|ready|unready|focus|sync|sweep-headers|promote|localize|distill|brief|mise|fold|fold-done> [<slug>]",
    );
  } finally {
    store.close();
  }
}

/**
 * `hands recipe ls|new|promote|demote|history|sync|grade` (hands#96/#137/#116) — replaces
 * `priorities.md`/`hands_priorities`. Recipes are principal-authored (one file, one owner — no
 * scope tiers to promote between like crafts have); this CLI is the scaffolding + state-transition
 * surface, not a content editor — the principal edits the file directly for everything else.
 * `promote`/`demote` are the only state-changing verbs and are the only ones that touch the
 * journal (durable "which recipes were on the menu which days" history, hands#96) — `ls`/`history`
 * are pure reads. `new`/`promote`/`demote`/`sync` all mirror the recipe's current criteria into
 * SQL (hands#116) — the file stays truth, SQL is a synced index so criteria have stable,
 * gradeable identity; see `syncRecipeCriteria` in store.ts for what happens when they disagree.
 */
function cmdRecipe(argv: string[]): void {
  const sub = argv[0];
  const cfg = loadConfig();

  if (sub === "ls" || !sub) {
    const recipes = listRecipes(cfg);
    if (recipes.length === 0) {
      out("no recipes drafted yet — hands recipe new <slug> to start one, or /hands:recipe to be walked through it");
      return;
    }
    for (const r of recipes) {
      const rank = r.state === "menu" ? ` #${r.rank ?? "?"}` : "";
      const criteria = r.criteriaTotal > 0 ? `, ${r.criteriaDone}/${r.criteriaTotal} criteria met` : "";
      out(`${r.slug}\t[${r.state}${rank}]\t${r.title ?? "(no title)"}${criteria}`);
    }
    return;
  }

  if (sub === "history") {
    const date = argv[1];
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("usage: hands recipe history <YYYY-MM-DD>");
    const dir = journalDir();
    const project = resolveJournalProject(cfg);
    const handle = resolveHandle(cfg);
    const events = readEvents(dir, project, handle);
    const slugs = menuOnDay(events, date!);
    if (slugs.length === 0) {
      out(`no recipes recorded on the menu for ${date} (or the journal doesn't reach back that far)`);
    } else {
      out(`On the menu ${date}:`);
      for (const s of slugs) out(`  ${s}`);
    }
    return;
  }

  // Everything below touches SQL (criteria sync and/or grading) — one Store for the rest of this call.
  const store = new Store();
  try {
    const syncCriteria = (slug: string): void => {
      const files = recipeFiles(slug, cfg);
      const raw = fs.existsSync(files.path) ? fs.readFileSync(files.path, "utf8") : null;
      const recipe = parseRecipe(slug, raw);
      store.syncRecipeCriteria(
        slug,
        recipe.criteria.map((c) => ({ hash: criterionHash(c.text), text: c.text, done: c.done })),
      );
    };

    if (sub === "new") {
      const slug = argv[1];
      if (!slug) fail("usage: hands recipe new <slug> [--title <text>]");
      const files = recipeFiles(slug!, cfg);
      if (fs.existsSync(files.path)) fail(`"${files.slug}" already exists at ${files.path} — edit it directly`);
      const title = strOpt(argv, "--title") ?? slug!;
      fs.mkdirSync(files.dir, { recursive: true });
      fs.writeFileSync(files.path, newRecipeStub(title));
      syncCriteria(files.slug); // book-state recipes are gradeable immediately, not just once promoted
      out(`✔ drafted "${files.slug}" at ${files.path} — edit it directly to fill in the description and criteria`);
      return;
    }

    if (sub === "promote" || sub === "demote") {
      const slug = argv[1];
      if (!slug) fail(`usage: hands recipe ${sub} <slug>${sub === "promote" ? " [--rank N]" : ""}`);
      const files = recipeFiles(slug!, cfg);
      if (!fs.existsSync(files.path)) {
        fail(`unknown recipe "${files.slug}" — no file found at ${files.path} (\`hands recipe ls\` for the roster)`);
      }
      const raw = fs.readFileSync(files.path, "utf8");
      const now = Date.now();
      // Journal wiring is deliberately scoped to just this write, not the whole CLI process — a CLI
      // invocation is one-shot, unlike the long-running MCP server that wires it once at connect.
      const journal = openJournal({ cwd: process.cwd(), config: cfg });
      if (sub === "promote") {
        const rankArg = strOpt(argv, "--rank");
        const rank = rankArg ? Number.parseInt(rankArg, 10) : currentMenu(listRecipes(cfg)).length + 1;
        if (rankArg !== undefined && !Number.isInteger(rank)) fail("--rank must be an integer");
        fs.writeFileSync(files.path, stampRecipeState(raw, "menu", rank));
        journal?.append("recipe.promoted", { slug: files.slug, rank, at: now });
        out(`✔ "${files.slug}" onto the menu (#${rank})`);
      } else {
        fs.writeFileSync(files.path, stampRecipeState(raw, "book", null));
        journal?.append("recipe.demoted", { slug: files.slug, at: now });
        out(`✔ "${files.slug}" back to the book`);
      }
      if (!journal) out("  (books unavailable — state saved to the file, but this move won't show up in menu history)");
      syncCriteria(files.slug);
      return;
    }

    if (sub === "sync") {
      const slug = argv[1];
      if (!slug) fail("usage: hands recipe sync <slug>");
      const files = recipeFiles(slug!, cfg);
      if (!fs.existsSync(files.path)) {
        fail(`unknown recipe "${files.slug}" — no file found at ${files.path} (\`hands recipe ls\` for the roster)`);
      }
      syncCriteria(files.slug);
      const criteria = store.criteriaForRecipe(files.slug);
      out(`✔ synced "${files.slug}" — ${criteria.length} active criteria`);
      for (const c of criteria) out(`  ${c.criterion_hash}\t[${c.checkbox_done ? "x" : " "}]\t${c.text}`);
      return;
    }

    if (sub === "grade") {
      const slug = argv[1];
      const verdict = strOpt(argv, "--verdict");
      if (!slug || !verdict) fail("usage: hands recipe grade <slug> [--criterion <hash>] --verdict met|not_met|partial [--note <text>] [--evidence-task <id>]");
      if (verdict !== "met" && verdict !== "not_met" && verdict !== "partial") {
        fail(`--verdict must be met, not_met, or partial (got "${verdict}")`);
      }
      const files = recipeFiles(slug!, cfg);
      if (!fs.existsSync(files.path)) {
        fail(`unknown recipe "${files.slug}" — no file found at ${files.path} (\`hands recipe ls\` for the roster)`);
      }
      syncCriteria(files.slug); // never grade against a stale mirror
      const criterionHashArg = strOpt(argv, "--criterion");
      if (criterionHashArg) {
        const active = store.criteriaForRecipe(files.slug);
        if (!active.some((c) => c.criterion_hash === criterionHashArg)) {
          fail(
            `criterion "${criterionHashArg}" isn't among "${files.slug}"'s current criteria — ` +
              `\`hands recipe sync ${files.slug}\` to see current hashes.`,
          );
        }
      }
      const evidenceArg = strOpt(argv, "--evidence-task");
      const evidenceTaskId = evidenceArg ? Number.parseInt(evidenceArg, 10) : undefined;
      if (evidenceArg !== undefined && !Number.isInteger(evidenceTaskId)) fail("--evidence-task must be an integer task id");
      store.recordRecipeGrade({
        recipeSlug: files.slug,
        criterionHash: criterionHashArg ?? null,
        verdict,
        note: strOpt(argv, "--note") ?? null,
        evidenceTaskId: evidenceTaskId ?? null,
        originSha: currentWorktreeFacts(process.cwd()).originSha,
        by: resolveAgentId(),
      });
      out(
        `✔ graded "${files.slug}"${criterionHashArg ? ` (criterion ${criterionHashArg})` : " (overall)"}: ${verdict}. ` +
          "Not written back into the recipe file — the checkbox stays the principal's own signal.",
      );
      return;
    }

    fail("usage: hands recipe <ls|new|promote|demote|history|sync|grade> [<slug>]");
  } finally {
    store.close();
  }
}

function requireRemote() {
  const j = openJournal();
  if (!j) {
    // openJournal() only returns null now when even the local-default bootstrap failed —
    // attaching a URL wouldn't fix that; something's wrong with git itself.
    fail("books are unavailable in this environment — git isn't working (run: hands doctor)");
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

/** `hands restart [<project>] <station-N> [--without-bypass]` — recycle a wedged seat. */
function cmdRestart(argv: string[]): void {
  const { repoRoot, id, dir } = requireStation(argv, "restart");
  const cfg = loadConfig({ cwd: repoRoot });
  const withoutBypass = flag(argv, "--without-bypass");
  // Re-seed on the way through: a seat opened before seeding existed, or one
  // whose settings were removed, would otherwise come back up just as stuck.
  const seeded = seedStationPermissions(dir);
  if (seeded.written) out(`  seeded missing permission allowlist`);
  // Re-sync crafts too — a restart is a fresh Claude Code process, exactly the point where
  // newly-founded/edited crafts can finally become one-call-dispatchable here (hands#81/#96).
  const synced = materializeCraftAgents(cfg, dir, process.env, repoRoot);
  if (synced.written.length > 0) out(`  synced ${synced.written.length} craft(s)`);
  const model = cfg.stations.overrides[id] ?? cfg.stations.model;
  // A restart is just a fresh launch in this terminal — there is no pane to
  // respawn into, because hands does not own one.
  const res = launch({ id, dir, model }, process.env, "station", { exec: true, withoutBypass });
  if (res.launched) process.exit(res.exitCode ?? 0);
  out(
    `no terminal to attach — paste this into one:\n\n  ${launchCommand({ id, dir, model }, "station", { withoutBypass })}\n`,
  );
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
  out(`attaching to ${id} — resuming ${sessionId}${model ? ` (${model})` : ""}`);
  // stdio: "inherit" hands the current terminal straight to the resumed
  // session — this command's whole point is putting a human back in the seat.
  const args = model ? ["--model", model, "--resume", sessionId] : ["--resume", sessionId];
  const res = spawnSync("claude", args, {
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
/**
 * `hands claim [--evict] [--release]` — take exclusive ownership of the station
 * worktree this session is running in (hands#153).
 *
 * Run by a station on startup, before it does any work. Two sessions in one
 * worktree will eventually clobber each other mid-edit and the losing write
 * leaves no trace; refusing to start is strictly better than coexisting.
 */
function cmdClaim(argv: string[]): void {
  const info = repoInfo(process.cwd());
  if (!info) fail("not inside a git repo");
  const worktree = process.cwd();
  const agentId = resolveAgentId({ cwd: worktree });

  if (argv.includes("--release")) {
    out(releaseWorktree(worktree) ? `✔ released ${worktree}` : "not held by this process — nothing to release");
    return;
  }

  const result = claimWorktree({ worktree, agentId, evict: argv.includes("--evict") });
  if (result.ok) {
    const note =
      result.previous === "stale"
        ? " (took over a stale claim)"
        : result.previous === "evicted"
          ? " (evicted the previous holder)"
          : result.previous === "self"
            ? " (already held)"
            : "";
    out(`✔ ${agentId} holds ${worktree}${note}`);
    return;
  }
  const held = result.heldBy;
  const age = Math.round((Date.now() - held.claimedAt) / 60_000);
  fail(
    `worktree already held by pid ${held.pid} (${held.agentId}, claimed ${age}m ago on ${held.hostname}) — ` +
      "do NOT start a second session here; they will commit over each other. " +
      "Use `hands claim --evict` to take it deliberately.",
  );
}

/**
 * `hands monitors [<station-N>] [--clear] [--all]` — what a station has armed,
 * and stop it (hands#133).
 *
 * Stopping a station's `/loop` does NOT stop its watchers: they are detached
 * and outlive the schedule. Five stations were "stopped" here and an hour later
 * one still had two live watchers, including a poll loop on a run that could
 * never complete — still able to wake, still spending quota.
 */
function cmdMonitors(argv: string[]): void {
  const info = repoInfo(process.cwd());
  if (!info) fail("not inside a git repo");
  const cfg = loadConfig({ cwd: info.repoRoot });
  const { words, flags } = parseArgs(argv, []);
  const targets = words.filter((w) => /^station-\d+$/.test(w));
  const stations = listStations(info.repoRoot, cfg).filter(
    (s) => targets.length === 0 || targets.includes(s.id),
  );
  if (stations.length === 0) fail(targets.length ? `no such station: ${targets.join(", ")}` : "no stations open");

  for (const station of stations) {
    // hands#202 — anchor to THIS station's resolved notify path, never a bare
    // `<id>.notify` substring (station ids repeat across every kitchen on
    // the machine). Every station shares one coordinationDir per repo, so
    // info.repoRoot (not station.dir) is the correct cwd to resolve it from.
    const notify = notifyPath(station.id, process.env, info.repoRoot);
    if (flags.has("--clear")) {
      const res = quiesce(station.id, { notifyPath: notify, worktree: station.dir, keepInbox: !flags.has("--all") });
      if (!res.supported) {
        out(`${station.id}: cannot inspect processes on this platform — nothing stopped`);
        continue;
      }
      out(`${station.id}: stopped ${res.stopped.length}, kept ${res.kept.length}`);
      for (const w of res.stopped) out(`    stopped pid ${w.pid}  ${w.command}`);
      for (const w of res.kept) out(`    kept    pid ${w.pid}  ${w.command}${w.isInbox ? "  (wake signal — use --all to stop it too)" : ""}`);
      continue;
    }
    const report = watchersFor(station.id, { notifyPath: notify, worktree: station.dir });
    if (report.watchers === null) {
      out(`${station.id}: UNKNOWN — cannot inspect processes on this platform`);
      continue;
    }
    const inbox = report.inboxAlive ? "inbox tail ALIVE" : "inbox tail DEAD — this station cannot be woken";
    out(`${station.id}: ${report.watchers.length} watcher(s), ${inbox}`);
    for (const w of report.watchers) out(`    pid ${w.pid}${w.isInbox ? " [inbox]" : ""}  ${w.command}`);
  }
}

/**
 * `hands journal read [--date YYYY-MM-DD] [--previous] [--limit N] [--pull]`
 *
 * The books were write-only from the agent side until this existed (hands#156).
 * `--previous` is the shift-start read: the last page strictly before today,
 * which handles a Monday reading Friday's close without date arithmetic.
 */
function cmdJournal(argv: string[]): void {
  const sub = argv[0];
  if (sub !== "read") fail("usage: hands journal read [--date YYYY-MM-DD] [--previous] [--limit N] [--pull]");
  const rest = argv.slice(1);
  const date = strOpt(rest, "--date");
  const limitRaw = strOpt(rest, "--limit");
  const result = flag(rest, "--previous")
    ? readPreviousPage({})
    : readJournal({
        date,
        limit: limitRaw ? Number.parseInt(limitRaw, 10) || 1 : 1,
        pull: flag(rest, "--pull"),
        maxBytes: flag(rest, "--json") ? 24_000 : 200_000,
      });

  if (flag(rest, "--json")) {
    out(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.ok) {
    out(`no page read: ${result.reason}`);
    if (result.available?.length) out(`  available: ${result.available.slice(0, 8).join(", ")}`);
    return;
  }
  for (const page of result.pages) {
    out(`\u2500\u2500\u2500\u2500 ${page.relPath}  (${page.lines} lines) \u2500\u2500\u2500\u2500`);
    out(page.text);
  }
}

/**
 * `hands attest [--json]` — a station declares itself clean and ready (hands#157).
 *
 * Machine-checked, not asserted: this re-derives every fact. A station cannot
 * attest by saying so, which is what stops "attested" degrading into "said so".
 * Declining is a first-class outcome — a station that reports "14 uncommitted
 * files I don't recognise" is giving the expo better information than any
 * outside inspection could.
 */
function cmdAttest(argv: string[]): void {
  const info = repoInfo(process.cwd());
  if (!info) fail("not inside a git repo");
  const agentId = resolveAgentId({ cwd: process.cwd() });
  if (!/^station-\d+$/.test(agentId)) {
    fail(`only stations attest — this resolves as "${agentId}". The expo checks its own checkout in /hands:line-check.`);
  }

  const store = new Store();
  try {
    const resuming = store
      .listTasks({ assignee: agentId, state: "in_progress" })
      .map((t) => `#${t.id}`);

    const readiness = assessReadiness({
      worktree: process.cwd(),
      agentId,
      resumingTickets: resuming,
      offline: flag(argv, "--offline"),
      notifyPath: notifyPath(agentId),
    });

    store.setAttestation({
      agentId,
      ok: readiness.ok,
      reason: readiness.reason,
      headSha: readiness.headSha,
      originSha: readiness.originSha,
      lockPid: readiness.lockPid,
      details: readiness.checks,
    });

    if (flag(argv, "--json")) {
      out(JSON.stringify(readiness, null, 2));
      return;
    }
    for (const c of readiness.checks) out(`${c.ok ? "\u2714" : "\u2718"} ${c.name.padEnd(10)} ${c.detail}`);
    out("");
    if (readiness.ok) {
      out(`\u2714 ${agentId} attested clean and ready — the expo can dispatch to it`);
      return;
    }
    out(`\u2718 ${agentId} is NOT ready. Recorded, with the reason, so the expo can see it.`);
    out("  Get clean with /hands:ready. Never discard work that has no other copy —");
    out("  staying unattested and saying why is better than losing something.");
    process.exit(1);
  } finally {
    store.close();
  }
}

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
function launchAt(
  dir: string,
  mode: LaunchMode,
  id: string,
  model?: string | null,
  opts?: { withoutBypass?: boolean },
): void {
  out(`${id} → ${dir}`);
  // Hand this terminal straight to the session. Blocks until it exits, and
  // exits with its status — opening a seat IS running it, not scheduling it.
  const res = launch({ id, dir, model }, process.env, mode, { exec: true, ...opts });
  if (res.launched) process.exit(res.exitCode ?? 0);
  // No TTY to hand over (piped stdin, a script): print the exact command
  // instead of failing. The only remaining non-exec path for a single seat.
  out(`no terminal to attach — paste this into one:\n\n  ${launchCommand({ id, dir, model }, mode, opts)}\n`);
}

/** Open a station seat by id within `repoRoot`, or fail naming what exists. */
function launchStation(repoRoot: string, stationId: string, opts?: { withoutBypass?: boolean }): void {
  const cfg = loadConfig({ cwd: repoRoot });
  const stations = listStations(repoRoot, cfg);
  const match = stations.find((s) => s.id === stationId);
  if (!match) {
    const known = stations.map((s) => s.id).join(", ") || "none open";
    fail(`no ${stationId} in ${repoRoot} — stations: ${known}`);
  }
  if (!match.present) fail(`${stationId}'s worktree is missing (${match.dir}) — re-open it with \`hands station add\``);
  launchStationSeat(repoRoot, match.id, match.dir, cfg, opts);
}

function launchStationSeat(
  _repoRoot: string,
  id: string,
  dir: string,
  cfg: ReturnType<typeof loadConfig>,
  opts?: { withoutBypass?: boolean },
): void {
  // Seed here too, not just at `station add`: a seat opened by hand, or one
  // created before seeding existed, would otherwise still stall on prompts.
  seedStationPermissions(dir);
  // hands#86: a seat provisioned before push/PR-create moved to ALLOW still has the old policy —
  // seedStationPermissions above is a no-op on an existing file, so this is what catches it up.
  reconcileStationShipPermissions(dir);
  launchAt(dir, "station", id, cfg.stations.overrides[id] ?? cfg.stations.model, opts);
}

/**
 * Resolve a bare word as a kitchen or a station and launch it.
 * Returns false when it resolves to neither, so the caller can fall through to
 * usage rather than this swallowing every typo.
 */
function tryLaunch(cmd: string | undefined, rest: string[]): boolean {
  const opts = { withoutBypass: flag(rest, "--without-bypass") };

  // `hands` bare → the pass, here.
  if (!cmd) {
    const info = repoInfo(process.cwd());
    if (!info || !fs.existsSync(path.join(info.repoRoot, CONFIG_BASENAME))) return false;
    launchAt(info.repoRoot, "expo", "expo", undefined, opts);
    return true;
  }

  // `hands station-2` → that seat in the current kitchen.
  if (STATION_ID.test(cmd)) {
    const info = repoInfo(process.cwd());
    if (!info) fail(`not inside a git repo — use \`hands <project> ${cmd}\``);
    launchStation(info.repoRoot, cmd, opts);
    return true;
  }

  // `hands sous` → a sous session for the current kitchen (hands#87/#93). No
  // worktree, no provisioning — runs wherever it's invoked, same as it always
  // could via `HANDS_ID=sous claude ...`. Requires being inside the repo so
  // it resolves the same bus (coordinationDir) as the expo/stations it talks
  // to; deliberately NOT repoRoot like expo's own bare launch, since sous has
  // no fixed home to normalize to.
  if (cmd === "sous") {
    const info = repoInfo(process.cwd());
    if (!info) fail(`not inside a git repo — use \`hands <project> sous\``);
    launchAt(process.cwd(), "sous", "sous", undefined, opts);
    return true;
  }

  // `hands ampersand [station-2|sous]` → someone else's kitchen.
  const project = resolveProject(cmd);
  if (!project) return false;
  const seat = rest[0];
  if (seat && STATION_ID.test(seat)) launchStation(project.repoRoot, seat, opts);
  else if (seat === "sous") launchAt(project.repoRoot, "sous", "sous", undefined, opts);
  else launchAt(project.repoRoot, "expo", "expo", undefined, opts);
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
      case "craft":
        return cmdCraft(rest);
      case "recipe":
        return cmdRecipe(rest);
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
      case "usage":
        return cmdUsage(rest);
      case "feedback":
        await cmdFeedback(rest);
        return;
      case "serve":
      case "dashboard": {
        const { serve, ServeError } = await import("./serve.js");
        const { flags } = parseArgs(rest, ["--address"]);
        const lan = flags.has("--lan");
        let handle: Awaited<ReturnType<typeof serve>>;
        try {
          handle = await serve(lan ? { host: "0.0.0.0" } : undefined);
        } catch (err) {
          if (err instanceof ServeError) fail(err.message);
          throw err;
        }
        out(`hands dashboard → ${handle.url}\n(Ctrl-C to stop)`);
        // hands#110 — --lan is opt-in: without it, serve()'s default (127.0.0.1) and this whole
        // block are untouched, so nothing about the normal desktop-dashboard posture changes.
        // Binding wider is what makes a phone reachable at all, but 0.0.0.0 itself isn't a
        // connectable address — a phone needs the machine's actual LAN-facing IPv4.
        if (lan) {
          const { pickLanAddress } = await import("./lan.js");
          const addressOverride = flags.get("--address");
          const pick = addressOverride
            ? { address: addressOverride, iface: null, candidates: [], ambiguous: false }
            : pickLanAddress();
          if (!pick.address) {
            out(
              "\n--lan requested, but no LAN-reachable network interface was found on this machine " +
                "— it may not be on a network a phone can join. No pairing QR to show; use the " +
                "manual host field in the mobile app's Settings tab instead.",
            );
          } else {
            if (pick.ambiguous) {
              const others = pick.candidates
                .filter((c) => c.address !== pick.address)
                .map((c) => `${c.iface}=${c.address}`)
                .join(", ");
              out(
                `\n${pick.candidates.length} network interfaces found — guessed ${pick.iface} ` +
                  `(${pick.address}). If the phone can't connect, override with: hands serve --lan ` +
                  `--address <ip>. Other candidates: ${others}`,
              );
            }
            const pairingUrl = `http://${pick.address}:${handle.port}/`;
            out(
              `\nScan from the mobile app's Settings tab to pair: ${pairingUrl}\n` +
                "⚠ this exposes EVERY route on this server to anyone on the current network while " +
                "--lan is running — not just read access to the dashboard, also filing feedback, " +
                "chat, and answering questions as if they were you. There is no authentication on " +
                "this tier. Stop with Ctrl-C when you're done pairing.\n",
            );
            const qrcodeTerminal = await import("qrcode-terminal");
            qrcodeTerminal.default.generate(pairingUrl, { small: true });
          }
        }
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
      case "claim":
        return cmdClaim(rest);
      case "journal":
        return cmdJournal(rest);
      case "attest":
        return cmdAttest(rest);
      case "monitors":
      case "quiesce":
        return cmdMonitors(rest);
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
        out("  hands [<project>] sous    open a sous session — no worktree, runs where invoked");
        out("  hands go <project> [station-N]  same, explicit (for scripts / name collisions)");
        out("  hands register [path]     enroll a kitchen so it resolves by name");
        out("  hands ls                  registered kitchens");
        out("");
        out("  hands doctor [--fix]      health check (--fix repairs what's safe to repair)");
        out("  hands logs <station-N>    what a station is actually doing (its own transcript)");
        out("  hands restart <station-N>  recycle a wedged station");
        out("  hands claim [--evict]     take exclusive ownership of this station worktree");
        out("  hands attest              declare this station clean and ready (station-only)");
        out("  hands monitors [<station>] [--clear]  what a station has armed; --clear stops strays");
        out("  hands journal read [--previous]  read the books back - last shift page");
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
        out("  hands serve --lan [--address <ip>]  also print a QR to pair the mobile app over the LAN");
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
