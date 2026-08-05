import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCredentials, credentialsPath, isExpired, readCredentials, writeCredentials, type HandsCredentials } from "../src/credentials.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-creds-"));
  env = { HANDS_TEST_HOME: home };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function sample(overrides: Partial<HandsCredentials> = {}): HandsCredentials {
  return {
    accessToken: "at_abc",
    refreshToken: "rt_abc",
    expiresAt: 1_700_000_000_000,
    githubLogin: "octocat",
    tier: "free",
    cloudBooksUrl: "https://github.com/hands-dev/books",
    dashboardUrl: "/octocat/dashboard",
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("credentialsPath", () => {
  it("resolves under <home>/.hands/credentials.json, not ~/.claude", () => {
    expect(credentialsPath(env)).toBe(path.join(home, ".hands", "credentials.json"));
  });
});

describe("readCredentials", () => {
  it("returns null when no credentials file exists — 'not logged in' is the default, not an error", () => {
    expect(readCredentials(env)).toBeNull();
  });

  it("round-trips what writeCredentials wrote", () => {
    const creds = sample();
    writeCredentials(creds, env);
    expect(readCredentials(env)).toEqual(creds);
  });

  it("returns null for a corrupt file rather than throwing", () => {
    fs.mkdirSync(path.join(home, ".hands"), { recursive: true });
    fs.writeFileSync(path.join(home, ".hands", "credentials.json"), "{ not json");
    expect(readCredentials(env)).toBeNull();
  });

  it("returns null for a well-formed JSON file missing required fields", () => {
    fs.mkdirSync(path.join(home, ".hands"), { recursive: true });
    fs.writeFileSync(path.join(home, ".hands", "credentials.json"), JSON.stringify({ githubLogin: "octocat" }));
    expect(readCredentials(env)).toBeNull();
  });
});

describe("writeCredentials", () => {
  it("creates the .hands dir and the file with restrictive permissions", () => {
    writeCredentials(sample(), env);
    const file = credentialsPath(env);
    expect(fs.existsSync(file)).toBe(true);
    // mode check: owner read/write only (0600) — mask off the file-type bits
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it("overwrites a previous login (re-running `hands login` replaces, not merges)", () => {
    writeCredentials(sample({ githubLogin: "first" }), env);
    writeCredentials(sample({ githubLogin: "second" }), env);
    expect(readCredentials(env)?.githubLogin).toBe("second");
  });
});

describe("clearCredentials", () => {
  it("removes an existing credentials file and returns true", () => {
    writeCredentials(sample(), env);
    expect(clearCredentials(env)).toBe(true);
    expect(readCredentials(env)).toBeNull();
  });

  it("returns false (not an error) when there was nothing to log out of", () => {
    expect(clearCredentials(env)).toBe(false);
  });
});

describe("isExpired", () => {
  it("is false strictly before expiresAt, true at or after it", () => {
    const creds = sample({ expiresAt: 1000 });
    expect(isExpired(creds, 999)).toBe(false);
    expect(isExpired(creds, 1000)).toBe(true);
    expect(isExpired(creds, 1001)).toBe(true);
  });
});
