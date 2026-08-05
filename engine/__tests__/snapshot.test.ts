import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSnapshot } from "../src/snapshot.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-snap-"));
  env = { HANDS_HOME: home };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("buildSnapshot", () => {
  it("derives agent states, detects file collisions, and orders feeds newest-first", () => {
    const store = new Store({ env });
    const now = 3_000_000_000_000;
    const min = 60_000;

    // wt1 & wt2 both active, both touching the same file → collision.
    store.setStatus({ id: "wt1", cwd: "/w1", pid: 1, branch: "b1", files: ["src/x.ts"], now });
    store.setStatus({ id: "wt2", cwd: "/w2", pid: 2, branch: "b2", files: ["src/x.ts"], now });
    // wt3 online but idle (last_active old, last_seen fresh).
    store.setStatus({ id: "wt3", cwd: "/w3", pid: 3, branch: "b3", now: now - 8 * min });
    store.touch("wt3", now);
    // wt4 offline (no heartbeat within the 15m presence window).
    store.setStatus({ id: "wt4", cwd: "/w4", pid: 4, branch: "b4", now: now - 20 * min });

    store.journalAdd({ agentId: "wt1", kind: "commit", ref: "s1", text: "older", now: now - 2 * min });
    store.journalAdd({ agentId: "wt2", kind: "memory", ref: "m", text: "newer", now: now - 1 * min });
    store.insertMessage({ from: "wt1", to: "wt2", body: "hi", now: now - 30_000 });

    const snap = buildSnapshot(store, now, env);
    const state = Object.fromEntries(snap.agents.map((a) => [a.id, a.state]));
    expect(state).toEqual({ wt1: "active", wt2: "active", wt3: "idle", wt4: "offline" });

    expect(snap.collisions).toEqual([{ a: "wt1", b: "wt2", kind: "file", detail: "x.ts" }]);

    // feeds newest-first
    expect(snap.journal.map((j) => j.text)).toEqual(["newer", "older"]);
    expect(snap.messages.map((m) => m.body)).toEqual(["hi"]);
    expect(snap.counts).toEqual({
      agents: 4,
      online: 3,
      messages: 1,
      journal: 2,
      openQuestions: 0,
      needsHuman: 0,
      githubPrs: 0,
      activeTasks: 0,
      returnedTasks: 0,
      openTodos: 0,
    });
    store.close();
  });

  it("flags a ticket collision when files don't overlap", () => {
    const store = new Store({ env });
    const now = 3_000_000_000_000;
    store.setStatus({ id: "wtA", cwd: "/a", pid: 1, branch: "feature/eng-9", files: ["a.ts"], ticket: "ENG-9", now });
    store.setStatus({ id: "wtB", cwd: "/b", pid: 2, branch: "fix/eng-9", files: ["b.ts"], ticket: "ENG-9", now });
    const snap = buildSnapshot(store, now, env);
    expect(snap.collisions).toEqual([{ a: "wtA", b: "wtB", kind: "ticket", detail: "ENG-9" }]);
    store.close();
  });

  it("surfaces unacked expo commands per station, clearing once the cursor passes them", () => {
    const store = new Store({ env });
    const now = 3_000_000_000_000;
    store.setStatus({ id: "expo", cwd: "/e", pid: 1, now });
    store.setStatus({ id: "wt1", cwd: "/w1", pid: 2, now });

    const id1 = store.insertMessage({ from: "expo", to: "wt1", body: "merge conflict on #12", now });
    store.insertMessage({ from: "expo", to: "wt1", body: "swap to #39", now: now + 1000 });
    // A non-expo sender's directed message shouldn't count as a "command".
    store.insertMessage({ from: "wt1", to: "wt1", body: "self note", now: now + 2000 });

    let snap = buildSnapshot(store, now, env);
    const wt1 = snap.agents.find((a) => a.id === "wt1")!;
    expect(wt1.pendingCommands.map((c) => c.body)).toEqual(["merge conflict on #12", "swap to #39"]);
    expect(snap.agents.find((a) => a.id === "expo")!.pendingCommands).toEqual([]);

    // Draining past the first command leaves only the second pending.
    store.setCursor("wt1", id1);
    snap = buildSnapshot(store, now, env);
    expect(snap.agents.find((a) => a.id === "wt1")!.pendingCommands.map((c) => c.body)).toEqual(["swap to #39"]);
    store.close();
  });
});
