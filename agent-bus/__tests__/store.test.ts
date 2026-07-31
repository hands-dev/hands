import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ONLINE_WINDOW_MS, Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-test-"));
  env = { AGENT_BUS_HOME: home };
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
});

describe("Store persistence", () => {
  it("keeps history across a server restart (reopen on the same file)", () => {
    const first = open();
    first.insertMessage({ from: "wt1", to: "wt2", body: "durable" });
    first.close();

    const second = open(); // same AGENT_BUS_HOME → same db file
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

describe("Store security", () => {
  it("creates the db file with 0600 permissions", () => {
    const store = open();
    store.insertMessage({ from: "wt1", to: "wt2", body: "x" });
    const mode = fs.statSync(path.join(home, "agent-bus.db")).mode & 0o777;
    expect(mode).toBe(0o600);
    store.close();
  });
});
