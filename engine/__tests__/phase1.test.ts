import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBoard } from "../src/board.js";
import { runPublish } from "../src/publish.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;
const tmps: string[] = [];

function tmpdir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}

beforeEach(() => {
  home = tmpdir("yes-chef-p1-home-");
  env = { YES_CHEF_HOME: home };
});

afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function gitRepo(): string {
  const repo = tmpdir("yes-chef-p1-repo-");
  const g = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  g(["init", "-q", "-b", "work"]);
  g(["config", "user.email", "t@t.co"]);
  g(["config", "user.name", "t"]);
  return repo;
}
function commit(repo: string, file: string, msg: string): void {
  fs.writeFileSync(path.join(repo, file), `x-${Date.now()}-${Math.random()}`);
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", msg], { cwd: repo, stdio: "ignore" });
}

describe("store status + journal + watermarks", () => {
  it("setStatus upserts branch/activity/last_active", () => {
    const store = new Store({ env });
    const now = 1_700_000_000_000;
    store.setStatus({ id: "wt1", cwd: "/a", pid: 5, branch: "feature/eng-1", files: ["src/x.ts"], now });
    const p = store.listPeers(now).find((x) => x.id === "wt1")!;
    expect(p.branch).toBe("feature/eng-1");
    expect(p.last_active).toBe(now);
    expect(JSON.parse(p.activity!).files).toEqual(["src/x.ts"]);
    store.close();
  });

  it("journal dedups commits by ref and reads back since a timestamp", () => {
    const store = new Store({ env });
    store.journalAdd({ agentId: "wt1", kind: "commit", ref: "sha1", text: "one", now: 100 });
    expect(store.journalHasRef("commit", "sha1")).toBe(true);
    expect(store.journalHasRef("commit", "nope")).toBe(false);
    store.journalAdd({ agentId: "wt1", kind: "memory", ref: "m", text: "learned", now: 200 });
    expect(store.journalSince(150).map((j) => j.text)).toEqual(["learned"]);
    store.close();
  });

  it("watermarks round-trip per (agent,key)", () => {
    const store = new Store({ env });
    expect(store.getWatermark("wt1", "k")).toBeNull();
    store.setWatermark("wt1", "k", "v1");
    store.setWatermark("wt1", "k", "v2");
    expect(store.getWatermark("wt1", "k")).toBe("v2");
    expect(store.getWatermark("*", "k")).toBeNull();
    store.close();
  });
});

describe("runPublish commit harvest", () => {
  it("baselines on first run then journals only new commits", () => {
    const repo = gitRepo();
    commit(repo, "a.txt", "first");
    const store = new Store({ env });

    const r1 = runPublish(store, { agentId: "wtA", cwd: repo, env });
    expect(r1.branch).toBe("work");
    expect(r1.commitsJournaled).toBe(0); // baseline, no backfill
    expect(store.journalSince(0)).toHaveLength(0);

    commit(repo, "b.txt", "second");
    const r2 = runPublish(store, { agentId: "wtA", cwd: repo, env });
    expect(r2.commitsJournaled).toBe(1);
    const texts = store.journalSince(0).map((j) => j.text);
    expect(texts).toContain("second");

    // idempotent: re-running with no new commit journals nothing
    const r3 = runPublish(store, { agentId: "wtA", cwd: repo, env });
    expect(r3.commitsJournaled).toBe(0);
    store.close();
  });
});

describe("runPublish memory harvest", () => {
  it("baselines existing memories, then journals a changed one (deduped globally)", () => {
    const memDir = tmpdir("yes-chef-p1-mem-");
    fs.writeFileSync(path.join(memDir, "MEMORY.md"), "index - ignored");
    fs.writeFileSync(
      path.join(memDir, "thing.md"),
      "---\nname: thing\ndescription: a first learning\n---\nbody",
    );
    const menv = { ...env, YES_CHEF_MEMORY_DIR: memDir };
    const nonGit = tmpdir("yes-chef-p1-nongit-");
    const store = new Store({ env });

    const r1 = runPublish(store, { agentId: "wtA", cwd: nonGit, env: menv });
    expect(r1.memoriesJournaled).toBe(0); // baseline
    expect(store.journalSince(0)).toHaveLength(0);

    fs.writeFileSync(
      path.join(memDir, "thing.md"),
      "---\nname: thing\ndescription: an updated learning\n---\nnew body",
    );
    const r2 = runPublish(store, { agentId: "wtA", cwd: nonGit, env: menv });
    expect(r2.memoriesJournaled).toBe(1);
    expect(store.journalSince(0).map((j) => ({ kind: j.kind, text: j.text }))).toEqual([
      { kind: "memory", text: "an updated learning" },
    ]);

    // A second pane sees the same hash → no duplicate journal (global dedup).
    const r3 = runPublish(store, { agentId: "wtB", cwd: nonGit, env: menv });
    expect(r3.memoriesJournaled).toBe(0);
    store.close();
  });
});

describe("buildBoard", () => {
  it("stays quiet when nothing is new and no collision", () => {
    const store = new Store({ env });
    const now = 2_000_000_000_000;
    store.setStatus({ id: "wt1", cwd: "/a", pid: 1, branch: "b1", files: ["src/a.ts"], now });
    store.setStatus({ id: "wt2", cwd: "/b", pid: 2, branch: "b2", files: ["src/b.ts"], now });
    const res = buildBoard(store, { agentId: "wt1", since: now, advance: false, now });
    expect(res.text).toBe("");
    store.close();
  });

  it("surfaces peer journal deltas and file collisions", () => {
    const store = new Store({ env });
    const now = 2_000_000_000_000;
    store.setStatus({ id: "wt1", cwd: "/a", pid: 1, branch: "b1", files: ["src/store.ts"], now });
    store.setStatus({ id: "wt2", cwd: "/b", pid: 2, branch: "b2", files: ["src/store.ts"], now });
    store.journalAdd({ agentId: "wt2", kind: "commit", ref: "s", text: "fix thing", now: now - 60_000 });

    const res = buildBoard(store, { agentId: "wt1", since: now - 120_000, advance: false, now });
    expect(res.journalCount).toBe(1);
    expect(res.collisions).toBe(1);
    expect(res.text).toContain("wt2 committed");
    expect(res.text).toContain("also touching store.ts");
    store.close();
  });

  it("excludes the reader's own journal entries from the delta", () => {
    const store = new Store({ env });
    const now = 2_000_000_000_000;
    store.journalAdd({ agentId: "wt1", kind: "commit", ref: "self", text: "my own", now: now - 1000 });
    const res = buildBoard(store, { agentId: "wt1", since: now - 5000, advance: false, now });
    expect(res.text).toBe(""); // own commit isn't news to me
    store.close();
  });
});
