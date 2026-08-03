import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPriorities } from "../src/priorities.js";
import {
  ensureRepo,
  type JournalEvent,
  listProjects,
  MARKER_FILE,
  openJournal,
  projectFromOrigin,
  readEvents,
  readSyncStatus,
  replayInto,
  sanitizeSegment,
  syncPull,
  syncPush,
  validateJournal,
} from "../src/remote.js";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/config.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-remote-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A journal wired straight to this test's sandbox (no config file needed). */
function journalAt(handle: string, url: string, opts?: { home?: string; writerId?: string }) {
  const j = openJournal({
    env: { AGENT_BUS_HOME: path.join(root, opts?.home ?? "unused-coord") },
    cwd: root,
    config: { ...DEFAULT_CONFIG, remote: { url, handle, project: null } },
    writerId: opts?.writerId,
  });
  if (!j) throw new Error("journal did not open");
  return j;
}

/** Seed a bare remote with a file on main (simulates a repo that is NOT a journal). */
function seedRemote(remote: string, name: string, body: string): void {
  const work = fs.mkdtempSync(path.join(root, "seed-"));
  execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
  execFileSync("git", ["-C", work, "checkout", "-q", "-B", "main"], { stdio: "ignore" });
  fs.writeFileSync(path.join(work, name), body);
  execFileSync("git", ["-C", work, "add", "-A"], { stdio: "ignore" });
  execFileSync(
    "git",
    ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"],
    { stdio: "ignore" },
  );
  execFileSync("git", ["-C", work, "push", "-q", "origin", "main"], { stdio: "ignore" });
}

function bareRemote(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
  return dir;
}

/** Drive a full set of state changes through a journal-wired store. */
function populate(store: Store): void {
  store.insertMessage({ from: "worker-1", to: "foreman", body: "returned early", subject: "status", now: 1000 });
  store.insertMessage({ from: "foreman", to: null, body: "all hands", now: 2000 });
  store.setCursor("foreman", 1);
  const qid = store.askQuestion({ asker: "worker-1", question: "ship it?", context: "ctx", now: 3000 });
  store.escalateQuestion({ id: qid, recommendation: "ship", priorityRef: "P1", now: 3500 });
  store.answerQuestion({ id: qid, answer: "yes", resolvedBy: "human", now: 4000 });
  store.setQuestionOutcome({ id: qid, outcome: "validated", note: "held up", now: 4500 });
  const tid = store.createTask({ createdBy: "foreman", assignee: "worker-1", title: "plan X", body: "b", priority: "P1", now: 5000 });
  store.updateTaskState({ id: tid, state: "in_progress", now: 5500 });
  store.updateTaskState({ id: tid, state: "returned", result: "the plan", now: 6000 });
  const todo = store.createTodo({ title: "merge #7", dedupKey: "pr-7", originRef: "PR#7", now: 7000 });
  store.updateTodoState({ id: todo.id, state: "done", doneSignal: "PR #7 merged", now: 7500 });
  store.journalAdd({ agentId: "worker-1", kind: "commit", ref: "abc123", text: "fix thing", now: 8000 });
}

function snapshotState(store: Store) {
  return {
    messages: store.history({ limit: 50 }).map((m) => [m.id, m.from_id, m.to_id, m.body]),
    cursor: store.getCursor("foreman"),
    question: store.getQuestion(1),
    tasks: store.listTasks().map((t) => [t.id, t.state, t.assignee, t.result]),
    todos: store.listTodos().map((t) => [t.id, t.state, t.done_signal]),
  };
}

describe("journal append + replay round-trip", () => {
  it("rebuilds equivalent state in a fresh store, preserving ids", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    const homeA = fs.mkdtempSync(path.join(root, "busA-"));
    const a = new Store({ env: { AGENT_BUS_HOME: homeA } });
    a.setJournal(j.append);
    populate(a);

    const events = readEvents(j.dir, j.project, "michael");
    expect(events.length).toBeGreaterThanOrEqual(12);
    expect(events.every((e: JournalEvent) => e.v === 1 && typeof e.ts === "number")).toBe(true);

    const homeB = fs.mkdtempSync(path.join(root, "busB-"));
    const envB = { AGENT_BUS_HOME: homeB };
    const b = new Store({ env: envB });
    const res = replayInto(b, events, envB);
    expect(res.skipped).toBe(0);
    expect(snapshotState(b)).toEqual(snapshotState(a));
    a.close();
    b.close();
  });

  it("replay is idempotent (twice over the same DB changes nothing)", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    const a = new Store({ env: { AGENT_BUS_HOME: fs.mkdtempSync(path.join(root, "busA-")) } });
    a.setJournal(j.append);
    populate(a);
    const events = readEvents(j.dir, j.project, "michael");

    const homeB = fs.mkdtempSync(path.join(root, "busB-"));
    const envB = { AGENT_BUS_HOME: homeB };
    const b = new Store({ env: envB });
    replayInto(b, events, envB);
    const first = snapshotState(b);
    replayInto(b, events, envB);
    expect(snapshotState(b)).toEqual(first);
    a.close();
    b.close();
  });

  it("materializes priorities.set into priorities.md and skips unknown event types", () => {
    const homeB = fs.mkdtempSync(path.join(root, "busB-"));
    const envB = { AGENT_BUS_HOME: homeB };
    const b = new Store({ env: envB });
    const res = replayInto(
      b,
      [
        { v: 1, ts: 1, type: "priorities.set", data: { items: ["P1 ship", "P2 fix"], at: 1 } },
        { v: 1, ts: 2, type: "from.the.future", data: { x: 1 } },
      ],
      envB,
    );
    expect(res.applied).toBe(1);
    expect(res.skipped).toBe(1);
    expect(readPriorities(envB).items).toEqual(["P1 ship", "P2 fix"]);
    b.close();
  });

  it("skips torn/corrupt journal lines without losing the rest", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    j.append("message", { id: 1, from: "a", to: "b", body: "ok", at: 1 });
    const logDir = path.join(j.dir, "journal", j.project, "michael", "log");
    const file = path.join(logDir, fs.readdirSync(logDir)[0]!);
    fs.appendFileSync(file, '{"v":1,"ts":2,"type":"message","da\n');
    j.append("message", { id: 2, from: "a", to: "b", body: "also ok", at: 3 });
    expect(readEvents(j.dir, j.project, "michael").map((e) => e.data.id)).toEqual([1, 2]);
  });
});

describe("git sync + machine-move restore", () => {
  it("push → fresh clone on 'another machine' → replay restores the bus", () => {
    const remote = bareRemote("origin.git");

    // machine 1: journal + push
    const j1 = journalAt("michael", remote);
    const a = new Store({ env: { AGENT_BUS_HOME: fs.mkdtempSync(path.join(root, "busA-")) } });
    a.setJournal(j1.append);
    populate(a);
    const pushed = syncPush(j1, { force: true });
    expect(pushed.status).toBe("pushed");

    // machine 2: fresh journal dir wired to the same remote, pull, replay
    const dir2 = path.join(root, "machine2-journal");
    expect(ensureRepo(dir2, remote)).toBe(true);
    expect(syncPull(dir2).ok).toBe(true);
    const events = readEvents(dir2, j1.project, "michael");
    expect(events.length).toBeGreaterThanOrEqual(12);

    const homeB = fs.mkdtempSync(path.join(root, "busB-"));
    const envB = { AGENT_BUS_HOME: homeB };
    const b = new Store({ env: envB });
    replayInto(b, events, envB);
    expect(snapshotState(b)).toEqual(snapshotState(a));
    a.close();
    b.close();
  });

  it("debounces pushes, and two handles append without conflict", () => {
    const remote = bareRemote("origin.git");
    const j1 = journalAt("michael", remote);
    j1.append("message", { id: 1, from: "a", to: "b", body: "mine", at: 1 });
    expect(syncPush(j1, { force: true }).status).toBe("pushed");
    // immediate second push is debounced (marker fresh)
    expect(syncPush(j1).status).toBe("debounced");

    // a second fleet, different handle, different clone, same remote — writing
    // a v1 LEGACY path (frozen tree): still staged, still readable
    const dir2 = path.join(root, "casey-journal");
    ensureRepo(dir2, remote);
    syncPull(dir2);
    fs.mkdirSync(path.join(dir2, "log", "casey"), { recursive: true });
    fs.appendFileSync(
      path.join(dir2, "log", "casey", "2026-08-03.ndjson"),
      `${JSON.stringify({ v: 1, ts: 2, type: "message", data: { id: 1, from: "x", to: "y", body: "theirs", at: 2 } })}\n`,
    );
    expect(syncPush({ dir: dir2, project: j1.project, handle: "casey" }, { force: true }).status).toBe("pushed");

    // michael pulls and sees both namespaces intact (casey via the legacy tree)
    expect(syncPull(j1.dir).ok).toBe(true);
    expect(readEvents(j1.dir, j1.project, "michael")).toHaveLength(1);
    expect(readEvents(j1.dir, j1.project, "casey")).toHaveLength(1);
  });
});

describe("journal repo shape contract", () => {
  it("bootstraps the marker into an empty repo on first sync (even before any append)", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    // no appends yet — must not pathspec-error, must initialize the structure
    expect(syncPush(j, { force: true }).status).toBe("pushed");
    const check = path.join(root, "check");
    execFileSync("git", ["clone", "-q", remote, check], { stdio: "ignore" });
    expect(JSON.parse(fs.readFileSync(path.join(check, MARKER_FILE), "utf8"))).toEqual({ journal: 2 });
  });

  it("refuses a non-journal repo with content until --adopt, then preserves that content", () => {
    const remote = bareRemote("origin.git");
    seedRemote(remote, "README.md", "someone's actual repo\n");
    const j = journalAt("michael", remote);
    j.append("message", { id: 1, from: "a", to: "b", body: "x", at: 1 });
    const shaBefore = execFileSync("git", ["ls-remote", remote, "main"], { encoding: "utf8" });
    const refused = syncPush(j, { force: true });
    expect(refused.status).toBe("invalid");
    expect(refused.detail).toContain("yes-chef sync --adopt");
    // nothing was pushed — the remote's main is untouched
    expect(execFileSync("git", ["ls-remote", remote, "main"], { encoding: "utf8" })).toBe(shaBefore);

    const adopted = syncPush(j, { force: true, adopt: true });
    expect(adopted.status).toBe("pushed");
    const check = path.join(root, "check");
    execFileSync("git", ["clone", "-q", remote, check], { stdio: "ignore" });
    expect(fs.readFileSync(path.join(check, "README.md"), "utf8")).toContain("actual repo");
    expect(fs.existsSync(path.join(check, MARKER_FILE))).toBe(true);
  });

  it("fails loudly on a journal written by a newer layout", () => {
    const remote = bareRemote("origin.git");
    seedRemote(remote, MARKER_FILE, '{"journal": 99}\n');
    const j = journalAt("michael", remote);
    j.append("message", { id: 1, from: "a", to: "b", body: "x", at: 1 });
    const res = syncPush(j, { force: true });
    expect(res.status).toBe("invalid");
    expect(res.detail).toContain("newer yes-chef");
    // read path gates too
    expect(validateJournal(j.dir).ok).toBe(false);
  });

  it("returns clean (not error) when a forced sync has nothing new", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    j.append("message", { id: 1, from: "a", to: "b", body: "x", at: 1 });
    expect(syncPush(j, { force: true }).status).toBe("pushed");
    expect(syncPush(j, { force: true }).status).toBe("clean");
  });

  it("records sync health readable via readSyncStatus", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    expect(syncPush(j, { force: true }).status).toBe("pushed");
    expect(readSyncStatus(j.dir)?.status).toBe("pushed");
    // now break the remote and confirm the failure is visible
    fs.rmSync(remote, { recursive: true, force: true });
    j.append("message", { id: 2, from: "a", to: "b", body: "y", at: 2 });
    expect(syncPush(j, { force: true }).status).toBe("error");
    expect(readSyncStatus(j.dir)?.status).toBe("error");
  });
});

describe("same-handle multi-writer", () => {
  it("two machines on one handle append to distinct files and merge cleanly", () => {
    const remote = bareRemote("origin.git");
    const a = journalAt("michael", remote, { home: "homeA", writerId: "macbook" });
    a.append("task.create", { id: 1, by: "foreman", title: "t", state: "assigned", at: 1000 });
    expect(syncPush(a, { force: true }).status).toBe("pushed");

    const b = journalAt("michael", remote, { home: "homeB", writerId: "studio" });
    expect(syncPull(b.dir).ok).toBe(true);
    b.append("task.update", { id: 1, state: "returned", result: "done", at: 2000 });
    expect(syncPush(b, { force: true }).status).toBe("pushed");

    // machine A keeps writing the same day — no shared file, no rebase conflict
    a.append("message", { id: 1, from: "x", to: "y", body: "z", at: 3000 });
    expect(syncPush(a, { force: true }).status).toBe("pushed");
    expect(syncPull(a.dir).ok).toBe(true);

    const events = readEvents(a.dir, a.project, "michael");
    expect(events.map((e) => e.type)).toEqual(["task.create", "task.update", "message"]); // ts order
  });

  it("survives both sides initializing independently (unrelated root commits)", () => {
    const remote = bareRemote("origin.git");
    const a = journalAt("michael", remote, { home: "homeA", writerId: "macbook" });
    const b = journalAt("michael", remote, { home: "homeB", writerId: "studio" });
    a.append("message", { id: 1, from: "x", to: "y", body: "from a", at: 1 });
    b.append("message", { id: 2, from: "x", to: "y", body: "from b", at: 2 });
    expect(syncPush(a, { force: true }).status).toBe("pushed");
    expect(syncPush(b, { force: true }).status).toBe("pushed"); // rebases unrelated history
    expect(syncPull(a.dir).ok).toBe(true);
    expect(readEvents(a.dir, a.project, "michael")).toHaveLength(2);
  });
});

describe("journal v2: project identity", () => {
  it("derives owner--repo from scp and https origins, case-insensitively", () => {
    expect(projectFromOrigin("git@github.com:heymichaelp/Roundhouse.git")).toBe("heymichaelp--roundhouse");
    expect(projectFromOrigin("https://github.com/HeyMichaelP/roundhouse")).toBe("heymichaelp--roundhouse");
    expect(projectFromOrigin("https://gitlab.com/group/sub/repo.git")).toBe("sub--repo");
    expect(projectFromOrigin("")).toBeNull();
  });

  it("sanitizes path segments (no separators, dots, or empties escape the tree)", () => {
    expect(sanitizeSegment("Team/Handle")).toBe("team-handle");
    expect(sanitizeSegment("../../etc")).toBe("-.-..-etc".replace("-.-..-etc", sanitizeSegment("../../etc"))); // no leading dots
    expect(sanitizeSegment("../../etc").startsWith(".")).toBe(false);
    expect(sanitizeSegment("é🙂")).not.toBe("");
    expect(sanitizeSegment("", "local")).toBe("local");
  });

  it("openJournal writes to journal/<project>/<handle>/log and stamps agent + v2 marker", () => {
    const remote = bareRemote("origin.git");
    const j = openJournal({
      env: { AGENT_BUS_HOME: path.join(root, "unused-coord") },
      cwd: root,
      config: { ...DEFAULT_CONFIG, remote: { url: remote, handle: "Michael P", project: "My/Proj" } },
      agentId: "worker-2",
      writerId: "macbook",
    })!;
    expect(j.project).toBe("my-proj");
    expect(j.handle).toBe("michael-p");
    j.append("message", { id: 1, from: "a", to: "b", body: "x", at: 1 });
    const logDir = path.join(j.dir, "journal", "my-proj", "michael-p", "log");
    const files = fs.readdirSync(logDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.macbook\.ndjson$/);
    const ev = JSON.parse(fs.readFileSync(path.join(logDir, files[0]!), "utf8").trim()) as JournalEvent;
    expect(ev.agent).toBe("worker-2");
    expect(syncPush(j, { force: true }).status).toBe("pushed");
    expect(JSON.parse(fs.readFileSync(path.join(j.dir, MARKER_FILE), "utf8"))).toEqual({ journal: 2 });
    expect(listProjects(j.dir)).toEqual(["my-proj"]);
  });
});

describe("journal v2: legacy compat + upgrade", () => {
  it("merges frozen v1 events with v2 events in ts order, without moving legacy files", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    // seed a legacy v1 tree in the clone (as if written by an old plugin)
    const legacyDir = path.join(j.dir, "log", "michael");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "2026-08-01.oldbox.ndjson"),
      `${JSON.stringify({ v: 1, ts: 100, type: "task.create", data: { id: 1, by: "foreman", title: "old", state: "assigned", at: 100 } })}\n`,
    );
    j.append("task.update", { id: 1, state: "returned", result: "done", at: 200 });
    const events = readEvents(j.dir, j.project, "michael");
    expect(events.map((e) => e.type)).toEqual(["task.create", "task.update"]);
    expect(syncPush(j, { force: true }).status).toBe("pushed");
    // legacy file untouched, in place
    expect(fs.existsSync(path.join(legacyDir, "2026-08-01.oldbox.ndjson"))).toBe(true);
  });

  it("bumps a v1 marker to v2 on the write path and freezes the old tree", () => {
    const remote = bareRemote("origin.git");
    seedRemote(remote, MARKER_FILE, '{"journal": 1}\n');
    const j = journalAt("michael", remote);
    j.append("message", { id: 1, from: "a", to: "b", body: "x", at: 1 });
    expect(syncPush(j, { force: true }).status).toBe("pushed");
    const check = path.join(root, "check-upgrade");
    execFileSync("git", ["clone", "-q", remote, check], { stdio: "ignore" });
    expect(JSON.parse(fs.readFileSync(path.join(check, MARKER_FILE), "utf8"))).toEqual({ journal: 2 });
    // and the new event landed on the v2 path
    expect(fs.existsSync(path.join(check, "journal", j.project, "michael", "log"))).toBe(true);
  });

  it("a marker-less v1-only tree bootstraps straight to v2 without adopt", () => {
    const remote = bareRemote("origin.git");
    // simulate a phase-1 journal: log/ exists on the remote, no marker
    const work = fs.mkdtempSync(path.join(root, "seed1-"));
    execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
    execFileSync("git", ["-C", work, "checkout", "-q", "-B", "main"], { stdio: "ignore" });
    fs.mkdirSync(path.join(work, "log", "michael"), { recursive: true });
    fs.writeFileSync(path.join(work, "log", "michael", "2026-08-01.ndjson"), `${JSON.stringify({ v: 1, ts: 5, type: "message", data: { id: 9, from: "a", to: "b", body: "legacy", at: 5 } })}\n`);
    execFileSync("git", ["-C", work, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "v1"], { stdio: "ignore" });
    execFileSync("git", ["-C", work, "push", "-q", "origin", "main"], { stdio: "ignore" });

    const j = journalAt("michael", remote);
    expect(syncPush(j, { force: true }).status).toBe("pushed");
    expect(JSON.parse(fs.readFileSync(path.join(j.dir, MARKER_FILE), "utf8"))).toEqual({ journal: 2 });
    // legacy event still readable via the merged reader
    expect(readEvents(j.dir, j.project, "michael").map((e) => e.data.id)).toEqual([9]);
  });

  it("replays digest.note as a stateless no-op without the unknown-type warning", () => {
    const homeB = fs.mkdtempSync(path.join(root, "busB-"));
    const envB = { AGENT_BUS_HOME: homeB };
    const b = new Store({ env: envB });
    const res = replayInto(b, [{ v: 1, ts: 1, type: "digest.note", agent: "foreman", data: { text: "good day" } }], envB);
    expect(res.applied).toBe(1);
    expect(res.skipped).toBe(0);
    b.close();
  });
});
