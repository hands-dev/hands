import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;
let stores: Store[];
let cleanups: Array<() => Promise<void>>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-preship-"));
  env = { HANDS_HOME: home };
  process.env.HANDS_HOME = home;
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

/** currentOriginSha injected as "HEAD" throughout — deterministic, no real git repo needed (hands#111). */
async function connectExpo(currentOriginSha: string | null = "HEAD"): Promise<{ client: Client; store: Store }> {
  const store = new Store({ env });
  stores.push(store);
  store.registerAgent({ id: "expo", cwd: "/", pid: 1 });
  const server = buildServer(store, "expo", DEFAULT_CONFIG, { currentOriginSha: () => currentOriginSha });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, store };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

/**
 * hands#111/#139: `store.latestSignoff` used to be read in exactly one place
 * (hands_tasks, for display) and consulted nowhere that actually gates
 * shipping — the expo could mark any ticket `done` with no CDC pre-ship
 * sign-off at all, and nothing noticed. These prove the gate actually
 * refuses in every case it should, and actually proceeds in the ones it
 * shouldn't block — a gate demonstrated only against the happy path is the
 * same category of thing this ticket exists to replace.
 */
describe("hands_task_update('done') — the pre-ship CDC sign-off gate (hands#111/#139)", () => {
  it("REFUSES with no pre-ship sign-off at all, naming the ticket and the exact commands to fix it", async () => {
    const { client, store } = await connectExpo();
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 1000 });
    const res = await call(client, "hands_task_update", { id, state: "done" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain(`task #${id}`);
    expect(String(res.body.error)).toContain("no pre-ship CDC sign-off");
    expect(String(res.body.error)).toContain("hands craft brief cdc");
    expect(String(res.body.error)).toContain("hands_craft_signoff");
    expect(String(res.body.error)).toContain("skipSignoff"); // the escape hatch is named, not hidden
  });

  it("REFUSES when the latest pre-ship sign-off was REJECTED, surfacing CDC's own note", async () => {
    const { client, store } = await connectExpo();
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 1000 });
    store.recordSignoff({
      taskId: id,
      checkpoint: "pre-ship",
      verdict: "rejected",
      note: "collides with #42's rename",
      by: "expo",
      now: 2000,
    });
    const res = await call(client, "hands_task_update", { id, state: "done" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("REJECTED");
    expect(String(res.body.error)).toContain("collides with #42's rename");
  });

  it("REFUSES a STALE sign-off — origin/main moved past the sha CDC judged against", async () => {
    const { client, store } = await connectExpo("HEAD-NOW"); // current HEAD, injected
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 1000 });
    store.recordSignoff({
      taskId: id,
      checkpoint: "pre-ship",
      verdict: "approved",
      originSha: "HEAD-OLD", // stale relative to the injected current sha
      by: "expo",
      now: 2000,
    });
    const res = await call(client, "hands_task_update", { id, state: "done" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("stale");
    expect(String(res.body.error)).toContain("origin/main has moved");
  });

  it("REFUSES a STALE sign-off — a live collision now involves the ticket's own assignee", async () => {
    const { client, store } = await connectExpo("HEAD");
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 1000 });
    store.recordSignoff({ taskId: id, checkpoint: "pre-ship", verdict: "approved", originSha: "HEAD", by: "expo", now: 2000 });
    // Two ONLINE stations both touching the same file right now — the exact
    // shape hands_board's own collision strip already detects.
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    store.setStatus({ id: "station-1", cwd: "/", pid: 2, files: ["src/x.ts"] });
    store.registerAgent({ id: "station-2", cwd: "/", pid: 3 });
    store.setStatus({ id: "station-2", cwd: "/", pid: 3, files: ["src/x.ts"] });
    const res = await call(client, "hands_task_update", { id, state: "done" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("stale");
    expect(String(res.body.error)).toContain("collision now involves station-1");
  });

  it("PROCEEDS when the sign-off is fresh and approved", async () => {
    const { client, store } = await connectExpo("HEAD");
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 1000 });
    store.recordSignoff({ taskId: id, checkpoint: "pre-ship", verdict: "approved", originSha: "HEAD", by: "expo", now: 2000 });
    const res = await call(client, "hands_task_update", { id, state: "done" });
    expect(res.isError).toBe(false);
    expect(res.body.ok).toBe(true);
    expect(store.getTask(id)?.state).toBe("done");
  });

  it("PROCEEDS with no sign-off at all when skipSignoff names a reason — and records it, never silently", async () => {
    const { client, store } = await connectExpo();
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix a typo", now: 1000 });
    const res = await call(client, "hands_task_update", {
      id,
      state: "done",
      skipSignoff: "one-line typo fix, not worth a CDC dispatch",
    });
    expect(res.isError).toBe(false);
    expect(store.getTask(id)?.state).toBe("done");

    const journal = store.journalSince(0);
    const entry = journal.find((j) => j.text.includes(`task #${id}`) && j.text.includes("overridden"));
    expect(entry, "the override must land in the journal, not vanish silently").toBeDefined();
    expect(entry?.text).toContain("one-line typo fix, not worth a CDC dispatch");
    expect(entry?.agent_id).toBe("expo");
  });

  it("does NOT gate 'returned', 'in_progress', or 'cancelled' — only 'done' is the ship moment", async () => {
    const { client, store } = await connectExpo();
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 1000 });
    // No sign-off recorded anywhere, and none of these should even ask for one.
    expect((await call(client, "hands_task_update", { id, state: "in_progress" })).isError).toBe(false);
    expect((await call(client, "hands_task_update", { id, state: "returned", result: "done, see PR" })).isError).toBe(false);
    const id2 = store.createTask({ createdBy: "expo", assignee: "station-1", title: "dead ticket", now: 1000 });
    expect((await call(client, "hands_task_update", { id: id2, state: "cancelled" })).isError).toBe(false);
  });
});
