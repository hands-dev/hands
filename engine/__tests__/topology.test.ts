import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HandsConfig, DEFAULT_CONFIG } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;
let stores: Store[];
let cleanups: Array<() => Promise<void>>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-topo-"));
  env = { HANDS_HOME: home };
  process.env.HANDS_HOME = home; // notify() reads process.env
  stores = [];
  cleanups = [];
  // hands#116 — hands_delegate now hard-requires an on-menu recipe.
  fs.mkdirSync(path.join(home, "recipes"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "recipes", "test-recipe.md"),
    "# Test recipe\n> state: menu · rank: 1\n\n## Acceptance criteria\n- [ ] it works\n",
  );
});

afterEach(async () => {
  for (const c of cleanups) await c();
  for (const s of stores) s.close();
  delete process.env.HANDS_HOME;
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

describe("strict-hub topology (server-enforced)", () => {
  it("rejects station→station sends with guidance and writes NO notify line", async () => {
    const w1 = await connect("station-1");
    const res = await call(w1, "hands_send", { to: "station-2", body: "psst" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("Route via the expo");
    expect(notifyLines("station-2")).toHaveLength(0);
    // and nothing landed in the DB either
    expect(stores[0]!.history({ limit: 10 })).toHaveLength(0);
  });

  it("rejects station broadcasts", async () => {
    const w1 = await connect("station-1");
    const res = await call(w1, "hands_send", { to: "*", body: "hi all" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("Only the expo may broadcast");
    expect(notifyLines("expo")).toHaveLength(0);
  });

  it("allows station→expo and station→principal", async () => {
    const w1 = await connect("station-1");
    const toExpo = await call(w1, "hands_send", { to: "expo", body: "done" });
    expect(toExpo.isError).toBe(false);
    expect(notifyLines("expo")).toHaveLength(1);
    const toHuman = await call(w1, "hands_send", { to: "Michael", body: "fyi" });
    expect(toHuman.isError).toBe(false);
  });

  it("lets the expo broadcast and address any station", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    stores[0]!.registerAgent({ id: "station-2", cwd: "/", pid: 3 });
    const dm = await call(expo, "hands_send", { to: "station-2", body: "do X" });
    expect(dm.isError).toBe(false);
    const bc = await call(expo, "hands_send", { to: "*", body: "all hands" });
    expect(bc.isError).toBe(false);
    expect(notifyLines("station-1").length).toBeGreaterThan(0);
  });

  it("rejects station delegation (expo-only under strict-hub)", async () => {
    const w1 = await connect("station-1");
    const res = await call(w1, "hands_delegate", { title: "do my chores", to: "station-2" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("the expo delegates");
    expect(stores[0]!.listTasks()).toHaveLength(0);
  });

  it("still lets a station return/claim its own tasks", async () => {
    const expo = await connect("expo");
    await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    const w1 = await connect("station-1", DEFAULT_CONFIG);
    const start = await call(w1, "hands_task_update", { id: 1, state: "in_progress" });
    expect(start.isError).toBe(false);
    // skipSignoff sidesteps the unrelated hands#112 pre-return CDC gate —
    // this test is about topology permission, not signoff gating (see
    // pre-return-gate.test.ts for that).
    const ret = await call(w1, "hands_task_update", {
      id: 1,
      state: "returned",
      result: "plan",
      skipSignoff: "topology test, not exercising the CDC gate",
    });
    expect(ret.isError).toBe(false);
  });

  it("hands_task_update surfaces a clear error when a station tries to reclaim a cancelled ticket (hands#97)", async () => {
    const expo = await connect("expo");
    await call(expo, "hands_delegate", { title: "plan Y", to: "station-1", recipeSlug: "test-recipe" });
    const cancel = await call(expo, "hands_task_update", { id: 1, state: "cancelled" });
    expect(cancel.isError).toBe(false);

    const w1 = await connect("station-1", DEFAULT_CONFIG);
    const resurrect = await call(w1, "hands_task_update", { id: 1, state: "in_progress" });
    expect(resurrect.isError).toBe(true);
    expect(String(resurrect.body.error)).toContain("cancelled");
    expect(stores[0]!.getTask(1)!.state).toBe("cancelled");
  });
});

describe("open topology (opt-out)", () => {
  const open: HandsConfig = { ...DEFAULT_CONFIG, topology: "open" };

  it("restores station↔station sends and station broadcasts", async () => {
    const w1 = await connect("station-1", open);
    stores[0]!.registerAgent({ id: "station-2", cwd: "/", pid: 2 });
    const dm = await call(w1, "hands_send", { to: "station-2", body: "psst" });
    expect(dm.isError).toBe(false);
    expect(notifyLines("station-2").length).toBeGreaterThan(0);
    const bc = await call(w1, "hands_send", { to: "*", body: "hi" });
    expect(bc.isError).toBe(false);
    // hands#171/#87 phase a: assignment is expo-exclusive UNCONDITIONALLY —
    // "open" topology restores station-to-station messaging, not delegation.
    const del = await call(w1, "hands_delegate", { title: "task", to: "station-2" });
    expect(del.isError).toBe(true);
    expect(String(del.body.error)).toContain("Only the expo may assign");
  });
});

describe("paths + gh-poll tools", () => {
  it("hands_paths is available to every agent and reports identity", async () => {
    const w1 = await connect("station-1");
    const res = await call(w1, "hands_paths", {});
    expect(res.isError).toBe(false);
    expect(res.body.agentId).toBe("station-1");
    expect(res.body.journalSync).toBe("disabled"); // no remote configured
    expect(String(res.body.notify)).toContain("station-1.notify");
  });

  it("hands_gh_poll registers for the expo only", async () => {
    const expo = await connect("expo");
    const w1 = await connect("station-1");
    const expoTools = (await expo.listTools()).tools.map((t) => t.name);
    const stationTools = (await w1.listTools()).tools.map((t) => t.name);
    expect(expoTools).toContain("hands_gh_poll");
    expect(stationTools).not.toContain("hands_gh_poll");
    expect(stationTools).toContain("hands_paths");
  });
});

describe("focus labels", () => {
  it("a station sets its own focus; only the expo sets others'", async () => {
    const w1 = await connect("station-1");
    const own = await call(w1, "hands_focus", { focus: "developer API" });
    expect(own.isError).toBe(false);
    const other = await call(w1, "hands_focus", { station: "station-2", focus: "billing" });
    expect(other.isError).toBe(true);
    const expo = await connect("expo");
    const assigned = await call(expo, "hands_focus", { station: "station-2", focus: "billing" });
    expect(assigned.isError).toBe(false);
    const peers = await call(expo, "hands_peers", {});
    const byId = Object.fromEntries((peers.body.peers as Array<{ id: string; focus?: string }>).map((p) => [p.id, p.focus]));
    expect(byId["station-1"]).toBe("developer API");
    expect(byId["station-2"]).toBe("billing");
  });

  it("send resolves a unique focus label to its station; ambiguity errors", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    stores[0]!.registerAgent({ id: "station-2", cwd: "/", pid: 3 });
    stores[0]!.setFocus("station-2", "developer API");
    const byLabel = await call(expo, "hands_send", { to: "developer API", body: "rotate keys" });
    expect(byLabel.isError).toBe(false);
    expect(byLabel.body.to).toBe("station-2");
    expect(notifyLines("station-2")).toHaveLength(1);

    stores[0]!.setFocus("station-1", "developer API");
    const ambiguous = await call(expo, "hands_send", { to: "developer API", body: "x" });
    expect(ambiguous.isError).toBe(true);
    expect(String(ambiguous.body.error)).toContain("ambiguous");
  });

  it("focus journals as focus.set and replays into a fresh store", async () => {
    const store = stores[0] ?? new Store({ env });
    if (!stores.includes(store)) stores.push(store);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    store.setJournal((type, data) => events.push({ type, data }));
    store.setFocus("station-3", "infra");
    expect(events).toEqual([{ type: "focus.set", data: expect.objectContaining({ station: "station-3", focus: "infra" }) }]);
    const fresh = new Store({ env, path: ":memory:" });
    expect(fresh.applyEvent("focus.set", events[0]!.data)).toBe(true);
    expect(fresh.listPeers().find((p) => p.id === "station-3")?.focus).toBe("infra");
    fresh.close();
  });
});
