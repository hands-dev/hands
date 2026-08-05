import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, resetConfigCache } from "../src/config.js";
import { coordinationDir, dbPath, notifyPath, repoInfo, resetRepoInfoCache } from "../src/paths.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
  return dir;
}

let root: string;
let repoA: string;
let repoB: string;
let worktreeA: string;
let nonGit: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hands-paths-"));
  repoA = makeRepo(root, "alpha");
  repoB = makeRepo(root, "beta");
  worktreeA = path.join(root, "alpha-feature");
  git(repoA, ["worktree", "add", "-q", worktreeA, "-b", "feature"]);
  nonGit = path.join(root, "plain");
  fs.mkdirSync(nonGit);
  resetRepoInfoCache();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetRepoInfoCache();
});

describe("coordinationDir (per-repo slug)", () => {
  it("HANDS_HOME overrides verbatim", () => {
    expect(coordinationDir({ HANDS_HOME: "/tmp/xyz" }, repoA)).toBe("/tmp/xyz");
  });

  it("two repos resolve to two different slug dirs", () => {
    const a = coordinationDir({}, repoA);
    const b = coordinationDir({}, repoB);
    expect(a).not.toBe(b);
    expect(a).toContain(path.join(os.homedir(), ".claude", "coordination"));
    expect(path.basename(a)).toMatch(/^alpha-[0-9a-f]{8}$/);
    expect(path.basename(b)).toMatch(/^beta-[0-9a-f]{8}$/);
  });

  it("a linked worktree resolves to the SAME slug dir as its main checkout", () => {
    expect(coordinationDir({}, worktreeA)).toBe(coordinationDir({}, repoA));
  });

  it("a subdirectory of a repo resolves to the repo's slug dir", () => {
    const sub = path.join(repoA, "some", "nested");
    fs.mkdirSync(sub, { recursive: true });
    expect(coordinationDir({}, sub)).toBe(coordinationDir({}, repoA));
  });

  it("a non-git cwd falls back to _global", () => {
    expect(path.basename(coordinationDir({}, nonGit))).toBe("_global");
  });

  it("db and notify paths live under the slug dir", () => {
    const dir = coordinationDir({}, repoA);
    expect(dbPath({}, repoA)).toBe(path.join(dir, "hands.db"));
    expect(notifyPath("station-1", {}, repoA)).toBe(path.join(dir, "station-1.notify"));
  });
});

describe("repoInfo", () => {
  it("marks the main worktree and computes a stable slug", () => {
    const a = repoInfo(repoA);
    expect(a?.isMainWorktree).toBe(true);
    expect(repoInfo(worktreeA)?.isMainWorktree).toBe(false);
    expect(repoInfo(worktreeA)?.slug).toBe(a?.slug);
  });

  it("returns null outside a git repo", () => {
    expect(repoInfo(nonGit)).toBeNull();
  });
});

describe("loadConfig", () => {
  afterEach(() => resetConfigCache());

  it("returns full defaults when no config files exist", () => {
    const cfg = loadConfig({ cwd: nonGit, env: { HANDS_TEST_HOME: nonGit } });
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.principal.name).toBe("Michael");
    expect(cfg.topology).toBe("strict-hub");
  });

  it("repo config overrides user config overrides defaults", () => {
    const home = path.join(root, "home1");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "hands.config.json"),
      JSON.stringify({ principal: { name: "Ada" }, stations: { model: "opus" } }),
    );
    fs.writeFileSync(
      path.join(repoA, "hands.config.json"),
      JSON.stringify({ topology: "open", stations: { overrides: { "station-2": "haiku" } } }),
    );
    try {
      const cfg = loadConfig({ cwd: repoA, env: { HANDS_TEST_HOME: home } });
      expect(cfg.principal.name).toBe("Ada"); // user layer
      expect(cfg.stations.model).toBe("opus"); // user layer
      expect(cfg.topology).toBe("open"); // repo layer
      expect(cfg.stations.overrides).toEqual({ "station-2": "haiku" }); // repo layer
      expect(cfg.stations.launcher).toBe("auto"); // default
    } finally {
      fs.rmSync(path.join(repoA, "hands.config.json"), { force: true });
    }
  });

  it("HANDS_NO_REPO_CONFIG suppresses the repo layer but not the user layer", () => {
    const home = path.join(root, "home2");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "hands.config.json"),
      JSON.stringify({ principal: { name: "Ada" } }),
    );
    fs.writeFileSync(
      path.join(repoA, "hands.config.json"),
      JSON.stringify({ topology: "open" }),
    );
    try {
      const cfg = loadConfig({
        cwd: repoA,
        env: { HANDS_TEST_HOME: home, HANDS_NO_REPO_CONFIG: "1" },
      });
      expect(cfg.principal.name).toBe("Ada"); // user layer still applies
      expect(cfg.topology).toBe("strict-hub"); // repo layer suppressed — default, not "open"
    } finally {
      fs.rmSync(path.join(repoA, "hands.config.json"), { force: true });
    }
  });

  it("ignores a malformed config file (falls back to defaults)", () => {
    fs.writeFileSync(path.join(repoA, "hands.config.json"), "{not json");
    try {
      const cfg = loadConfig({ cwd: repoA, env: { HANDS_TEST_HOME: nonGit } });
      expect(cfg.topology).toBe("strict-hub");
    } finally {
      fs.rmSync(path.join(repoA, "hands.config.json"), { force: true });
    }
  });
});
