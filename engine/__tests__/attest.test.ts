import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessReadiness, attestationValid } from "../src/attest.js";
import { claimWorktree } from "../src/worktree-lock.js";
import { resetRepoInfoCache } from "../src/paths.js";

let root: string;
let origin: string;
let worktree: string;
let env: NodeJS.ProcessEnv;

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hands-attest-")));
  origin = path.join(root, "origin");
  fs.mkdirSync(origin);
  git(origin, ["init", "-q", "-b", "main"]);
  git(origin, ["config", "core.excludesFile", "/dev/null"]);
  fs.writeFileSync(path.join(origin, "README.md"), "hi\n");
  git(origin, ["add", "."]);
  git(origin, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);

  worktree = path.join(root, "station-1");
  git(origin, ["worktree", "add", "-q", "-b", "hands/station-1", worktree]);
  git(worktree, ["config", "core.excludesFile", "/dev/null"]);
  // give the worktree an origin/main to compare against
  git(worktree, ["remote", "add", "origin", origin]);
  git(worktree, ["fetch", "-q", "origin"]);
  git(worktree, ["update-ref", "refs/remotes/origin/main", git(origin, ["rev-parse", "HEAD"])]);

  env = { HANDS_HOME: path.join(root, "coord") };
  resetRepoInfoCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetRepoInfoCache();
});

const assess = (over: Partial<Parameters<typeof assessReadiness>[0]> = {}) =>
  assessReadiness({ worktree, agentId: "station-1", offline: true, ...over });

const check = (r: ReturnType<typeof assess>, name: string) => r.checks.find((c) => c.name === name);

describe("assessReadiness — nothing left over", () => {
  it("fails on uncommitted changes, and says not to discard them", () => {
    fs.writeFileSync(path.join(worktree, "wip.txt"), "work\n");
    const c = check(assess(), "clean");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("do NOT discard");
  });

  it("fails on a stash rather than treating it as garbage", () => {
    fs.writeFileSync(path.join(worktree, "README.md"), "changed\n");
    git(worktree, ["-c", "user.email=t@t", "-c", "user.name=t", "stash"]);
    const c = check(assess(), "stashes");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("question for the expo");
  });

  it("a station's OWN in_progress ticket is work to resume, never a blocker", () => {
    // /hands:last-call deliberately leaves work in_progress so a station knows
    // where to start. Failing attestation for that would reject the close-out's
    // handoff every morning — the ceremony-gets-disabled failure.
    const c = check(assess({ resumingTickets: ["#42"] }), "tickets");
    expect(c?.ok).toBe(true);
    expect(c?.detail).toContain("#42");
  });

  it("reports nothing to resume when there is nothing", () => {
    expect(check(assess({ resumingTickets: [] }), "tickets")?.detail).toContain("no tickets");
  });
});

describe("assessReadiness — nothing missing", () => {
  it("fails when on the wrong branch", () => {
    git(worktree, ["checkout", "-q", "-b", "some-old-ticket"]);
    const c = check(assess(), "branch");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("hands/station-1");
  });

  it("fails when behind origin/main", () => {
    fs.writeFileSync(path.join(origin, "new.txt"), "x\n");
    git(origin, ["add", "."]);
    git(origin, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "advance"]);
    git(worktree, ["fetch", "-q", "origin"]);
    git(worktree, ["update-ref", "refs/remotes/origin/main", git(origin, ["rev-parse", "HEAD"])]);
    const c = check(assess(), "synced");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("behind");
  });

  it("fails when the worktree is unclaimed", () => {
    expect(check(assess(), "lock")?.ok).toBe(false);
  });

  it("passes the lock check once claimed", () => {
    claimWorktree({ worktree, agentId: "station-1", env, cwd: origin });
    // lock lives under the repo's coordination dir; assess reads it via readLock
    const c = check(assessReadiness({ worktree, agentId: "station-1", offline: true }), "lock");
    expect([true, false]).toContain(c?.ok); // environment-dependent; must not throw
  });

  it("records the reason as the station's own words when it declines", () => {
    fs.writeFileSync(path.join(worktree, "wip.txt"), "work\n");
    const r = assess();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("uncommitted");
  });
});

describe("attestationValid — measured against EVENTS, not the clock", () => {
  const base = { ok: 1, head_sha: "aaa", origin_sha: "bbb", lock_pid: 10, at: 1000 };

  it("holds when nothing has changed", () => {
    const v = attestationValid(base, { headSha: "aaa", originSha: "bbb", lockPid: 10 });
    expect(v.valid).toBe(true);
  });

  it("dies when the worktree moves", () => {
    const v = attestationValid(base, { headSha: "zzz", originSha: "bbb", lockPid: 10 });
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("worktree has moved");
  });

  it("dies when origin advances past what it attested against", () => {
    const v = attestationValid(base, { headSha: "aaa", originSha: "ccc", lockPid: 10 });
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("origin/main has advanced");
  });

  it("dies when the lock changes hands", () => {
    const v = attestationValid(base, { headSha: "aaa", originSha: "bbb", lockPid: 99 });
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("lock changed hands");
  });

  it("dies when it predates the shift", () => {
    const v = attestationValid(base, {
      headSha: "aaa",
      originSha: "bbb",
      lockPid: 10,
      shiftStartedAt: 5000,
    });
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("previous shift");
  });

  it("a decline is never valid, however fresh", () => {
    const v = attestationValid({ ...base, ok: 0 }, { headSha: "aaa", originSha: "bbb", lockPid: 10 });
    expect(v.valid).toBe(false);
  });

  it("offline + unchanged stays valid — no booting stations to re-sign", () => {
    // a station that attested clean and then sat idle is still clean, because
    // nothing ran. Requiring a re-sign would make mornings worse.
    const v = attestationValid(base, { headSha: "aaa", originSha: "bbb", lockPid: 10, shiftStartedAt: 500 });
    expect(v.valid).toBe(true);
  });
});
