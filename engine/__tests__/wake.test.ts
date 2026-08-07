import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeStateHash } from "../src/board.js";
import { type HandsConfig, DEFAULT_CONFIG } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;
let stores: Store[];
let cleanups: Array<() => Promise<void>>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-wake-"));
  env = { HANDS_HOME: home };
  process.env.HANDS_HOME = home; // notify() reads process.env
  // currentUsageMode() (hands_board's usageMode field) also reads ambient process.env/cwd
  // directly, same as notify() above — isolate it from this checkout's own real
  // hands.config.json (HANDS_NO_REPO_CONFIG) and point its user-layer read at `home`.
  process.env.HANDS_TEST_HOME = home;
  process.env.HANDS_NO_REPO_CONFIG = "1";
  stores = [];
  cleanups = [];
});

afterEach(async () => {
  for (const c of cleanups) await c();
  for (const s of stores) s.close();
  delete process.env.HANDS_HOME;
  delete process.env.HANDS_TEST_HOME;
  delete process.env.HANDS_NO_REPO_CONFIG;
  fs.rmSync(home, { recursive: true, force: true });
});

async function connect(agentId: string, config?: HandsConfig): Promise<Client> {
  const store = new Store({ env });
  stores.push(store);
  store.registerAgent({ id: agentId, cwd: "/", pid: 1 });
  const server = buildServer(store, agentId, config ?? DEFAULT_CONFIG);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function notifyLines(agentId: string): string[] {
  try {
    return fs
      .readFileSync(path.join(home, `${agentId}.notify`), "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

describe("wake:false (non-waking FYI)", () => {
  it("stores the message and delivers on drain, but never touches .notify", async () => {
    const w1 = await connect("station-1");
    const res = await call(w1, "hands_send", {
      to: "expo",
      body: "parked X, moving on",
      wake: false,
    });
    expect(res.isError).toBe(false);
    expect(res.body.woken).toEqual([]);
    expect(notifyLines("expo")).toHaveLength(0);

    const expo = await connect("expo");
    const drained = await call(expo, "hands_receive", { wait_seconds: 0 });
    expect(drained.body.count).toBe(1);
    expect((drained.body.messages as Array<{ body: string }>)[0]!.body).toBe("parked X, moving on");
  });
});

describe("redundant-wake suppression", () => {
  it("a burst to an undrained recipient appends exactly ONE notify line; one drain returns all", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_send", { to: "station-1", body: "first" });
    await call(expo, "hands_send", { to: "station-1", body: "second" });
    const third = await call(expo, "hands_send", { to: "station-1", body: "third" });
    expect(third.body.woken).toEqual([]); // suppressed — wake already pending
    expect(notifyLines("station-1")).toHaveLength(1);

    const w1 = await connect("station-1");
    const drained = await call(w1, "hands_receive", { wait_seconds: 0 });
    expect(drained.body.count).toBe(3);
  });

  it("wakes again after the recipient drains", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_send", { to: "station-1", body: "first" });
    const w1 = await connect("station-1");
    await call(w1, "hands_receive", { wait_seconds: 0 }); // drains + advances cursor
    await call(expo, "hands_send", { to: "station-1", body: "second" });
    expect(notifyLines("station-1")).toHaveLength(2);
  });

  it("a broadcast only wakes peers who are fully drained", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    store.registerAgent({ id: "station-2", cwd: "/", pid: 3 });
    await call(expo, "hands_send", { to: "station-1", body: "just for you" });
    const bc = await call(expo, "hands_send", { to: "*", body: "all hands" });
    // station-1 is behind (undrained DM) → suppressed; station-2 gets the wake
    expect(bc.body.woken).toEqual(["station-2"]);
    expect(notifyLines("station-1")).toHaveLength(1);
    expect(notifyLines("station-2")).toHaveLength(1);
  });
});

/** A pid guaranteed dead: spawnSync blocks until the child exits, so by the time it returns the pid is reaped. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid!;
}

describe("silent-failure surfacing (hands#173, hands#183)", () => {
  it("distinguishes woken from coalesced in the response, instead of both reading as empty `woken`", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_send", { to: "station-1", body: "first" });
    const second = await call(expo, "hands_send", { to: "station-1", body: "second" });
    expect(second.body.woken).toEqual([]);
    expect(second.body.coalesced).toEqual(["station-1"]); // NOT a failure — legitimately behind
  });

  it("reports a real .notify write failure in notifyFailed, and does not permanently wedge the recipient", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    // A directory at the exact notify path forces the write to throw (EISDIR) —
    // deterministic reproduction of "the append attempt itself failed".
    fs.mkdirSync(path.join(home, "station-1.notify"));

    const first = await call(expo, "hands_send", { to: "station-1", body: "hello" });
    expect(first.isError).toBe(false); // the DB row still lands — only the nudge failed
    expect(first.body.woken).toEqual([]);
    expect(first.body.notifyFailed).toEqual(["station-1"]);

    // Unlike the old behavior (a swallowed failure still set wake_pending),
    // a failed write must not coalesce the next attempt — that would wedge
    // this recipient's wakes forever with no way to self-heal.
    fs.rmSync(path.join(home, "station-1.notify"), { recursive: true });
    const retry = await call(expo, "hands_send", { to: "station-1", body: "hello again" });
    expect(retry.body.woken).toEqual(["station-1"]);
    expect(retry.body.notifyFailed).toEqual([]);
  });

  it("warns on hands_send when the resolved recipient's pid is confirmed dead (hands#183)", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: deadPid() });
    const res = await call(expo, "hands_send", { to: "station-1", body: "hello" });
    expect(res.isError).toBe(false); // still delivered — reversible, not blocked
    expect(res.body.warning).toContain("station-1");
  });

  it("warns on hands_delegate when the assignee's pid is confirmed dead, but still creates the ticket", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: deadPid() });
    const res = await call(expo, "hands_delegate", { title: "plan X", to: "station-1" });
    expect(res.body.ok).toBe(true);
    expect(res.body.assignedTo).toBe("station-1");
    expect(res.body.warning).toContain("station-1");
  });

  it("a healthy assignee (real pid) gets no warning", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: process.pid });
    const res = await call(expo, "hands_delegate", { title: "plan X", to: "station-1" });
    expect(res.body.warning).toBeUndefined();
  });

  it("hands_peers and hands_board surface `alive` distinctly from `online` for a dead-pid peer", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: deadPid() });

    const peers = await call(expo, "hands_peers", {});
    const p = (peers.body.peers as Array<{ id: string; online: boolean; alive: boolean }>).find(
      (x) => x.id === "station-1",
    );
    // Still within the 15-minute heartbeat window (just registered) — online
    // alone would say "fine". alive is what actually caught the dead process.
    expect(p).toMatchObject({ online: true, alive: false });

    const board = await call(expo, "hands_board", {});
    const b = (board.body.peers as Array<{ id: string; alive: boolean }>).find((x) => x.id === "station-1");
    expect(b?.alive).toBe(false);
  });
});

describe("board stateHash + full bundle", () => {
  it("is stable when nothing changes and moves when assignments change", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const a = await call(expo, "hands_board", {});
    const b = await call(expo, "hands_board", {});
    expect(a.body.stateHash).toBeTruthy();
    expect(a.body.stateHash).toBe(b.body.stateHash);
    await call(expo, "hands_delegate", { title: "plan X", to: "station-1" });
    const c = await call(expo, "hands_board", {});
    expect(c.body.stateHash).not.toBe(a.body.stateHash);
  });

  it("full:true bundles tasks + questions + priorities into one read", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_delegate", { title: "plan X", to: "station-1" });
    store.askQuestion({ asker: "station-1", question: "ship it?" });
    const res = await call(expo, "hands_board", { full: true });
    const tasks = res.body.activeTasks as Array<{ title: string; assignee: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.assignee).toBe("station-1");
    const questions = res.body.openQuestions as Array<{ question: string }>;
    expect(questions.map((q) => q.question)).toContain("ship it?");
    expect(res.body.priorities).toMatchObject({ set: false });
    const plain = await call(expo, "hands_board", {});
    expect(plain.body.activeTasks).toBeUndefined();
  });

  it("carries the current usageMode, freshly read every call — not frozen at connect time", async () => {
    const expo = await connect("expo");
    expect((await call(expo, "hands_board", {})).body.usageMode).toBe("normal");

    // Flip it AFTER the server/connection already exists — this is the whole point of
    // currentUsageMode() being uncached: a long-lived MCP connection must still see it.
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "hands.config.json"), JSON.stringify({ usage: { mode: "low" } }));
    expect((await call(expo, "hands_board", {})).body.usageMode).toBe("low");
  });

  it("computeStateHash is directly stable for a fixed now", () => {
    const store = new Store({ env });
    stores.push(store);
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2, now: 1000 });
    const now = 5000;
    expect(computeStateHash(store, now)).toBe(computeStateHash(store, now));
  });
});

describe("wake accounting (wake_log)", () => {
  it("counts real wakes only — not wake:false, not suppressed bursts", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });

    // 2 FYIs → zero wakes recorded
    await call(expo, "hands_send", { to: "station-1", body: "fyi 1", wake: false });
    await call(expo, "hands_send", { to: "station-1", body: "fyi 2", wake: false });
    expect(store.wakeCounts().get("station-1")).toBeUndefined();

    // a 3-message burst → exactly 1 wake (suppression collapses the rest)
    await call(expo, "hands_send", { to: "station-1", body: "real 1" });
    await call(expo, "hands_send", { to: "station-1", body: "real 2" });
    await call(expo, "hands_send", { to: "station-1", body: "real 3" });
    expect(store.wakeCounts().get("station-1")).toMatchObject({ lastHour: 1, last24h: 1 });

    // drain, then another waking send → 2 total
    const w1 = await connect("station-1");
    await call(w1, "hands_receive", { wait_seconds: 0 });
    await call(expo, "hands_send", { to: "station-1", body: "again" });
    expect(store.wakeCounts().get("station-1")).toMatchObject({ lastHour: 2, last24h: 2 });
  });

  it("surfaces wakesLastHour on the board and counts delegation wakes", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_delegate", { title: "plan X", to: "station-1" });
    const board = await call(expo, "hands_board", {});
    const w1 = (board.body.peers as Array<{ id: string; wakesLastHour: number }>).find(
      (p) => p.id === "station-1",
    );
    expect(w1?.wakesLastHour).toBe(1);
  });

  it("prunes wake_log rows older than 24h", () => {
    const store = new Store({ env });
    stores.push(store);
    const now = Date.now();
    store.recordWakes(["station-1"], now - 25 * 60 * 60_000);
    store.recordWakes(["station-1"], now); // triggers the opportunistic prune
    expect(store.wakeCounts(now).get("station-1")).toMatchObject({ lastHour: 1, last24h: 1 });
  });
});

describe("message ack/turnaround (dashboard chat-bubble checkmark)", () => {
  it("a real hands_receive drain (mark_read: true, the default) acks every directed message in the batch", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_send", { to: "station-1", body: "pick up ENG-42" });

    const w1 = await connect("station-1");
    await call(w1, "hands_receive", { wait_seconds: 0 });

    const [msg] = store.history({ peer: "station-1", limit: 1 });
    expect(msg?.acked_at).not.toBeNull();
  });

  it("a peek (mark_read: false) never acks", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_send", { to: "station-1", body: "pick up ENG-42" });

    const w1 = await connect("station-1");
    await call(w1, "hands_receive", { wait_seconds: 0, mark_read: false });

    const [msg] = store.history({ peer: "station-1", limit: 1 });
    expect(msg?.acked_at).toBeNull();
  });

  it("a broadcast is never acked, even once every peer has drained it", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_send", { to: "*", body: "stand down" });

    const w1 = await connect("station-1");
    await call(w1, "hands_receive", { wait_seconds: 0 });

    const [msg] = store.history({ limit: 1 });
    expect(msg?.to_id).toBeNull();
    expect(msg?.acked_at).toBeNull();
  });

  it("Store.ackMessages: first-drain wins, and a message to a different agent is never touched", () => {
    const store = new Store({ env });
    stores.push(store);
    const mine = store.insertMessage({ from: "expo", to: "station-1", body: "for station-1" });
    const theirs = store.insertMessage({ from: "expo", to: "station-2", body: "for station-2" });

    store.ackMessages("station-1", [mine, theirs], 1000);
    expect(store.history({ limit: 10 }).find((m) => m.id === mine)?.acked_at).toBe(1000);
    expect(store.history({ limit: 10 }).find((m) => m.id === theirs)?.acked_at).toBeNull();

    store.ackMessages("station-1", [mine], 2000); // a later "re-drain" must not push the time later
    expect(store.history({ limit: 10 }).find((m) => m.id === mine)?.acked_at).toBe(1000);
  });
});
