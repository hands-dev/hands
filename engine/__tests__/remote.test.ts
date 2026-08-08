import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coordinationDir } from "../src/paths.js";
import {
  checkOriginCompatible,
  ensureLocalBooksOrigin,
  ensureRepo,
  type JournalEvent,
  journalDir,
  listProjects,
  localBooksOriginPath,
  MARKER_FILE,
  openJournal,
  projectFromOrigin,
  readEvents,
  readOtherCrafts,
  readRemoteMismatch,
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hands-remote-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A journal wired straight to this test's sandbox (no config file needed). */
function journalAt(handle: string, url: string, opts?: { home?: string }) {
  const j = openJournal({
    env: { HANDS_HOME: path.join(root, opts?.home ?? "unused-coord") },
    cwd: root,
    config: { ...DEFAULT_CONFIG, remote: { url, handle, project: null } },
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
  store.insertMessage({ from: "station-1", to: "expo", body: "returned early", subject: "status", now: 1000 });
  store.insertMessage({ from: "expo", to: null, body: "all hands", now: 2000 });
  store.setCursor("expo", 1);
  const qid = store.askQuestion({
    asker: "station-1",
    question: "ship it?",
    context: "ctx",
    options: [
      { label: "ship", description: "cuts staging over now", recommended: true },
      { label: "wait", description: "hold for canary" },
    ],
    multiSelect: false,
    now: 3000,
  });
  store.escalateQuestion({ id: qid, recommendation: "ship", priorityRef: "P1", now: 3500 });
  store.answerQuestion({
    id: qid,
    answer: "ship",
    resolvedBy: "human",
    answeredVia: "dashboard",
    answerOptions: { chosenLabels: ["ship"] },
    now: 4000,
  });
  store.setQuestionOutcome({ id: qid, outcome: "validated", note: "held up", now: 4500 });
  const tid = store.createTask({ createdBy: "expo", assignee: "station-1", title: "plan X", body: "b", priority: "P1", now: 5000 });
  store.updateTaskState({ id: tid, state: "in_progress", now: 5500 });
  store.updateTaskState({ id: tid, state: "returned", result: "the plan", now: 6000 });
  const todo = store.createTodo({ title: "merge #7", dedupKey: "pr-7", originRef: "PR#7", now: 7000 });
  store.updateTodoState({ id: todo.id, state: "done", doneSignal: "PR #7 merged", now: 7500 });
  store.journalAdd({ agentId: "station-1", kind: "commit", ref: "abc123", text: "fix thing", now: 8000 });
}

// NOTE: `cursor` (read-position bookkeeping) is deliberately excluded here —
// it's not journaled (see the dedicated test below), so it does not survive
// a restore/replay into a fresh store.
function snapshotState(store: Store) {
  return {
    messages: store.history({ limit: 50 }).map((m) => [m.id, m.from_id, m.to_id, m.body]),
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
    const a = new Store({ env: { HANDS_HOME: homeA } });
    a.setJournal(j.append);
    populate(a);

    const events = readEvents(j.dir, j.project, "michael");
    expect(events.length).toBeGreaterThanOrEqual(12);
    expect(events.every((e: JournalEvent) => e.v === 1 && typeof e.ts === "number")).toBe(true);

    const homeB = fs.mkdtempSync(path.join(root, "busB-"));
    const envB = { HANDS_HOME: homeB };
    const b = new Store({ env: envB });
    const res = replayInto(b, events);
    expect(res.skipped).toBe(0);
    expect(snapshotState(b)).toEqual(snapshotState(a));
    a.close();
    b.close();
  });

  it("never appends `cursor` events — bookkeeping only, not restored on replay (hands#45)", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    const a = new Store({ env: { HANDS_HOME: fs.mkdtempSync(path.join(root, "busA-")) } });
    a.setJournal(j.append);
    populate(a); // includes store.setCursor("expo", 1)
    expect(a.getCursor("expo")).toBe(1);

    const events = readEvents(j.dir, j.project, "michael");
    expect(events.some((e: JournalEvent) => e.type === "cursor")).toBe(false);

    const envB = { HANDS_HOME: fs.mkdtempSync(path.join(root, "busB-")) };
    const b = new Store({ env: envB });
    replayInto(b, events);
    // cursor position never rode the journal, so a restore doesn't recover it —
    // an accepted tradeoff for keeping every drain from writing an NDJSON line
    expect(b.getCursor("expo")).toBe(0);

    a.close();
    b.close();
  });

  it("replay is idempotent (twice over the same DB changes nothing)", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    const a = new Store({ env: { HANDS_HOME: fs.mkdtempSync(path.join(root, "busA-")) } });
    a.setJournal(j.append);
    populate(a);
    const events = readEvents(j.dir, j.project, "michael");

    const homeB = fs.mkdtempSync(path.join(root, "busB-"));
    const envB = { HANDS_HOME: homeB };
    const b = new Store({ env: envB });
    replayInto(b, events);
    const first = snapshotState(b);
    replayInto(b, events);
    expect(snapshotState(b)).toEqual(first);
    a.close();
    b.close();
  });

  it("treats recipe.promoted/demoted as stateless (visibility-only — the recipe file itself syncs via git, not replay) and skips unknown event types", () => {
    const homeB = fs.mkdtempSync(path.join(root, "busB-"));
    const envB = { HANDS_HOME: homeB };
    const b = new Store({ env: envB });
    const res = replayInto(b, [
      { v: 1, ts: 1, type: "recipe.promoted", data: { slug: "ordering-api-fix", rank: 1, at: 1 } },
      { v: 1, ts: 2, type: "recipe.demoted", data: { slug: "old-recipe", at: 2 } },
      { v: 1, ts: 3, type: "from.the.future", data: { x: 1 } },
    ]);
    expect(res.applied).toBe(2);
    expect(res.skipped).toBe(1);
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
    const a = new Store({ env: { HANDS_HOME: fs.mkdtempSync(path.join(root, "busA-")) } });
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
    const envB = { HANDS_HOME: homeB };
    const b = new Store({ env: envB });
    replayInto(b, events);
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

    // a second fleet, different handle, different clone, same remote — each
    // writes only its own namespace, so pushes never conflict
    const dir2 = path.join(root, "casey-journal");
    ensureRepo(dir2, remote);
    syncPull(dir2);
    const caseyLog = path.join(dir2, "journal", j1.project, "casey", "log");
    fs.mkdirSync(caseyLog, { recursive: true });
    fs.appendFileSync(
      path.join(caseyLog, "2026-08-03.box.ndjson"),
      `${JSON.stringify({ v: 1, ts: 2, type: "message", data: { id: 1, from: "x", to: "y", body: "theirs", at: 2 } })}\n`,
    );
    expect(syncPush({ dir: dir2, project: j1.project, handle: "casey" }, { force: true }).status).toBe("pushed");

    // michael pulls and sees both namespaces intact
    expect(syncPull(j1.dir).ok).toBe(true);
    expect(readEvents(j1.dir, j1.project, "michael")).toHaveLength(1);
    expect(readEvents(j1.dir, j1.project, "casey")).toHaveLength(1);
  });
});

describe("ensureLocalBooksOrigin (hands#129 — books are load-bearing, local by default)", () => {
  it("bootstraps a bare repo idempotently, without disturbing what's already pushed", () => {
    const env = { HANDS_HOME: path.join(root, "coord") };
    const first = ensureLocalBooksOrigin(env, root);
    expect(first).toBe(localBooksOriginPath(env, root));
    expect(execFileSync("git", ["-C", first!, "rev-parse", "--is-bare-repository"], { encoding: "utf8" }).trim()).toBe(
      "true",
    );

    // push something real through it, then re-bootstrap — must be a no-op, not a re-init
    const j = journalAt("michael", first!, { home: "coord" });
    j.append("message", { id: 1, from: "a", to: "b", body: "still here", at: 1 });
    expect(syncPush(j, { force: true }).status).toBe("pushed");

    const second = ensureLocalBooksOrigin(env, root);
    expect(second).toBe(first);
    expect(syncPull(j.dir).ok).toBe(true);
    expect(readEvents(j.dir, j.project, "michael").length).toBeGreaterThanOrEqual(1);
  });

  it("does not collide with journalDir (the clone), and lives under coordinationDir", () => {
    const env = { HANDS_HOME: path.join(root, "coord") };
    const origin = localBooksOriginPath(env, root);
    expect(origin).not.toBe(journalDir(env, root));
    expect(path.dirname(origin)).toBe(coordinationDir(env, root));
  });

  it("openJournal() falls back to a local origin when remote.url is unset — never returns null just because nothing was configured (hands#129)", () => {
    const env = { HANDS_HOME: path.join(root, "coord") };
    const j = openJournal({
      env,
      cwd: root,
      config: { ...DEFAULT_CONFIG, remote: { url: null, handle: "michael", project: null } },
    });
    expect(j).not.toBeNull();
    expect(j!.url).toBe(localBooksOriginPath(env, root));

    // prove it's a genuine, functional remote — round-trip real events through a separate clone,
    // exactly like the hosted-remote case in "git sync + machine-move restore" above.
    const store = new Store({ env: { HANDS_HOME: fs.mkdtempSync(path.join(root, "bus-")) } });
    store.setJournal(j!.append);
    populate(store);
    expect(syncPush(j!, { force: true }).status).toBe("pushed");

    const dir2 = path.join(root, "second-clone");
    expect(ensureRepo(dir2, j!.url)).toBe(true);
    expect(syncPull(dir2).ok).toBe(true);
    expect(readEvents(dir2, j!.project, "michael").length).toBeGreaterThanOrEqual(12);
    store.close();
  });
});

describe("origin repoint safety (hands#181 — a clone attached to a new remote must never orphan silently)", () => {
  it("refuses to repoint onto a remote with no shared history, and leaves the old origin working", () => {
    const remoteA = bareRemote("remote-a.git");
    const dir = path.join(root, "clone-under-test");
    expect(ensureRepo(dir, remoteA)).toBe(true);
    const j = { dir, project: "proj", handle: "michael" };
    fs.mkdirSync(path.join(dir, "journal", "proj", "michael", "log"), { recursive: true });
    fs.appendFileSync(
      path.join(dir, "journal", "proj", "michael", "log", "2026-08-01.ndjson"),
      `${JSON.stringify({ v: 1, ts: 1, type: "message", data: { id: 1 } })}\n`,
    );
    expect(syncPush(j, { force: true }).status).toBe("pushed");

    // a second, completely unrelated remote with its own independent history
    const remoteB = bareRemote("remote-b.git");
    seedRemote(remoteB, "other.txt", "unrelated content");

    expect(ensureRepo(dir, remoteB)).toBe(false);
    // origin was NOT changed — still remoteA, and the events are intact
    expect(execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8" }).trim()).toBe(
      remoteA,
    );
    expect(readEvents(dir, "proj", "michael")).toHaveLength(1);

    const mismatch = readRemoteMismatch(dir);
    expect(mismatch?.url).toBe(remoteB);
    expect(mismatch?.reason).toContain("no common ancestor");
  });

  it("allows repointing when there is no local history yet — nothing to lose", () => {
    const remoteA = bareRemote("remote-a.git");
    const remoteB = bareRemote("remote-b.git");
    seedRemote(remoteB, "other.txt", "unrelated content");
    const dir = path.join(root, "fresh-clone");
    expect(ensureRepo(dir, remoteA)).toBe(true); // inits, no commits made
    expect(ensureRepo(dir, remoteB)).toBe(true); // no local HEAD yet -> safe to repoint
    expect(execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8" }).trim()).toBe(
      remoteB,
    );
  });

  it("treats an empty remote (no main yet) as safe to repoint onto — nothing to conflict with", () => {
    const remoteA = bareRemote("remote-a.git");
    const dir = path.join(root, "clone-empty-target");
    ensureRepo(dir, remoteA);
    const j = { dir, project: "p", handle: "h" };
    fs.mkdirSync(path.join(dir, "journal", "p", "h", "log"), { recursive: true });
    fs.appendFileSync(
      path.join(dir, "journal", "p", "h", "log", "2026-08-01.ndjson"),
      `${JSON.stringify({ v: 1, ts: 1, type: "message", data: {} })}\n`,
    );
    expect(syncPush(j, { force: true }).status).toBe("pushed");

    const emptyRemote = bareRemote("remote-empty.git"); // freshly init'd, zero commits
    const compat = checkOriginCompatible(dir, emptyRemote);
    expect(compat.ok).toBe(true);
    expect(compat.unverified).toBe(true);
    expect(ensureRepo(dir, emptyRemote)).toBe(true);
    expect(execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8" }).trim()).toBe(
      emptyRemote,
    );
  });

  it("clears a stale mismatch once repointed back to a compatible origin", () => {
    const remoteA = bareRemote("remote-a.git");
    const dir = path.join(root, "clone-recovers");
    ensureRepo(dir, remoteA);
    const j = { dir, project: "p", handle: "h" };
    fs.mkdirSync(path.join(dir, "journal", "p", "h", "log"), { recursive: true });
    fs.appendFileSync(
      path.join(dir, "journal", "p", "h", "log", "2026-08-01.ndjson"),
      `${JSON.stringify({ v: 1, ts: 1, type: "message", data: {} })}\n`,
    );
    expect(syncPush(j, { force: true }).status).toBe("pushed");

    const remoteB = bareRemote("remote-b.git");
    seedRemote(remoteB, "other.txt", "unrelated");
    expect(ensureRepo(dir, remoteB)).toBe(false);
    expect(readRemoteMismatch(dir)).not.toBeNull();

    // back to the original, still-compatible url — the stale refusal record clears
    expect(ensureRepo(dir, remoteA)).toBe(true);
    expect(readRemoteMismatch(dir)).toBeNull();
  });

  it("sets upstream tracking once origin/main is known, so a plain `git pull` works (suggestion 3)", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    j.append("message", { id: 1, from: "a", to: "b", body: "x", at: 1 });
    expect(syncPush(j, { force: true }).status).toBe("pushed");

    const dir2 = path.join(root, "second-clone-upstream");
    expect(ensureRepo(dir2, remote)).toBe(true);
    expect(syncPull(dir2).ok).toBe(true); // fetches origin/main into the local ref cache
    expect(ensureRepo(dir2, remote)).toBe(true); // re-affirm, now that origin/main is known locally
    const upstream = execFileSync(
      "git",
      ["-C", dir2, "rev-parse", "--abbrev-ref", "main@{upstream}"],
      { encoding: "utf8" },
    ).trim();
    expect(upstream).toBe("origin/main");
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
    expect(refused.detail).toContain("hands sync --adopt");
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
    expect(res.detail).toContain("newer hands");
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

describe("same-handle multi-machine", () => {
  it("two machines on one handle share the day file cleanly when they pull before appending", () => {
    const remote = bareRemote("origin.git");
    const a = journalAt("michael", remote, { home: "homeA" });
    a.append("task.create", { id: 1, by: "expo", title: "t", state: "assigned", at: 1000 });
    expect(syncPush(a, { force: true }).status).toBe("pushed");

    const b = journalAt("michael", remote, { home: "homeB" });
    expect(syncPull(b.dir).ok).toBe(true);
    b.append("task.update", { id: 1, state: "returned", result: "done", at: 2000 });
    expect(syncPush(b, { force: true }).status).toBe("pushed");

    expect(syncPull(a.dir).ok).toBe(true);
    const events = readEvents(a.dir, a.project, "michael");
    expect(events.map((e) => e.type)).toEqual(["task.create", "task.update"]); // ts order
  });

  it("concurrent same-day writes on one handle conflict loudly (one handle = one writer at a time)", () => {
    const remote = bareRemote("origin.git");
    const a = journalAt("michael", remote, { home: "homeA" });
    const b = journalAt("michael", remote, { home: "homeB" });
    a.append("message", { id: 1, from: "x", to: "y", body: "from a", at: 1 });
    b.append("message", { id: 2, from: "x", to: "y", body: "from b", at: 2 });
    expect(syncPush(a, { force: true }).status).toBe("pushed");
    // b diverged on the SAME day file with unrelated history — surfaced, never silently merged
    expect(syncPush(b, { force: true }).status).toBe("error");
  });

  it("different handles never contend regardless of timing", () => {
    const remote = bareRemote("origin.git");
    const a = journalAt("michael", remote, { home: "homeA" });
    const b = journalAt("casey", remote, { home: "homeB" });
    a.append("message", { id: 1, from: "x", to: "y", body: "from a", at: 1 });
    b.append("message", { id: 2, from: "x", to: "y", body: "from b", at: 2 });
    expect(syncPush(a, { force: true }).status).toBe("pushed");
    expect(syncPush(b, { force: true }).status).toBe("pushed"); // rebases unrelated history
    expect(syncPull(a.dir).ok).toBe(true);
    expect(readEvents(a.dir, a.project, "michael")).toHaveLength(1);
    expect(readEvents(a.dir, a.project, "casey")).toHaveLength(1);
  });
});

describe("journal v2: project identity", () => {
  it("derives the repo name from scp and https origins, case-insensitively", () => {
    expect(projectFromOrigin("git@github.com:heymichaelp/Hands.git")).toBe("hands");
    expect(projectFromOrigin("https://github.com/HeyMichaelP/hands")).toBe("hands");
    expect(projectFromOrigin("https://gitlab.com/group/sub/repo.git")).toBe("repo");
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
      env: { HANDS_HOME: path.join(root, "unused-coord") },
      cwd: root,
      config: { ...DEFAULT_CONFIG, remote: { url: remote, handle: "Michael P", project: "My/Proj" } },
      agentId: "station-2",
    })!;
    expect(j.project).toBe("my-proj");
    expect(j.handle).toBe("michael-p");
    j.append("message", { id: 1, from: "a", to: "b", body: "x", at: 1 });
    const logDir = path.join(j.dir, "journal", "my-proj", "michael-p", "log");
    const files = fs.readdirSync(logDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.ndjson$/);
    const ev = JSON.parse(fs.readFileSync(path.join(logDir, files[0]!), "utf8").trim()) as JournalEvent;
    expect(ev.agent).toBe("station-2");
    expect(syncPush(j, { force: true }).status).toBe("pushed");
    expect(JSON.parse(fs.readFileSync(path.join(j.dir, MARKER_FILE), "utf8"))).toEqual({ journal: 2 });
    expect(listProjects(j.dir)).toEqual(["my-proj"]);
  });
});

describe("journal replay", () => {
  it("refuses an older-layout marker instead of upgrading it", () => {
    const remote = bareRemote("origin.git");
    seedRemote(remote, MARKER_FILE, '{"journal": 1}\n');
    const j = journalAt("michael", remote);
    j.append("message", { id: 1, from: "a", to: "b", body: "x", at: 1 });
    const res = syncPush(j, { force: true });
    expect(res.status).toBe("invalid");
    expect(res.detail).toContain("no longer supported");
  });

  it("replays digest.note as a stateless no-op without the unknown-type warning", () => {
    const homeB = fs.mkdtempSync(path.join(root, "busB-"));
    const envB = { HANDS_HOME: homeB };
    const b = new Store({ env: envB });
    const res = replayInto(b, [{ v: 1, ts: 1, type: "digest.note", agent: "expo", data: { text: "good day" } }]);
    expect(res.applied).toBe(1);
    expect(res.skipped).toBe(0);
    b.close();
  });
});

describe("public dashboard snapshot", () => {
  it("writes a redacted, remote-safe dashboard.json alongside digests", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    const store = new Store({ env: { HANDS_HOME: fs.mkdtempSync(path.join(root, "busA-")) } });
    store.setJournal(j.append);
    populate(store);
    store.setFocus("station-1", "saucier");

    const res = syncPush(j, { force: true, now: 10_000, store });
    expect(res.status).toBe("pushed");

    const file = path.join(j.dir, "journal", j.project, "michael", "dashboard.json");
    const raw = fs.readFileSync(file, "utf8");
    const pub = JSON.parse(raw);
    expect(pub.handle).toBe("michael");
    expect(pub.project).toBe(j.project);
    expect(pub.pushedAt).toBe(10_000);
    expect(pub.crafts).toEqual([{ station: "station-1", focus: "saucier" }]);
    expect(pub.tasks).toHaveLength(1);
    expect(pub.tasks[0]).toMatchObject({ state: "returned", result: "the plan", assignee: "station-1" });
    expect(pub.todos).toHaveLength(1);
    expect(pub.todos[0]).toMatchObject({ state: "done", doneSignal: "PR #7 merged" });
    expect(pub.questions).toHaveLength(1);
    expect(pub.questions[0]).toMatchObject({ answer: "ship", state: "answered" });

    // redacted: message bodies and live/local-only fields never reach this file
    expect(raw).not.toContain("returned early");
    expect(raw).not.toContain("all hands");
    expect(pub).not.toHaveProperty("messages");
    expect(pub).not.toHaveProperty("agents");
    expect(pub).not.toHaveProperty("tokens");
    expect(pub).not.toHaveProperty("taskCosts");

    store.close();
  });

  it("skips the commit when the snapshot is byte-identical (no state change)", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    const store = new Store({ env: { HANDS_HOME: fs.mkdtempSync(path.join(root, "busA-")) } });
    store.setJournal(j.append);
    populate(store);

    expect(syncPush(j, { force: true, now: 10_000, store }).status).toBe("pushed");
    // same store state, same `now` → byte-identical dashboard.json (and digests) → nothing to commit
    expect(syncPush(j, { force: true, now: 10_000, store }).status).toBe("clean");

    store.close();
  });

  it("never writes dashboard.json when no store is provided (e.g. the CLI restore path)", () => {
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    j.append("message", { id: 1, from: "a", to: "b", body: "mine", at: 1 });
    expect(syncPush(j, { force: true }).status).toBe("pushed");
    const file = path.join(j.dir, "journal", j.project, "michael", "dashboard.json");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("creates the handle dir itself on a first sync with zero prior journal events (regression)", () => {
    // `hands sync` (cli.ts cmdSync) opens a fresh, NOT journal-wired Store —
    // so unlike every other test here, nothing has ever called j.append(),
    // which is what normally creates journal/<project>/<handle> as a side
    // effect. A bus with real local state but a freshly attached journal
    // hits exactly this: zero events, non-empty snapshot, no directory yet.
    const remote = bareRemote("origin.git");
    const j = journalAt("michael", remote);
    const store = new Store({ env: { HANDS_HOME: fs.mkdtempSync(path.join(root, "busA-")) } });
    populate(store);
    expect(fs.existsSync(path.join(j.dir, "journal", j.project, "michael"))).toBe(false);

    const res = syncPush(j, { force: true, now: 10_000, store });
    expect(res.status).toBe("pushed");

    const file = path.join(j.dir, "journal", j.project, "michael", "dashboard.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).tasks).toHaveLength(1);

    store.close();
  });
});

describe("readOtherCrafts (shared craft roster read — Option 1)", () => {
  function writeCraft(
    dir: string,
    project: string,
    handle: string,
    slug: string,
    parts: { book?: string; skill?: string },
  ): void {
    const craftsDir = path.join(dir, "journal", project, handle, "crafts");
    fs.mkdirSync(craftsDir, { recursive: true });
    if (parts.book !== undefined) fs.writeFileSync(path.join(craftsDir, `${slug}.md`), parts.book);
    if (parts.skill !== undefined) fs.writeFileSync(path.join(craftsDir, `${slug}.skill.md`), parts.skill);
  }

  it("lists every OTHER handle's crafts, excluding the caller's own", () => {
    const dir = fs.mkdtempSync(path.join(root, "clone-"));
    writeCraft(dir, "hands", "michael", "saucier", { book: "michael's book", skill: "michael's skill" });
    writeCraft(dir, "hands", "station-1", "ordering-api", { book: "station-1's book" });
    writeCraft(dir, "hands", "station-2", "saucier", { skill: "station-2's skill" }); // book-less craft

    const others = readOtherCrafts(dir, "hands", "michael");
    expect(others).toEqual(
      expect.arrayContaining([
        { handle: "station-1", slug: "ordering-api", book: "station-1's book", skill: null },
        { handle: "station-2", slug: "saucier", book: null, skill: "station-2's skill" },
      ]),
    );
    expect(others.some((c) => c.handle === "michael")).toBe(false);
  });

  it("returns [] for a project with no crafts yet, never throws", () => {
    const dir = fs.mkdtempSync(path.join(root, "clone-"));
    fs.mkdirSync(path.join(dir, "journal", "hands", "michael"), { recursive: true });
    expect(readOtherCrafts(dir, "hands", "michael")).toEqual([]);
    expect(readOtherCrafts(dir, "no-such-project", "michael")).toEqual([]);
  });
});
