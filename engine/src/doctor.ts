import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_BASENAME, type HandsConfig, loadConfig } from "./config.js";
import { coordinationDir, dbPath, pidPath, repoInfo } from "./paths.js";
import { listStations } from "./provision.js";
import { pruneMissing, resolveProject } from "./projects.js";
import { personalCraftsDir, sharedCraftsDir } from "./remote.js";
import { seedStationPermissions } from "./seed-permissions.js";
import { idleMs } from "./station-logs.js";
import { Store } from "./store.js";

/**
 * `hands doctor` — the checks are not hypothetical. Every one of them
 * corresponds to a failure that actually silently degraded a live kitchen:
 *
 * - unseeded station worktrees → five stations, ~14h, zero tickets started
 * - a stale plugin build on PATH → `hands whoami` printing generic help while
 *   the working tree had the command, and MCP servers running last week's code
 * - an unbounded WAL → a 4KB database with a 1.5MB write-ahead log, because
 *   long-lived MCP connections keep a reader open so checkpoints never complete
 * - stations idle-but-alive → panes up, tickets assigned, nothing moving
 *
 * The through-line: each looks healthy from the outside. That's what makes them
 * worth a command.
 */

export type Severity = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  severity: Severity;
  detail: string;
  /** set when --fix can repair it, and describes what fixing would do */
  fixable?: string;
}

export interface DoctorReport {
  checks: Check[];
  worst: Severity;
}

/** Stations quiet longer than this are called out — not an error, but the thing you'd want to look at. */
const IDLE_WARN_MS = 30 * 60_000;
/** A WAL this much larger than the DB means checkpoints aren't completing. */
const WAL_RATIO_WARN = 10;

function worstOf(checks: Check[]): Severity {
  if (checks.some((c) => c.severity === "fail")) return "fail";
  if (checks.some((c) => c.severity === "warn")) return "warn";
  return "ok";
}

/** `kill(pid, 0)` sends no signal — it just probes whether the pid exists and is reachable. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it (different user) — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function gitHead(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

export function runDoctor(opts?: {
  cwd?: string;
  fix?: boolean;
  now?: number;
  env?: NodeJS.ProcessEnv;
  /** the executing script path; defaults to process.argv[1] (injectable for tests) */
  entry?: string;
}): DoctorReport {
  const cwd = opts?.cwd ?? process.cwd();
  const env = opts?.env ?? process.env;
  const now = opts?.now ?? Date.now();
  const checks: Check[] = [];

  const info = repoInfo(cwd);
  if (!info) {
    checks.push({ name: "repo", severity: "fail", detail: `${cwd} is not inside a git repo` });
    return { checks, worst: "fail" };
  }
  checks.push({ name: "repo", severity: "ok", detail: `${info.repoRoot} (${info.slug})` });

  // ── config ────────────────────────────────────────────────────────────────
  const configPath = path.join(info.repoRoot, CONFIG_BASENAME);
  let cfg: HandsConfig | null = null;
  if (!fs.existsSync(configPath)) {
    checks.push({
      name: "config",
      severity: "fail",
      detail: `no ${CONFIG_BASENAME} — run: hands init`,
    });
  } else {
    try {
      cfg = loadConfig({ cwd: info.repoRoot });
      checks.push({ name: "config", severity: "ok", detail: `principal: ${cfg.principal.name}` });
    } catch (err) {
      checks.push({
        name: "config",
        severity: "fail",
        detail: `${CONFIG_BASENAME} is unreadable: ${(err as Error).message}`,
      });
    }
  }

  // ── launcher registry ─────────────────────────────────────────────────────
  const name = path.basename(info.repoRoot);
  const registered = resolveProject(name, env);
  if (registered?.repoRoot === info.repoRoot) {
    checks.push({ name: "registry", severity: "ok", detail: `resolves as "${name}"` });
  } else {
    checks.push({
      name: "registry",
      severity: "warn",
      detail: `not reachable by name — \`hands ${name}\` won't find this repo`,
      fixable: "register this repo",
    });
  }
  const pruned = pruneMissing(env);
  if (pruned > 0) {
    checks.push({
      name: "registry.stale",
      severity: "ok",
      detail: `pruned ${pruned} entr${pruned === 1 ? "y" : "ies"} pointing at deleted repos`,
    });
  }

  // ── bus database ──────────────────────────────────────────────────────────
  const db = dbPath(env, info.repoRoot);
  if (!fs.existsSync(db)) {
    checks.push({
      name: "bus.db",
      severity: "warn",
      detail: "no database yet — normal before the first session takes a turn",
    });
  } else {
    const dbSize = fs.statSync(db).size;
    let walSize = 0;
    try {
      walSize = fs.statSync(`${db}-wal`).size;
    } catch {
      // no WAL — fine, nothing pending
    }
    if (walSize > dbSize * WAL_RATIO_WARN && walSize > 1_000_000) {
      checks.push({
        name: "bus.wal",
        severity: "warn",
        detail:
          `write-ahead log is ${(walSize / 1e6).toFixed(1)}MB against a ${(dbSize / 1e3).toFixed(0)}KB database — ` +
          "checkpoints aren't completing (long-lived MCP connections hold a reader open). " +
          "Harmless now; unbounded over days.",
      });
    } else {
      checks.push({ name: "bus.db", severity: "ok", detail: `${(dbSize / 1e3).toFixed(0)}KB` });
    }
  }

  // ── coordination dir ──────────────────────────────────────────────────────
  const coord = coordinationDir(env, info.repoRoot);
  checks.push(
    fs.existsSync(coord)
      ? { name: "coordination", severity: "ok", detail: coord }
      : { name: "coordination", severity: "warn", detail: `missing: ${coord}` },
  );

  // ── dashboard server (hands#77/#82) ───────────────────────────────────────
  // No pidfile at all just means the dashboard isn't running right now — not an error, nothing
  // to check. A pidfile pointing at a dead pid is the thing worth flagging: it means a previous
  // `hands serve` didn't shut down cleanly (killed rather than stopped), and `hands doctor --fix`
  // clearing it is what lets the pidfile-based stop path in the dashboard skill trust the file.
  const pid = pidPath(env, info.repoRoot);
  if (fs.existsSync(pid)) {
    const raw = fs.readFileSync(pid, "utf8").trim();
    const parsedPid = Number(raw);
    if (Number.isInteger(parsedPid) && parsedPid > 0 && isProcessAlive(parsedPid)) {
      checks.push({ name: "dashboard.serve", severity: "ok", detail: `running (pid ${parsedPid})` });
    } else if (opts?.fix) {
      fs.rmSync(pid, { force: true });
      checks.push({
        name: "dashboard.serve",
        severity: "ok",
        detail: `stale pidfile (pid ${raw || "?"} not running) — removed`,
      });
    } else {
      checks.push({
        name: "dashboard.serve",
        severity: "warn",
        detail: `stale pidfile — pid ${raw || "?"} isn't running`,
        fixable: "remove the stale pidfile",
      });
    }
  }

  // ── which build is actually executing ─────────────────────────────────────
  // Three separate confusing symptoms in one day traced back to this: a command
  // that "didn't exist" (it did, in the working tree), MCP servers running a
  // week-old build, and a rebuilt bundle nobody was using. The executing path
  // is a fact worth printing even when nothing is wrong.
  const running = opts?.entry ?? process.argv[1] ?? "";
  const cached = /plugins\/cache\/[^/]+\/[^/]+\/([0-9a-f]{7,40})\//.exec(running);
  if (cached?.[1]) {
    const pluginCommit = cached[1];
    const head = gitHead(info.repoRoot);
    // Only meaningful when this repo IS hands — elsewhere the plugin build has
    // no relationship to the checkout you happen to be standing in.
    const selfHosted = fs.existsSync(path.join(info.repoRoot, "plugin", ".claude-plugin", "plugin.json"));
    if (selfHosted && head && !head.startsWith(pluginCommit) && !pluginCommit.startsWith(head.slice(0, 7))) {
      checks.push({
        name: "build",
        severity: "warn",
        detail:
          `running the plugin build at ${pluginCommit}, but this checkout is at ${head.slice(0, 7)} — ` +
          "your changes aren't live. Update the plugin, and restart sessions so the MCP server reloads.",
      });
    } else {
      checks.push({ name: "build", severity: "ok", detail: `plugin build ${pluginCommit}` });
    }
  } else if (running) {
    checks.push({ name: "build", severity: "ok", detail: `running from source: ${running}` });
  }

  // ── stations ──────────────────────────────────────────────────────────────
  if (cfg) {
    const stations = listStations(info.repoRoot, cfg);
    if (stations.length === 0) {
      checks.push({ name: "stations", severity: "ok", detail: "none open" });
    }
    for (const station of stations) {
      if (!station.present) {
        checks.push({
          name: `${station.id}.worktree`,
          severity: "fail",
          detail: `worktree missing: ${station.dir}`,
        });
        continue;
      }

      // The check that would have caught today's fourteen-hour stall.
      const settings = path.join(station.dir, ".claude", "settings.local.json");
      if (fs.existsSync(settings)) {
        checks.push({ name: `${station.id}.permissions`, severity: "ok", detail: "seeded" });
      } else if (opts?.fix) {
        seedStationPermissions(station.dir);
        checks.push({
          name: `${station.id}.permissions`,
          severity: "ok",
          detail: "was unseeded — seeded now",
        });
      } else {
        checks.push({
          name: `${station.id}.permissions`,
          severity: "fail",
          detail: "no permission allowlist — this station will stall on a prompt before it can work",
          fixable: "seed the allowlist",
        });
      }

      const idle = idleMs(station.dir, now);
      if (idle === null) {
        checks.push({
          name: `${station.id}.activity`,
          severity: "warn",
          detail: "no transcript yet — never took a turn",
        });
      } else if (idle > IDLE_WARN_MS) {
        checks.push({
          name: `${station.id}.activity`,
          severity: "warn",
          detail: `quiet for ${Math.round(idle / 60_000)}m — check it with: hands logs ${station.id}`,
        });
      } else {
        checks.push({
          name: `${station.id}.activity`,
          severity: "ok",
          detail: `active ${Math.round(idle / 1000)}s ago`,
        });
      }
    }
  }

  // ── crafts (hands#81/#96/#49): shadowed collisions + unfolded note backlog ──
  if (cfg) {
    const shared = sharedCraftsDir(cfg, info.repoRoot);
    const personal = personalCraftsDir(cfg, env, info.repoRoot);
    const slugsIn = (dir: string | null): string[] => {
      if (!dir) return [];
      try {
        return fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".md") && !f.endsWith(".mise.md") && !f.endsWith(".skill.md"))
          .map((f) => f.slice(0, -".md".length));
      } catch {
        return [];
      }
    };
    const sharedSlugs = new Set(slugsIn(shared));
    const shadowed = slugsIn(personal).filter((s) => sharedSlugs.has(s));
    if (shadowed.length > 0) {
      checks.push({
        name: "crafts.shadowed",
        severity: "warn",
        detail:
          `${shadowed.join(", ")} — personal craft${shadowed.length === 1 ? "" : "s"} shadowed by a ` +
          "same-named SHARED craft; the shared copy is what every dispatch actually reads",
      });
    }

    // A doctor check must never crash on a DB hiccup — this is diagnostics, not the bus itself.
    // Driven by pendingCraftSlugs(), not the file-based roster — a craft can carry pending notes
    // before it's ever founded with a book file, and this must still catch that backlog.
    let store: Store | null = null;
    try {
      store = new Store({ env });
      const stale = store
        .pendingCraftSlugs()
        .map((slug) => {
          const pending = store!.pendingCraftNotes(slug);
          return { slug, count: pending.length, ageMs: now - (pending[0]?.created_at ?? now) };
        })
        .filter((c) => c.count >= 3 || c.ageMs > 24 * 60 * 60_000);
      if (stale.length > 0) {
        checks.push({
          name: "crafts.notes",
          severity: "warn",
          detail:
            `${stale.map((c) => `${c.slug} (${c.count} pending, oldest ${Math.round(c.ageMs / 60_000)}m)`).join(", ")} ` +
            "— run `hands craft distill` to fold them in",
        });
      }
    } catch {
      // best-effort — see comment above
    } finally {
      store?.close();
    }
  }

  return { checks, worst: worstOf(checks) };
}
