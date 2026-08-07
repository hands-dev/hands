import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRepoInfoCache } from "../src/paths.js";
import {
  claimWorktree,
  isStale,
  type LockRecord,
  lockPath,
  processStartTime,
  readLock,
  releaseWorktree,
} from "../src/worktree-lock.js";

let root: string;
let repo: string;
let worktree: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hands-lock-"));
  fs.mkdirSync(path.join(root, "repo"), { recursive: true });
  repo = fs.realpathSync(path.join(root, "repo"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.mkdirSync(path.join(root, "station-1"), { recursive: true });
  worktree = fs.realpathSync(path.join(root, "station-1"));
  env = { HANDS_HOME: path.join(root, "coord") };
  resetRepoInfoCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetRepoInfoCache();
});

const claim = (over: Partial<Parameters<typeof claimWorktree>[0]> = {}) =>
  claimWorktree({ worktree, agentId: "station-1", env, cwd: repo, ...over });

describe("claiming a worktree", () => {
  it("takes a free worktree", () => {
    const res = claim({ pid: process.pid });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.previous).toBe("none");
    expect(fs.existsSync(lockPath(worktree, env, repo))).toBe(true);
  });

  it("records who holds it, and where", () => {
    claim({ pid: process.pid });
    const rec = readLock(worktree, env, repo);
    expect(rec?.pid).toBe(process.pid);
    expect(rec?.agentId).toBe("station-1");
    expect(rec?.worktree).toBe(worktree);
    expect(rec?.hostname).toBe(os.hostname());
  });

  it("is idempotent for the same process", () => {
    claim({ pid: process.pid });
    const again = claim({ pid: process.pid });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.previous).toBe("self");
  });

  it("REFUSES when a live foreign process holds it — the hands#153 guard", async () => {
    // a real, live process that is not us
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
    try {
      claim({ pid: child.pid });
      const res = claim({ pid: process.pid });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.heldBy.pid).toBe(child.pid);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("takes over a lock held by a dead pid", () => {
    // pid 2^22-ish is beyond any live pid on a normal box
    const dead: LockRecord = {
      pid: 4_194_300,
      startedAtBoot: null,
      claimedAt: Date.now() - 60_000,
      agentId: "station-1",
      worktree,
      hostname: "old-host",
    };
    const file = lockPath(worktree, env, repo);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(dead));

    const res = claim({ pid: process.pid });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.previous).toBe("stale");
  });

  it("treats pid reuse as stale rather than wedging the worktree", () => {
    // same (live) pid, but a start time that cannot match — the classic
    // reuse case. Wedging here would need a human to delete the file.
    const reused: LockRecord = {
      pid: process.pid,
      startedAtBoot: 1, // impossibly early
      claimedAt: Date.now() - 60_000,
      agentId: "station-1",
      worktree,
      hostname: os.hostname(),
    };
    if (processStartTime(process.pid) === null) return; // non-Linux: N/A
    expect(isStale(reused)).toBe(true);
  });

  it("evicts a live holder only when asked", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
    try {
      claim({ pid: child.pid });
      const res = claim({ pid: process.pid, evict: true });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.previous).toBe("evicted");
      expect(readLock(worktree, env, repo)?.pid).toBe(process.pid);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("keying", () => {
  it("keys by worktree PATH, not station id — the mismatch case must not slip through", () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(root, "station-2-")));
    expect(lockPath(worktree, env, repo)).not.toBe(lockPath(other, env, repo));
  });

  it("is stable for the same path", () => {
    expect(lockPath(worktree, env, repo)).toBe(lockPath(worktree, env, repo));
  });
});

describe("releasing", () => {
  it("releases a lock we hold", () => {
    claim({ pid: process.pid });
    expect(releaseWorktree(worktree, process.pid, env, repo)).toBe(true);
    expect(readLock(worktree, env, repo)).toBeNull();
  });

  it("never yanks someone else's claim", () => {
    claim({ pid: 4_194_300 });
    expect(releaseWorktree(worktree, process.pid, env, repo)).toBe(false);
    expect(readLock(worktree, env, repo)?.pid).toBe(4_194_300);
  });
});
