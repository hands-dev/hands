import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isoDay, mirrorHealth, readJournal, readPreviousPage } from "../src/journal-read.js";
import { resetProjectCache } from "../src/remote.js";
import { resetRepoInfoCache } from "../src/paths.js";

let root: string;
let repo: string;
let env: NodeJS.ProcessEnv;

const CONFIG = {
  principal: { name: "Michael" },
  topology: "strict-hub",
  stations: { model: "sonnet", overrides: {}, allowScaling: true },
  merge: { adminMergeLowRisk: false },
  gh: { poll: false },
  remote: { url: "", handle: "demo", project: "demo" },
};

function page(booksDir: string, date: string, body: string) {
  const dir = path.join(booksDir, "journal", "demo", "demo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}.md`), body);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hands-jr-")));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"],
    { cwd: repo },
  );
  fs.writeFileSync(path.join(repo, "hands.config.json"), JSON.stringify(CONFIG, null, 2));
  env = { HANDS_HOME: path.join(root, "coord") };
  resetRepoInfoCache();
  resetProjectCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetRepoInfoCache();
  resetProjectCache();
});

/** openJournal bootstraps a local origin; find where it landed. */
function booksDir(): string {
  return path.join(root, "coord", "remote");
}

describe("readJournal", () => {
  it("reads the most recent page when given no date", () => {
    page(booksDir(), "2026-08-05", "# older\n");
    page(booksDir(), "2026-08-06", "# newer\n");
    const res = readJournal({ cwd: repo, env });
    expect(res.ok).toBe(true);
    expect(res.pages[0]?.date).toBe("2026-08-06");
  });

  it("reads a specific date", () => {
    page(booksDir(), "2026-08-05", "# the one I want\n");
    page(booksDir(), "2026-08-06", "# not this\n");
    const res = readJournal({ date: "2026-08-05", cwd: repo, env });
    expect(res.pages[0]?.text).toContain("the one I want");
  });

  it("rejects a malformed date rather than guessing", () => {
    const res = readJournal({ date: "yesterday", cwd: repo, env });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("YYYY-MM-DD");
  });

  it("lists available dates so a caller can ask again precisely", () => {
    page(booksDir(), "2026-08-05", "# a\n");
    page(booksDir(), "2026-08-06", "# b\n");
    const res = readJournal({ date: "2026-01-01", cwd: repo, env });
    expect(res.ok).toBe(false);
    expect(res.available).toEqual(["2026-08-06", "2026-08-05"]);
  });

  it("truncates a large page from the HEAD, keeping the Notes narrative", () => {
    page(booksDir(), "2026-08-06", `## Notes\n- the important line\n${"x".repeat(50_000)}`);
    const res = readJournal({ cwd: repo, env, maxBytes: 500 });
    expect(res.pages[0]?.text).toContain("the important line");
    expect(res.pages[0]?.text).toContain("truncated");
  });

  it("ignores README.md and non-date files", () => {
    const dir = path.join(booksDir(), "journal", "demo", "demo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "# index\n");
    page(booksDir(), "2026-08-06", "# real page\n");
    expect(readJournal({ cwd: repo, env }).pages[0]?.date).toBe("2026-08-06");
  });
});

describe("readPreviousPage — the shift-start read", () => {
  it("returns the last page STRICTLY BEFORE today", () => {
    page(booksDir(), "2026-08-06", "# yesterday\n");
    page(booksDir(), "2026-08-07", "# today, mostly empty\n");
    const res = readPreviousPage({ today: "2026-08-07", cwd: repo, env });
    expect(res.pages[0]?.date).toBe("2026-08-06");
  });

  it("crosses a weekend — Monday reads Friday, no date arithmetic", () => {
    page(booksDir(), "2026-08-07", "# friday close\n");
    const res = readPreviousPage({ today: "2026-08-10", cwd: repo, env });
    expect(res.pages[0]?.date).toBe("2026-08-07");
  });

  it("says first-shift when there genuinely is no earlier page", () => {
    page(booksDir(), "2026-08-07", "# today\n");
    const res = readPreviousPage({ today: "2026-08-07", cwd: repo, env });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("first shift");
  });
});

describe("mirrorHealth", () => {
  it("does NOT cry wolf about a locally-bootstrapped books origin", () => {
    // hands#129: books fall back to a local git origin with no upstream. That
    // is normal, and warning about it on every local kitchen is how a real
    // warning gets ignored.
    const health = mirrorHealth(booksDir(), "/some/local/path.git");
    expect(health.problem).toBeNull();
  });

  it("reports a remote mirror with no upstream as unable to pull", () => {
    const dir = path.join(root, "mirror");
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const health = mirrorHealth(dir, "https://github.com/x/y.git");
    expect(health.problem).toContain("upstream");
  });
});

describe("isoDay", () => {
  it("formats local days, zero-padded", () => {
    expect(isoDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
