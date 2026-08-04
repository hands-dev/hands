import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeStateHash } from "../src/board.js";
import { type YesChefConfig, DEFAULT_CONFIG } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;
let stores: Store[];
let cleanups: Array<() => Promise<void>>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "yes-chef-wake-"));
  env = { YES_CHEF_HOME: home };
  process.env.YES_CHEF_HOME = home; // notify() reads process.env
  stores = [];
  cleanups = [];
});

afterEach(async () => {
  for (const c of cleanups) await c();
  for (const s of stores) s.close();
  delete process.env.YES_CHEF_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function connect(agentId: string, config?: YesChefConfig): Promise<Client> {
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
    const res = await call(w1, "yc_send", {
      to: "expo",
      body: "parked X, moving on",
      wake: false,
    });
    expect(res.isError).toBe(false);
    expect(res.body.woken).toEqual([]);
    expect(notifyLines("expo")).toHaveLength(0);

    const expo = await connect("expo");
    const drained = await call(expo, "yc_receive", { wait_seconds: 0 });
    expect(drained.body.count).toBe(1);
    expect((drained.body.messages as Array<{ body: string }>)[0]!.body).toBe("parked X, moving on");
  });
});

describe("redundant-wake suppression", () => {
  it("a burst to an undrained recipient appends exactly ONE notify line; one drain returns all", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "yc_send", { to: "station-1", body: "first" });
    await call(expo, "yc_send", { to: "station-1", body: "second" });
    const third = await call(expo, "yc_send", { to: "station-1", body: "third" });
    expect(third.body.woken).toEqual([]); // suppressed — wake already pending
    expect(notifyLines("station-1")).toHaveLength(1);

    const w1 = await connect("station-1");
    const drained = await call(w1, "yc_receive", { wait_seconds: 0 });
    expect(drained.body.count).toBe(3);
  });

  it("wakes again after the recipient drains", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "yc_send", { to: "station-1", body: "first" });
    const w1 = await connect("station-1");
    await call(w1, "yc_receive", { wait_seconds: 0 }); // drains + advances cursor
    await call(expo, "yc_send", { to: "station-1", body: "second" });
    expect(notifyLines("station-1")).toHaveLength(2);
  });

  it("a broadcast only wakes peers who are fully drained", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    store.registerAgent({ id: "station-2", cwd: "/", pid: 3 });
    await call(expo, "yc_send", { to: "station-1", body: "just for you" });
    const bc = await call(expo, "yc_send", { to: "*", body: "all hands" });
    // station-1 is behind (undrained DM) → suppressed; station-2 gets the wake
    expect(bc.body.woken).toEqual(["station-2"]);
    expect(notifyLines("station-1")).toHaveLength(1);
    expect(notifyLines("station-2")).toHaveLength(1);
  });
});

describe("board stateHash + full bundle", () => {
  it("is stable when nothing changes and moves when assignments change", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const a = await call(expo, "yc_board", {});
    const b = await call(expo, "yc_board", {});
    expect(a.body.stateHash).toBeTruthy();
    expect(a.body.stateHash).toBe(b.body.stateHash);
    await call(expo, "yc_delegate", { title: "plan X", to: "station-1" });
    const c = await call(expo, "yc_board", {});
    expect(c.body.stateHash).not.toBe(a.body.stateHash);
  });

  it("full:true bundles tasks + questions + priorities into one read", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "yc_delegate", { title: "plan X", to: "station-1" });
    store.askQuestion({ asker: "station-1", question: "ship it?" });
    const res = await call(expo, "yc_board", { full: true });
    const tasks = res.body.activeTasks as Array<{ title: string; assignee: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.assignee).toBe("station-1");
    const questions = res.body.openQuestions as Array<{ question: string }>;
    expect(questions.map((q) => q.question)).toContain("ship it?");
    expect(res.body.priorities).toMatchObject({ set: false });
    const plain = await call(expo, "yc_board", {});
    expect(plain.body.activeTasks).toBeUndefined();
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
    await call(expo, "yc_send", { to: "station-1", body: "fyi 1", wake: false });
    await call(expo, "yc_send", { to: "station-1", body: "fyi 2", wake: false });
    expect(store.wakeCounts().get("station-1")).toBeUndefined();

    // a 3-message burst → exactly 1 wake (suppression collapses the rest)
    await call(expo, "yc_send", { to: "station-1", body: "real 1" });
    await call(expo, "yc_send", { to: "station-1", body: "real 2" });
    await call(expo, "yc_send", { to: "station-1", body: "real 3" });
    expect(store.wakeCounts().get("station-1")).toMatchObject({ lastHour: 1, last24h: 1 });

    // drain, then another waking send → 2 total
    const w1 = await connect("station-1");
    await call(w1, "yc_receive", { wait_seconds: 0 });
    await call(expo, "yc_send", { to: "station-1", body: "again" });
    expect(store.wakeCounts().get("station-1")).toMatchObject({ lastHour: 2, last24h: 2 });
  });

  it("surfaces wakesLastHour on the board and counts delegation wakes", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "yc_delegate", { title: "plan X", to: "station-1" });
    const board = await call(expo, "yc_board", {});
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
