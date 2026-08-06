import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HandsConfig, DEFAULT_CONFIG } from "../src/config.js";
import { resetRepoInfoCache } from "../src/paths.js";
import {
  addStations,
  launchCommand,
  listStations,
  ProvisionError,
  removeStation,
  scaleStations,
  stationRoot,
} from "../src/provision.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let root: string;
let repo: string;
let cfg: HandsConfig;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hands-prov-"));
  repo = path.join(root, "proj");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  // Ignore the developer's global gitignore. This machine's ~/.config/git/ignore
  // hides .claude/settings.local.json, so the seeded file never registers as
  // dirty here — which is exactly why the station-rm regression passed locally
  // and broke CI. Pin it off so these tests see what CI sees.
  git(repo, ["config", "core.excludesFile", "/dev/null"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  resetRepoInfoCache();
  // manual launcher: provision only, never spawn sessions; keep worktrees in the sandbox
  cfg = {
    ...DEFAULT_CONFIG,
    stations: {
      ...DEFAULT_CONFIG.stations,
      launcher: "manual",
      worktreeRoot: path.join(root, "managed"),
      overrides: { "station-2": "opus" }, // legacy key form — still honored per index
    },
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetRepoInfoCache();
});

describe("station provisioning (manual launcher)", () => {
  it("adds N stations as hidden worktrees on hands/station-<n> branches", () => {
    const plans = addStations(2, { cwd: repo, config: cfg });
    expect(plans.map((p) => p.id)).toEqual(["station-1", "station-2"]);
    expect(plans.every((p) => p.launched === false && p.launcher === "manual")).toBe(true);
    // model tier: default + per-station override
    expect(plans[0]!.model).toBe("sonnet");
    expect(plans[1]!.model).toBe("opus");
    // the worktrees exist under the managed root, on ephemeral branches
    for (const p of plans) {
      expect(fs.existsSync(path.join(p.dir, "README.md"))).toBe(true);
      expect(git(p.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(p.branch);
    }
    // the paste command carries identity + loop
    expect(plans[0]!.command).toContain("HANDS_ID=station-1");
    expect(plans[0]!.command).toContain("claude --model sonnet '/loop /hands:station'");
  });

  it("ls reflects the pool; add fills the lowest free index", () => {
    addStations(2, { cwd: repo, config: cfg });
    removeStation("station-1", { cwd: repo, config: cfg });
    expect(listStations(repo, cfg).map((w) => w.id)).toEqual(["station-2"]);
    const plans = addStations(1, { cwd: repo, config: cfg });
    expect(plans[0]!.id).toBe("station-1");
    expect(listStations(repo, cfg).map((w) => w.id)).toEqual(["station-1", "station-2"]);
  });

  it("rm removes worktree + branch and is idempotent", () => {
    addStations(1, { cwd: repo, config: cfg });
    const dir = path.join(stationRoot(repo, cfg), "station-1");
    expect(fs.existsSync(dir)).toBe(true);
    expect(removeStation("station-1", { cwd: repo, config: cfg }).removed).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(git(repo, ["branch", "--list", "hands/station-1"])).toBe("");
    // idempotent
    expect(removeStation("station-1", { cwd: repo, config: cfg }).removed).toBe(false);
  });

  it("rm refuses to discard uncommitted work without force", () => {
    addStations(1, { cwd: repo, config: cfg });
    const dir = path.join(stationRoot(repo, cfg), "station-1");
    fs.writeFileSync(path.join(dir, "wip.txt"), "uncommitted\n");
    expect(() => removeStation("station-1", { cwd: repo, config: cfg })).toThrow(ProvisionError);
    expect(removeStation("station-1", { cwd: repo, config: cfg, force: true }).removed).toBe(true);
  });

  it("scale reconciles up and down (highest index retired first)", () => {
    const up = scaleStations(3, { cwd: repo, config: cfg });
    expect(up.added.map((p) => p.id)).toEqual(["station-1", "station-2", "station-3"]);
    const down = scaleStations(1, { cwd: repo, config: cfg });
    expect(down.removed).toEqual(["station-2", "station-3"]);
    expect(listStations(repo, cfg).map((w) => w.id)).toEqual(["station-1"]);
    const same = scaleStations(1, { cwd: repo, config: cfg });
    expect(same.added).toEqual([]);
    expect(same.removed).toEqual([]);
  });

  it("rejects garbage ids and non-repo cwds", () => {
    expect(() => removeStation("wt4", { cwd: repo, config: cfg })).toThrow(ProvisionError);
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    expect(() => addStations(1, { cwd: plain, config: cfg })).toThrow(ProvisionError);
  });

  // Regression: seeding writes .claude/settings.local.json into every station
  // worktree, which makes it untracked-dirty, and `git worktree remove` refuses
  // a dirty worktree — so `station rm` and `scale` down broke for every seeded
  // station. It passed locally only because the developer's global gitignore
  // (~/.config/git/ignore) hid the file; CI has no such ignore. Hence the
  // core.excludesFile pin in beforeEach — without it these tests are vacuous
  // on any machine that ignores .claude/.
  it("clears its own seeded scaffolding so a station can be retired", () => {
    addStations(1, { cwd: repo, config: cfg });
    const dir = path.join(stationRoot(repo, cfg), "station-1");
    expect(fs.existsSync(path.join(dir, ".claude", "settings.local.json"))).toBe(true);

    expect(removeStation("station-1", { cwd: repo, config: cfg }).removed).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("scale down still works with every station seeded", () => {
    scaleStations(3, { cwd: repo, config: cfg });
    for (const s of listStations(repo, cfg)) {
      expect(fs.existsSync(path.join(s.dir, ".claude", "settings.local.json"))).toBe(true);
    }
    const down = scaleStations(1, { cwd: repo, config: cfg });
    expect(down.removed).toEqual(["station-2", "station-3"]);
    expect(listStations(repo, cfg).map((w) => w.id)).toEqual(["station-1"]);
  });

  it("does NOT clear scaffolding when there is real work — that must still block", () => {
    addStations(1, { cwd: repo, config: cfg });
    const dir = path.join(stationRoot(repo, cfg), "station-1");
    fs.writeFileSync(path.join(dir, "wip.txt"), "uncommitted\n");

    expect(() => removeStation("station-1", { cwd: repo, config: cfg })).toThrow(ProvisionError);
    // the guardrail is the point: our file stays put too, because we never got
    // to the "only our dirt" branch
    expect(fs.existsSync(path.join(dir, ".claude", "settings.local.json"))).toBe(true);
    expect(removeStation("station-1", { cwd: repo, config: cfg, force: true }).removed).toBe(true);
  });

  it("launchCommand quotes odd paths", () => {
    const cmd = launchCommand({ id: "station-1", dir: "/tmp/has space/w", model: "sonnet" });
    expect(cmd).toContain("'/tmp/has space/w'");
  });

  it("launchCommand defaults to station mode so existing callers are unaffected", () => {
    const cmd = launchCommand({ id: "station-1", dir: "/tmp/w", model: "sonnet" });
    expect(cmd).toContain("/loop /hands:station");
    expect(cmd).not.toContain("/hands:expo");
  });

  it("launchCommand emits the expo loop in expo mode", () => {
    const cmd = launchCommand({ id: "expo", dir: "/tmp/w" }, "expo");
    expect(cmd).toContain("/loop /hands:expo");
    expect(cmd).not.toContain("/hands:station");
  });

  it("omits --model when none is given, so the expo inherits the principal's default", () => {
    expect(launchCommand({ id: "expo", dir: "/tmp/w" }, "expo")).not.toContain("--model");
    expect(launchCommand({ id: "station-1", dir: "/tmp/w", model: "sonnet" })).toContain(
      "--model sonnet",
    );
  });

  it("seeds a permission allowlist into every station worktree it creates", () => {
    const [plan] = addStations(1, { cwd: repo, config: cfg });
    if (!plan) throw new Error("addStations returned no plan");
    const settings = path.join(plan.dir, ".claude", "settings.local.json");
    expect(fs.existsSync(settings)).toBe(true);
    // The regression this guards: a station spawned without this file stalls on
    // a permission prompt before it can read anything. Cost ~14h on 2026-08-05.
    const parsed = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(parsed.permissions.allow).toContain("mcp__plugin_hands_hands__hands_receive");
  });
});
