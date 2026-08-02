import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentBusConfig, DEFAULT_CONFIG } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;
let stores: Store[];
let cleanups: Array<() => Promise<void>>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-topo-"));
  env = { AGENT_BUS_HOME: home };
  process.env.AGENT_BUS_HOME = home; // notify() reads process.env
  stores = [];
  cleanups = [];
});

afterEach(async () => {
  for (const c of cleanups) await c();
  for (const s of stores) s.close();
  delete process.env.AGENT_BUS_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function connect(agentId: string, config?: AgentBusConfig): Promise<Client> {
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
  it("rejects worker→worker sends with guidance and writes NO notify line", async () => {
    const w1 = await connect("worker-1");
    const res = await call(w1, "agent_bus_send", { to: "worker-2", body: "psst" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("Route via the foreman");
    expect(notifyLines("worker-2")).toHaveLength(0);
    // and nothing landed in the DB either
    expect(stores[0]!.history({ limit: 10 })).toHaveLength(0);
  });

  it("rejects worker broadcasts", async () => {
    const w1 = await connect("worker-1");
    const res = await call(w1, "agent_bus_send", { to: "*", body: "hi all" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("Only the foreman may broadcast");
    expect(notifyLines("foreman")).toHaveLength(0);
  });

  it("allows worker→foreman and worker→principal", async () => {
    const w1 = await connect("worker-1");
    const toForeman = await call(w1, "agent_bus_send", { to: "foreman", body: "done" });
    expect(toForeman.isError).toBe(false);
    expect(notifyLines("foreman")).toHaveLength(1);
    const toHuman = await call(w1, "agent_bus_send", { to: "Michael", body: "fyi" });
    expect(toHuman.isError).toBe(false);
  });

  it("lets the foreman broadcast and address any worker", async () => {
    const foreman = await connect("foreman");
    stores[0]!.registerAgent({ id: "worker-1", cwd: "/", pid: 2 });
    stores[0]!.registerAgent({ id: "worker-2", cwd: "/", pid: 3 });
    const dm = await call(foreman, "agent_bus_send", { to: "worker-2", body: "do X" });
    expect(dm.isError).toBe(false);
    const bc = await call(foreman, "agent_bus_send", { to: "*", body: "all hands" });
    expect(bc.isError).toBe(false);
    expect(notifyLines("worker-1").length).toBeGreaterThan(0);
  });

  it("rejects worker delegation (foreman-only under strict-hub)", async () => {
    const w1 = await connect("worker-1");
    const res = await call(w1, "agent_bus_delegate", { title: "do my chores", to: "worker-2" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("the foreman delegates");
    expect(stores[0]!.listTasks()).toHaveLength(0);
  });

  it("still lets a worker return/claim its own tasks", async () => {
    const foreman = await connect("foreman");
    await call(foreman, "agent_bus_delegate", { title: "plan X", to: "worker-1" });
    const w1 = await connect("worker-1", DEFAULT_CONFIG);
    const start = await call(w1, "agent_bus_task_update", { id: 1, state: "in_progress" });
    expect(start.isError).toBe(false);
    const ret = await call(w1, "agent_bus_task_update", { id: 1, state: "returned", result: "plan" });
    expect(ret.isError).toBe(false);
  });
});

describe("open topology (opt-out)", () => {
  const open: AgentBusConfig = { ...DEFAULT_CONFIG, topology: "open" };

  it("restores worker↔worker sends and worker broadcasts", async () => {
    const w1 = await connect("worker-1", open);
    stores[0]!.registerAgent({ id: "worker-2", cwd: "/", pid: 2 });
    const dm = await call(w1, "agent_bus_send", { to: "worker-2", body: "psst" });
    expect(dm.isError).toBe(false);
    expect(notifyLines("worker-2").length).toBeGreaterThan(0);
    const bc = await call(w1, "agent_bus_send", { to: "*", body: "hi" });
    expect(bc.isError).toBe(false);
    const del = await call(w1, "agent_bus_delegate", { title: "task", to: "worker-2" });
    expect(del.isError).toBe(false);
  });
});
