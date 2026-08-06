import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { addStations } from "../src/provision.js";
import { pidPath, resetRepoInfoCache } from "../src/paths.js";

let root: string;
let repo: string;
let handsHome: string;
let env: NodeJS.ProcessEnv;

const CONFIG = {
  principal: { name: "Michael" },
  topology: "strict-hub",
  stations: { model: "sonnet", overrides: {}, launcher: "manual", allowScaling: true },
  merge: { adminMergeLowRisk: false },
  gh: { poll: false },
};

function check(name: string, report: ReturnType<typeof runDoctor>) {
  return report.checks.find((c) => c.name === name);
}

/** A pid guaranteed dead by the time it's returned — spawnSync only resolves after exit. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (!result.pid) throw new Error("spawnSync didn't report a pid");
  return result.pid;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hands-doctor-"));
  handsHome = fs.mkdtempSync(path.join(os.tmpdir(), "hands-doctor-home-"));
  fs.mkdirSync(path.join(root, "kitchen"), { recursive: true });
  repo = fs.realpathSync(path.join(root, "kitchen"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  env = { HANDS_TEST_HOME: handsHome, HANDS_HOME: path.join(root, "coord") };
  resetRepoInfoCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(handsHome, { recursive: true, force: true });
  resetRepoInfoCache();
});

function writeConfig() {
  fs.writeFileSync(path.join(repo, "hands.config.json"), JSON.stringify(CONFIG, null, 2));
}

describe("runDoctor", () => {
  it("fails outside a git repo instead of reporting a healthy-looking nothing", () => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain, { recursive: true });
    const report = runDoctor({ cwd: plain, env });
    expect(report.worst).toBe("fail");
    expect(check("repo", report)?.severity).toBe("fail");
  });

  it("fails when the kitchen has no config", () => {
    const report = runDoctor({ cwd: repo, env });
    expect(check("config", report)?.severity).toBe("fail");
    expect(check("config", report)?.detail).toContain("hands init");
  });

  it("passes config and reports the principal once configured", () => {
    writeConfig();
    const report = runDoctor({ cwd: repo, env });
    expect(check("config", report)?.severity).toBe("ok");
    expect(check("config", report)?.detail).toContain("Michael");
  });

  it("warns when the kitchen isn't reachable by name", () => {
    writeConfig();
    const report = runDoctor({ cwd: repo, env });
    const registry = check("registry", report);
    expect(registry?.severity).toBe("warn");
    expect(registry?.fixable).toBeTruthy();
  });

  it("flags a stale plugin build against the checkout it's supposedly building", () => {
    writeConfig();
    // mark the repo as self-hosting (it contains the plugin manifest)
    fs.mkdirSync(path.join(repo, "plugin", ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(repo, "plugin", ".claude-plugin", "plugin.json"), "{}");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });

    const report = runDoctor({
      cwd: repo,
      env,
      entry: "/home/u/.claude/plugins/cache/hands/hands/deadbee/dist/cli.mjs",
    });
    const build = check("build", report);
    expect(build?.severity).toBe("warn");
    expect(build?.detail).toContain("aren't live");
  });

  it("reports running-from-source without crying skew", () => {
    writeConfig();
    const report = runDoctor({ cwd: repo, env, entry: "/repo/engine/src/cli.ts" });
    expect(check("build", report)?.severity).toBe("ok");
  });
});

describe("the station permission check — the fourteen-hour regression", () => {
  let worktreeRoot: string;

  /** Real station worktree via the real provisioner, then strip its settings. */
  function unseededStation(): string {
    worktreeRoot = path.join(root, "worktrees");
    fs.writeFileSync(
      path.join(repo, "hands.config.json"),
      JSON.stringify({ ...CONFIG, stations: { ...CONFIG.stations, worktreeRoot } }, null, 2),
    );
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"],
      { cwd: repo },
    );
    const [plan] = addStations(1, { cwd: repo, env: { ...env, TMUX: "" } });
    if (!plan) throw new Error("provisioner returned no station");
    // addStations seeds; remove it so we're testing the unseeded state
    fs.rmSync(path.join(plan.dir, ".claude"), { recursive: true, force: true });
    return plan.dir;
  }

  it("FAILS a station with no permission allowlist, and says why it matters", () => {
    unseededStation();
    const report = runDoctor({ cwd: repo, env });
    const perms = report.checks.find((c) => c.name === "station-1.permissions");
    expect(perms).toBeDefined();
    expect(perms?.severity).toBe("fail");
    expect(perms?.detail).toContain("stall");
    expect(report.worst).toBe("fail");
  });

  it("--fix seeds a missing allowlist rather than only complaining", () => {
    const dir = unseededStation();
    const settings = path.join(dir, ".claude", "settings.local.json");
    expect(fs.existsSync(settings)).toBe(false);

    const report = runDoctor({ cwd: repo, env, fix: true });

    expect(fs.existsSync(settings)).toBe(true);
    expect(JSON.parse(fs.readFileSync(settings, "utf8")).permissions.allow.length).toBeGreaterThan(0);
    expect(report.checks.find((c) => c.name === "station-1.permissions")?.severity).toBe("ok");
  });

  it("passes a station the provisioner seeded normally", () => {
    worktreeRoot = path.join(root, "worktrees");
    fs.writeFileSync(
      path.join(repo, "hands.config.json"),
      JSON.stringify({ ...CONFIG, stations: { ...CONFIG.stations, worktreeRoot } }, null, 2),
    );
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"],
      { cwd: repo },
    );
    addStations(1, { cwd: repo, env: { ...env, TMUX: "" } });

    const report = runDoctor({ cwd: repo, env });
    expect(report.checks.find((c) => c.name === "station-1.permissions")?.severity).toBe("ok");
  });
});

describe("the dashboard.serve pidfile check (hands#77/#82)", () => {
  it("reports nothing when the dashboard was never started", () => {
    writeConfig();
    const report = runDoctor({ cwd: repo, env });
    expect(check("dashboard.serve", report)).toBeUndefined();
  });

  it("passes when the pidfile points at a live process", () => {
    writeConfig();
    fs.mkdirSync(path.dirname(pidPath(env, repo)), { recursive: true });
    fs.writeFileSync(pidPath(env, repo), String(process.pid));
    const report = runDoctor({ cwd: repo, env });
    expect(check("dashboard.serve", report)?.severity).toBe("ok");
    expect(check("dashboard.serve", report)?.detail).toContain(String(process.pid));
  });

  it("warns on a stale pidfile left by an unclean stop, and names the fix", () => {
    writeConfig();
    fs.mkdirSync(path.dirname(pidPath(env, repo)), { recursive: true });
    fs.writeFileSync(pidPath(env, repo), String(deadPid()));
    const report = runDoctor({ cwd: repo, env });
    const dash = check("dashboard.serve", report);
    expect(dash?.severity).toBe("warn");
    expect(dash?.fixable).toBeTruthy();
  });

  it("--fix removes a stale pidfile rather than only complaining", () => {
    writeConfig();
    fs.mkdirSync(path.dirname(pidPath(env, repo)), { recursive: true });
    fs.writeFileSync(pidPath(env, repo), String(deadPid()));
    const report = runDoctor({ cwd: repo, env, fix: true });
    expect(fs.existsSync(pidPath(env, repo))).toBe(false);
    expect(check("dashboard.serve", report)?.severity).toBe("ok");
  });
});

describe("crafts checks (hands#81/#96/#49)", () => {
  it("warns when a personal craft is shadowed by a same-named shared craft", () => {
    writeConfig();
    const shared = path.join(repo, ".hands", "crafts");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "saucier.md"), "> covers: sauces\n");
    const personal = path.join(root, "coord", "crafts");
    fs.mkdirSync(personal, { recursive: true });
    fs.writeFileSync(path.join(personal, "saucier.md"), "> covers: SHADOWED\n");

    const report = runDoctor({ cwd: repo, env });
    const shadowed = check("crafts.shadowed", report);
    expect(shadowed?.severity).toBe("warn");
    expect(shadowed?.detail).toContain("saucier");
  });

  it("says nothing when no personal craft collides with a shared one", () => {
    writeConfig();
    const report = runDoctor({ cwd: repo, env });
    expect(check("crafts.shadowed", report)).toBeUndefined();
  });

  it("warns on a craft with a large or aging unfolded-note backlog", async () => {
    writeConfig();
    const { Store } = await import("../src/store.js");
    const store = new Store({ env });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-1", kind: "book", body: "a" });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-1", kind: "book", body: "b" });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-1", kind: "book", body: "c" });
    store.close();

    const report = runDoctor({ cwd: repo, env });
    const notes = check("crafts.notes", report);
    expect(notes?.severity).toBe("warn");
    expect(notes?.detail).toContain("saucier");
    expect(notes?.detail).toContain("3 pending");
  });

  it("says nothing when there's no unfolded-note backlog", () => {
    writeConfig();
    const report = runDoctor({ cwd: repo, env });
    expect(check("crafts.notes", report)).toBeUndefined();
  });
});
