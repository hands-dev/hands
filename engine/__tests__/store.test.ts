import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSignoffStale, ONLINE_WINDOW_MS, Store } from "../src/store.js";

/** A pid guaranteed dead: spawnSync blocks until the child exits, so by the time it returns the pid is reaped. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid!;
}

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-test-"));
  env = { HANDS_HOME: home };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function open(): Store {
  return new Store({ env });
}

describe("Store delivery", () => {
  it("delivers directed messages only to the addressee", () => {
    const store = open();
    store.registerAgent({ id: "wt1", cwd: "/a", pid: 1 });
    store.registerAgent({ id: "wt2", cwd: "/b", pid: 2 });
    store.insertMessage({ from: "wt1", to: "wt2", body: "hi wt2" });

    expect(store.messagesSince("wt2", 0).map((m) => m.body)).toEqual(["hi wt2"]);
    expect(store.messagesSince("wt1", 0)).toEqual([]); // not addressed to wt1
    store.close();
  });

  it("delivers broadcast (to_id NULL) to everyone except the sender", () => {
    const store = open();
    store.insertMessage({ from: "wt1", to: null, body: "all hands" });

    expect(store.messagesSince("wt2", 0).map((m) => m.body)).toEqual(["all hands"]);
    expect(store.messagesSince("wt3", 0).map((m) => m.body)).toEqual(["all hands"]);
    expect(store.messagesSince("wt1", 0)).toEqual([]); // sender excluded
    store.close();
  });

  it("respects the cursor so read messages are not re-delivered", () => {
    const store = open();
    const id1 = store.insertMessage({ from: "wt1", to: "wt2", body: "one" });
    store.setCursor("wt2", id1);
    store.insertMessage({ from: "wt1", to: "wt2", body: "two" });

    const fresh = store.messagesSince("wt2", store.getCursor("wt2"));
    expect(fresh.map((m) => m.body)).toEqual(["two"]);
    store.close();
  });
});

describe("Store peers", () => {
  it("marks agents online within the heartbeat window and offline past it", () => {
    const store = open();
    const now = 1_000_000_000_000;
    store.registerAgent({ id: "fresh", cwd: "/a", pid: 1, now });
    store.registerAgent({ id: "stale", cwd: "/b", pid: 2, now: now - ONLINE_WINDOW_MS - 1 });

    const peers = store.listPeers(now);
    const byId = Object.fromEntries(peers.map((p) => [p.id, p.online]));
    expect(byId).toEqual({ fresh: true, stale: false });
    store.close();
  });

  it("touch refreshes last_seen_at", () => {
    const store = open();
    const t0 = 1_000_000_000_000;
    store.registerAgent({ id: "wt1", cwd: "/a", pid: 1, now: t0 - ONLINE_WINDOW_MS - 1 });
    expect(store.listPeers(t0).find((p) => p.id === "wt1")?.online).toBe(false);
    store.touch("wt1", t0);
    expect(store.listPeers(t0).find((p) => p.id === "wt1")?.online).toBe(true);
    store.close();
  });

  it("alive reflects pid liveness, independent of the heartbeat window (hands#183)", () => {
    const store = open();
    const now = 1_000_000_000_000;
    // Both fresh (well inside ONLINE_WINDOW_MS) — online alone can't tell them apart.
    store.registerAgent({ id: "here", cwd: "/a", pid: process.pid, now });
    store.registerAgent({ id: "gone", cwd: "/b", pid: deadPid(), now });

    const peers = store.listPeers(now);
    expect(peers.find((p) => p.id === "here")).toMatchObject({ online: true, alive: true });
    expect(peers.find((p) => p.id === "gone")).toMatchObject({ online: true, alive: false });
    store.close();
  });

  it("pid 0 (a setFocus stub row for an agent that never registered) reads alive — unknown, not disprovable", () => {
    const store = open();
    const now = 1_000_000_000_000;
    store.setFocus("not-yet-registered", "some craft", now);
    expect(store.listPeers(now).find((p) => p.id === "not-yet-registered")).toMatchObject({
      pid: 0,
      alive: true,
    });
    store.close();
  });
});

describe("Store persistence", () => {
  it("keeps history across a server restart (reopen on the same file)", () => {
    const first = open();
    first.insertMessage({ from: "wt1", to: "wt2", body: "durable" });
    first.close();

    const second = open(); // same HANDS_HOME → same db file
    expect(second.history().map((m) => m.body)).toEqual(["durable"]);
    second.close();
  });

  it("filters history by peer and thread", () => {
    const store = open();
    store.insertMessage({ from: "wt1", to: "wt2", body: "a", thread: "t1" });
    store.insertMessage({ from: "wt1", to: "wt3", body: "b", thread: "t2" });
    store.insertMessage({ from: "wt3", to: "wt1", body: "c", thread: "t2" });

    expect(store.history({ peer: "wt3" }).map((m) => m.body)).toEqual(["b", "c"]);
    expect(store.history({ thread: "t2" }).map((m) => m.body)).toEqual(["b", "c"]);
    expect(store.history({ peer: "wt2" }).map((m) => m.body)).toEqual(["a"]);
    store.close();
  });
});

describe("Store session names (hands#104)", () => {
  it("can be assigned before the station's first turn registers it, upsert-style", () => {
    const store = open();
    store.setSessionName("station-1", "myrepo · station-1 (blue)");
    expect(store.getSessionName("station-1")).toBe("myrepo · station-1 (blue)");
    // the stub row it created is a real agent row, findable via listPeers
    expect(store.listPeers().map((p) => p.id)).toContain("station-1");
    store.close();
  });

  it("survives registerAgent (which only ever touches cwd/pid/last_seen_at)", () => {
    const store = open();
    store.setSessionName("station-1", "myrepo · station-1 (blue)");
    store.registerAgent({ id: "station-1", cwd: "/w1", pid: 123 });
    expect(store.getSessionName("station-1")).toBe("myrepo · station-1 (blue)");
    expect(store.listPeers().find((p) => p.id === "station-1")?.cwd).toBe("/w1");
    store.close();
  });

  it("returns null for an agent that never had a name assigned", () => {
    const store = open();
    store.registerAgent({ id: "station-1", cwd: "/w1", pid: 123 });
    expect(store.getSessionName("station-1")).toBeNull();
    store.close();
  });

  it("can be reassigned (re-provisioning the same index keeps it consistent)", () => {
    const store = open();
    store.setSessionName("station-1", "first name");
    store.setSessionName("station-1", "second name");
    expect(store.getSessionName("station-1")).toBe("second name");
    store.close();
  });
});

describe("Store security", () => {
  it("creates the db file with 0600 permissions", () => {
    const store = open();
    store.insertMessage({ from: "wt1", to: "wt2", body: "x" });
    const mode = fs.statSync(path.join(home, "hands.db")).mode & 0o777;
    expect(mode).toBe(0o600);
    store.close();
  });
});

describe("Store observability samples (hands#103, #106)", () => {
  it("records and reads back context samples, newest first", () => {
    const store = open();
    store.recordContextSample({ agentId: "station-1", inputTokens: 100, cacheReadTokens: 10, cacheCreationTokens: 0, now: 1000 });
    store.recordContextSample({ agentId: "station-1", inputTokens: 200, cacheReadTokens: 20, cacheCreationTokens: 5, now: 2000 });
    store.recordContextSample({ agentId: "expo", inputTokens: 999, cacheReadTokens: 0, cacheCreationTokens: 0, now: 1500 });

    expect(store.contextSamples("station-1")).toEqual([
      { inputTokens: 200, cacheReadTokens: 20, cacheCreationTokens: 5, at: 2000 },
      { inputTokens: 100, cacheReadTokens: 10, cacheCreationTokens: 0, at: 1000 },
    ]);
    store.close();
  });

  it("trims context samples older than 7 days on insert", () => {
    const store = open();
    const day = 24 * 60 * 60_000;
    store.recordContextSample({ agentId: "station-1", inputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, now: 0 });
    store.recordContextSample({ agentId: "station-1", inputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, now: 8 * day });
    expect(store.contextSamples("station-1").map((s) => s.inputTokens)).toEqual([2]);
    store.close();
  });

  it("contextSamplesForAgents fetches every requested agent in one call, empty array for one with no samples", () => {
    const store = open();
    store.recordContextSample({ agentId: "station-1", inputTokens: 100, cacheReadTokens: 10, cacheCreationTokens: 0, now: 1000 });
    store.recordContextSample({ agentId: "expo", inputTokens: 999, cacheReadTokens: 0, cacheCreationTokens: 0, now: 1500 });

    const result = store.contextSamplesForAgents(["expo", "station-1", "station-2"]);
    expect(result["expo"]).toEqual([{ inputTokens: 999, cacheReadTokens: 0, cacheCreationTokens: 0, at: 1500 }]);
    expect(result["station-1"]).toEqual([{ inputTokens: 100, cacheReadTokens: 10, cacheCreationTokens: 0, at: 1000 }]);
    expect(result["station-2"]).toEqual([]);
    store.close();
  });

  it("contextSamplesForAgents respects the limit per agent", () => {
    const store = open();
    for (let i = 0; i < 5; i++) {
      store.recordContextSample({ agentId: "station-1", inputTokens: i, cacheReadTokens: 0, cacheCreationTokens: 0, now: i });
    }
    expect(store.contextSamplesForAgents(["station-1"], 2)["station-1"]).toHaveLength(2);
    store.close();
  });

  it("records and reads back subagent samples, newest first", () => {
    const store = open();
    store.recordSubagentSample({ ownerAgentId: "station-1", agentType: "Explore", spawnDepth: 1, outputTokens: 500, now: 1000 });
    store.recordSubagentSample({ ownerAgentId: "station-1", agentType: null, spawnDepth: null, outputTokens: 20, now: 2000 });

    expect(store.subagentSamples("station-1")).toEqual([
      { agentType: null, spawnDepth: null, outputTokens: 20, at: 2000 },
      { agentType: "Explore", spawnDepth: 1, outputTokens: 500, at: 1000 },
    ]);
    store.close();
  });

  it("subagentUsageSummary groups by agent type ACROSS every owner, not just craft-<slug> (hands#103c)", () => {
    const store = open();
    // two stations dispatching the same craft — must aggregate together
    store.recordSubagentSample({ ownerAgentId: "station-1", agentType: "craft-saucier", spawnDepth: 1, outputTokens: 1000, now: 1000 });
    store.recordSubagentSample({ ownerAgentId: "station-2", agentType: "craft-saucier", spawnDepth: 1, outputTokens: 3000, now: 2000 });
    // a plain, non-craft dispatch — craftTokenUsage() (LIKE 'craft-%') would miss this entirely
    store.recordSubagentSample({ ownerAgentId: "station-1", agentType: "Explore", spawnDepth: 1, outputTokens: 500, now: 3000 });
    // untyped (no .meta.json sidecar) — must not be silently dropped
    store.recordSubagentSample({ ownerAgentId: "station-1", agentType: null, spawnDepth: null, outputTokens: 20, now: 4000 });

    expect(store.subagentUsageSummary()).toEqual([
      { agentType: "craft-saucier", calls: 2, totalOutputTokens: 4000, avgOutputTokens: 2000 },
      { agentType: "Explore", calls: 1, totalOutputTokens: 500, avgOutputTokens: 500 },
      { agentType: "(untyped)", calls: 1, totalOutputTokens: 20, avgOutputTokens: 20 },
    ]);
    store.close();
  });

  it("records wake outcomes and aggregates counts since a cutoff", () => {
    const store = open();
    store.recordWakeOutcome({ agentId: "station-1", messageId: 1, outcome: "fired", now: 1000 });
    store.recordWakeOutcome({ agentId: "station-1", messageId: 2, outcome: "suppressed", now: 2000 });
    store.recordWakeOutcome({ agentId: "station-1", messageId: 3, outcome: "coalesced", now: 3000 });
    store.recordWakeOutcome({ agentId: "station-1", messageId: 4, outcome: "fired", now: 4000 });
    // Before the cutoff — excluded.
    store.recordWakeOutcome({ agentId: "station-1", messageId: 0, outcome: "fired", now: 500 });

    expect(store.wakeOutcomeCounts("station-1", 999)).toEqual({ fired: 2, suppressed: 1, coalesced: 1, failed: 0 });
    store.close();
  });

  it("trims wake outcomes older than 24h on insert", () => {
    const store = open();
    const hour = 60 * 60_000;
    store.recordWakeOutcome({ agentId: "station-1", messageId: 1, outcome: "fired", now: 0 });
    store.recordWakeOutcome({ agentId: "station-1", messageId: 2, outcome: "fired", now: 25 * hour });
    expect(store.wakeOutcomeCounts("station-1", -1)).toEqual({ fired: 1, suppressed: 0, coalesced: 0, failed: 0 });
    store.close();
  });
});

describe("Store.recordSignoff / latestSignoff / signoffsForTask (hands#139/#91/#95)", () => {
  it("records a signoff and reads it back by task", () => {
    const store = open();
    const taskId = store.createTask({ createdBy: "expo", assignee: "station-1", title: "plan X" });
    const id = store.recordSignoff({
      taskId,
      checkpoint: "pre-fire",
      verdict: "approved",
      note: "board clean, no collisions",
      originSha: "abc123",
      by: "expo",
      now: 1000,
    });
    expect(id).toBeGreaterThan(0);

    const latest = store.latestSignoff(taskId);
    expect(latest).toMatchObject({
      task_id: taskId,
      checkpoint: "pre-fire",
      verdict: "approved",
      note: "board clean, no collisions",
      origin_sha: "abc123",
      by: "expo",
    });
    store.close();
  });

  it("latestSignoff returns the most recent across checkpoints, or scoped to one when asked", () => {
    const store = open();
    const taskId = store.createTask({ createdBy: "expo", assignee: "station-1", title: "plan X" });
    store.recordSignoff({ taskId, checkpoint: "pre-fire", verdict: "approved", by: "expo", now: 1000 });
    store.recordSignoff({ taskId, checkpoint: "pre-ship", verdict: "rejected", note: "collides with #42", by: "expo", now: 2000 });

    expect(store.latestSignoff(taskId)?.checkpoint).toBe("pre-ship"); // most recent overall
    expect(store.latestSignoff(taskId, "pre-fire")?.verdict).toBe("approved"); // scoped
    expect(store.latestSignoff(taskId, "pre-ship")?.verdict).toBe("rejected");
    store.close();
  });

  it("signoffsForTask returns the full history, oldest first", () => {
    const store = open();
    const taskId = store.createTask({ createdBy: "expo", assignee: "station-1", title: "plan X" });
    store.recordSignoff({ taskId, checkpoint: "pre-fire", verdict: "approved", by: "expo", now: 1000 });
    store.recordSignoff({ taskId, checkpoint: "pre-ship", verdict: "approved", by: "expo", now: 2000 });

    const history = store.signoffsForTask(taskId);
    expect(history.map((s) => s.checkpoint)).toEqual(["pre-fire", "pre-ship"]);
    store.close();
  });

  it("a task with no signoff yet returns undefined, not a default", () => {
    const store = open();
    const taskId = store.createTask({ createdBy: "expo", assignee: "station-1", title: "plan X" });
    expect(store.latestSignoff(taskId)).toBeUndefined();
    store.close();
  });
});

describe("Store.recordRoleNote / pendingRoleNotes / markRoleNotesFolded (hands#115)", () => {
  it("records a note and reads it back as pending", () => {
    const store = open();
    const id = store.recordRoleNote({ role: "expo", sourceAgent: "expo", text: "gates re-attest on every merge", now: 1000 });
    expect(id).toBeGreaterThan(0);
    const pending = store.pendingRoleNotes("expo");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ role: "expo", source_agent: "expo", text: "gates re-attest on every merge", folded_at: null });
    store.close();
  });

  it("is scoped per role — a different role's notes never leak into this one's pending list", () => {
    const store = open();
    store.recordRoleNote({ role: "expo", sourceAgent: "expo", text: "expo's own note", now: 1000 });
    store.recordRoleNote({ role: "sous", sourceAgent: "sous", text: "sous's own note", now: 1000 });
    expect(store.pendingRoleNotes("expo")).toHaveLength(1);
    expect(store.pendingRoleNotes("expo")[0]?.text).toBe("expo's own note");
    store.close();
  });

  it("markRoleNotesFolded through a cutoff clears exactly those, leaving later ones pending", () => {
    const store = open();
    const a = store.recordRoleNote({ role: "expo", sourceAgent: "expo", text: "first", now: 1000 });
    store.recordRoleNote({ role: "expo", sourceAgent: "expo", text: "second", now: 2000 });
    store.markRoleNotesFolded("expo", a);
    const pending = store.pendingRoleNotes("expo");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toBe("second");
    store.close();
  });

  it("folding is idempotent — re-marking an already-folded note through the same cutoff is a no-op, not an error", () => {
    const store = open();
    const a = store.recordRoleNote({ role: "expo", sourceAgent: "expo", text: "only note", now: 1000 });
    store.markRoleNotesFolded("expo", a);
    expect(() => store.markRoleNotesFolded("expo", a)).not.toThrow();
    expect(store.pendingRoleNotes("expo")).toHaveLength(0);
    store.close();
  });
});

describe("isSignoffStale (hands#139/#91/#95)", () => {
  it("is fresh when the origin sha matches what was captured at signoff time", () => {
    expect(isSignoffStale({ origin_sha: "abc" }, "abc")).toBe(false);
  });

  it("goes stale the moment origin/main moves past the captured sha", () => {
    expect(isSignoffStale({ origin_sha: "abc" }, "def")).toBe(true);
  });

  it("a new collision invalidates a signoff regardless of the sha", () => {
    expect(isSignoffStale({ origin_sha: "abc" }, "abc", true)).toBe(true);
  });

  it("is not stale-by-sha when either side has no sha to compare (nothing to invalidate against)", () => {
    expect(isSignoffStale({ origin_sha: null }, "abc")).toBe(false);
    expect(isSignoffStale({ origin_sha: "abc" }, null)).toBe(false);
  });
});
