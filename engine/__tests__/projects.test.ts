import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listRegisteredProjects,
  pruneMissing,
  readRegistry,
  registerProject,
  registryPath,
  resolveProject,
  writeRegistry,
} from "../src/projects.js";
import { resetRepoInfoCache } from "../src/paths.js";

let home: string;
let env: NodeJS.ProcessEnv;
let scratch: string;

/** A real git repo — repoInfo() shells out to git, so a bare mkdir won't do. */
function makeRepo(name: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return fs.realpathSync(dir);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-projects-"));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hands-repos-"));
  env = { HANDS_TEST_HOME: home };
  resetRepoInfoCache();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
  resetRepoInfoCache();
});

describe("registry file", () => {
  it("lives under HANDS_TEST_HOME so tests never touch the real ~/.hands", () => {
    expect(registryPath(env)).toBe(path.join(home, ".hands", "projects.json"));
  });

  it("reads as empty when absent", () => {
    expect(readRegistry(env)).toEqual({ projects: [] });
  });

  it("degrades to empty on corrupt JSON rather than throwing", () => {
    const file = registryPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json at all");
    expect(readRegistry(env)).toEqual({ projects: [] });
  });

  it("drops malformed entries but keeps well-formed siblings", () => {
    const file = registryPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        projects: [
          { name: "good", repoRoot: "/tmp/x", slug: "x-1", registeredAt: 1 },
          { name: "bad" },
          "not even an object",
        ],
      }),
    );
    expect(readRegistry(env).projects.map((p) => p.name)).toEqual(["good"]);
  });

  it("round-trips a write", () => {
    const entry = { name: "a", repoRoot: "/tmp/a", slug: "a-1", registeredAt: 5 };
    writeRegistry({ projects: [entry] }, env);
    expect(readRegistry(env).projects).toEqual([entry]);
  });
});

describe("registerProject", () => {
  it("registers a repo under its basename and resolves it back", () => {
    const repo = makeRepo("ampersand");
    const entry = registerProject(repo, { env, now: 1000 });
    expect(entry?.name).toBe("ampersand");
    expect(entry?.repoRoot).toBe(repo);
    expect(resolveProject("ampersand", env)?.repoRoot).toBe(repo);
  });

  it("accepts an explicit name", () => {
    const repo = makeRepo("some-long-repo-name");
    registerProject(repo, { env, name: "amp" });
    expect(resolveProject("amp", env)?.repoRoot).toBe(repo);
    expect(resolveProject("some-long-repo-name", env)).toBeNull();
  });

  it("is idempotent by name — re-registering re-points instead of duplicating", () => {
    const first = makeRepo("kitchen");
    const second = makeRepo("moved/kitchen");
    registerProject(first, { env, name: "kitchen" });
    registerProject(second, { env, name: "kitchen" });
    const all = listRegisteredProjects(env);
    expect(all).toHaveLength(1);
    expect(all[0]?.repoRoot).toBe(second);
  });

  it("returns null outside a git repo", () => {
    const notARepo = path.join(scratch, "plain-dir");
    fs.mkdirSync(notARepo, { recursive: true });
    expect(registerProject(notARepo, { env })).toBeNull();
  });
});

describe("resolution", () => {
  it("returns null for an unknown name", () => {
    expect(resolveProject("nope", env)).toBeNull();
  });

  it("prunes an entry whose repoRoot is gone rather than handing back a dead path", () => {
    const repo = makeRepo("doomed");
    registerProject(repo, { env });
    expect(resolveProject("doomed", env)).not.toBeNull();

    fs.rmSync(repo, { recursive: true, force: true });

    expect(resolveProject("doomed", env)).toBeNull();
    // and the dead row is gone from disk, not just filtered on read
    expect(readRegistry(env).projects).toHaveLength(0);
  });

  it("pruneMissing reports how many it dropped and leaves live entries alone", () => {
    const live = makeRepo("live");
    const dead = makeRepo("dead");
    registerProject(live, { env });
    registerProject(dead, { env });
    fs.rmSync(dead, { recursive: true, force: true });

    expect(pruneMissing(env)).toBe(1);
    expect(listRegisteredProjects(env).map((p) => p.name)).toEqual(["live"]);
  });
});
