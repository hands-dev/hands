import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, resetConfigCache } from "../src/config.js";
import { writeCredentials, type HandsCredentials } from "../src/credentials.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-config-login-"));
  // fully isolated from any real user/repo config, same pattern as paths.test.ts —
  // HANDS_NO_REPO_CONFIG matters here specifically because this test suite runs
  // from inside a real hands checkout, which has its own real hands.config.json.
  env = { HANDS_TEST_HOME: home, HANDS_NO_REPO_CONFIG: "1" };
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  fs.rmSync(home, { recursive: true, force: true });
});

function sampleCreds(overrides: Partial<HandsCredentials> = {}): HandsCredentials {
  return {
    accessToken: "at",
    expiresAt: 0,
    githubLogin: "octocat",
    tier: "free",
    cloudBooksUrl: "https://github.com/hands-dev/books",
    dashboardUrl: "/octocat/dashboard",
    updatedAt: 0,
    ...overrides,
  };
}

describe("loadConfig — the login-derived layer (hands login)", () => {
  it("is behavior-neutral when never logged in — identical to DEFAULT_CONFIG", () => {
    // no credentials.json written at all — the common case
    expect(loadConfig({ cwd: home, env })).toEqual(DEFAULT_CONFIG);
  });

  it("is behavior-neutral when logged in but the login has no cloud books mapping", () => {
    writeCredentials(sampleCreds({ cloudBooksUrl: null }), env);
    resetConfigCache();
    expect(loadConfig({ cwd: home, env })).toEqual(DEFAULT_CONFIG);
  });

  it("fills remote.url/handle from the login when the repo/user config leave it unset", () => {
    writeCredentials(sampleCreds(), env);
    resetConfigCache();
    const cfg = loadConfig({ cwd: home, env });
    expect(cfg.remote).toEqual({ url: "https://github.com/hands-dev/books.git", handle: "octocat", project: null });
    // nothing else about the config should differ from defaults
    expect({ ...cfg, remote: DEFAULT_CONFIG.remote }).toEqual(DEFAULT_CONFIG);
  });

  it("does not double-append .git when cloudBooksUrl already has it", () => {
    writeCredentials(sampleCreds({ cloudBooksUrl: "https://github.com/hands-dev/books.git" }), env);
    resetConfigCache();
    expect(loadConfig({ cwd: home, env }).remote.url).toBe("https://github.com/hands-dev/books.git");
  });

  it("a hand-set user config value always wins over the login-derived one", () => {
    writeCredentials(sampleCreds(), env);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "hands.config.json"),
      JSON.stringify({ remote: { url: "git@github.com:someone/else.git", handle: "someone", project: null } }),
    );
    resetConfigCache();
    expect(loadConfig({ cwd: home, env }).remote).toEqual({
      url: "git@github.com:someone/else.git",
      handle: "someone",
      project: null,
    });
  });
});

describe("loadConfig — stations.theming (hands#104)", () => {
  it("defaults to true — theming is opt-out, not opt-in", () => {
    expect(loadConfig({ cwd: home, env }).stations.theming).toBe(true);
  });

  it("a user config can opt out entirely", () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "hands.config.json"),
      JSON.stringify({ stations: { theming: false } }),
    );
    resetConfigCache();
    const cfg = loadConfig({ cwd: home, env });
    expect(cfg.stations.theming).toBe(false);
    // nothing else about stations should differ from defaults
    expect({ ...cfg.stations, theming: true }).toEqual(DEFAULT_CONFIG.stations);
  });
});
