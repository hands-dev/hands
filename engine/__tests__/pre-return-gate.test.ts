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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-prereturn-"));
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

/** currentOriginSha injected as "HEAD" throughout — deterministic, no real git repo needed (hands#111/#112). */
async function connect(
  id: string,
  currentOriginSha: string | null = "HEAD",
): Promise<{ client: Client; store: Store }> {
  const store = new Store({ env });
  stores.push(store);
  store.registerAgent({ id, cwd: "/", pid: 1 });
  const server = buildServer(store, id, DEFAULT_CONFIG, { currentOriginSha: () => currentOriginSha });
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
 * hands#112: the pre-return gate — a station may not return a ticket
 * without a fresh, approved CDC pre-return sign-off for THAT ticket.
 * Mirrors pre-ship-gate.test.ts exactly (same isSignoffStale detector, same
 * refusal shape, same skipSignoff escape hatch) — deliberately, since it's
 * the same mechanism at a different checkpoint, not a new one.
 */
describe("hands_task_update('returned') — the pre-return CDC sign-off gate (hands#112)", () => {
  it("REFUSES with no pre-return sign-off at all, naming the ticket and the exact commands to fix it", async () => {
    const { client, store } = await connect("station-1");
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 1000 });
    await call(client, "hands_task_update", { id, state: "in_progress" });
    const res = await call(client, "hands_task_update", { id, state: "returned", result: "done, see PR" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain(`task #${id}`);
    expect(String(res.body.error)).toContain("no pre-return CDC sign-off");
    expect(String(res.body.error)).toContain("hands craft brief cdc");
    expect(String(res.body.error)).toContain("hands_craft_signoff");
    expect(String(res.body.error)).toContain("skipSignoff"); // the escape hatch is named, not hidden
  });

  it("REFUSES when the latest pre-return sign-off was REJECTED, surfacing CDC's own note", async () => {
    const { client, store } = await connect("station-1");
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 1000 });
    store.recordSignoff({
      taskId: id,
      checkpoint: "pre-return",
      verdict: "rejected",
      note: "still collides with #42's rename",
      by: "station-1",
      now: 2000,
    });
    const res = await call(client, "hands_task_update", { id, state: "returned", result: "done, see PR" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("REJECTED");
    expect(String(res.body.error)).toContain("still collides with #42's rename");
  });

  it("REFUSES a STALE sign-off — origin/main moved past the sha CDC judged against", async () => {
    const { client, store } = await connect("station-1", "HEAD-NOW");
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 1000 });
    store.recordSignoff({
      taskId: id,
      checkpoint: "pre-return",
      verdict: "approved",
      originSha: "HEAD-OLD",
      by: "station-1",
      now: 2000,
    });
    const res = await call(client, "hands_task_update", { id, state: "returned", result: "done, see PR" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("stale");
    expect(String(res.body.error)).toContain("origin/main has moved");
  });

  it("REFUSES a STALE sign-off — a live collision now involves the ticket's own assignee", async () => {
    const { client, store } = await connect("station-1", "HEAD");
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 1000 });
    store.recordSignoff({ taskId: id, checkpoint: "pre-return", verdict: "approved", originSha: "HEAD", by: "station-1", now: 2000 });
    store.registerAgent({ id: "station-2", cwd: "/", pid: 3 });
    store.setStatus({ id: "station-1", cwd: "/", pid: 1, files: ["src/x.ts"] });
    store.setStatus({ id: "station-2", cwd: "/", pid: 3, files: ["src/x.ts"] });
    const res = await call(client, "hands_task_update", { id, state: "returned", result: "done, see PR" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("stale");
    expect(String(res.body.error)).toContain("collision now involves station-1");
  });

  it("PROCEEDS when the sign-off is fresh and approved", async () => {
    const { client, store } = await connect("station-1", "HEAD");
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 1000 });
    store.recordSignoff({ taskId: id, checkpoint: "pre-return", verdict: "approved", originSha: "HEAD", by: "station-1", now: 2000 });
    const res = await call(client, "hands_task_update", { id, state: "returned", result: "done, see PR" });
    expect(res.isError).toBe(false);
    expect(store.getTask(id)?.state).toBe("returned");
  });

  it("PROCEEDS with no sign-off at all when skipSignoff names a reason — and records it, never silently", async () => {
    const { client, store } = await connect("station-1");
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix a typo", now: 1000 });
    const res = await call(client, "hands_task_update", {
      id,
      state: "returned",
      result: "one-liner",
      skipSignoff: "one-line typo fix, not worth a CDC dispatch",
    });
    expect(res.isError).toBe(false);
    expect(store.getTask(id)?.state).toBe("returned");

    const journal = store.journalSince(0);
    const entry = journal.find((j) => j.text.includes(`task #${id}`) && j.text.includes("overridden"));
    expect(entry, "the override must land in the journal, not vanish silently").toBeDefined();
    expect(entry?.text).toContain("pre-return");
    expect(entry?.text).toContain("one-line typo fix, not worth a CDC dispatch");
    expect(entry?.agent_id).toBe("station-1");
  });

  it("a pre-SHIP sign-off does not satisfy the pre-RETURN gate — the checkpoints are distinct, not interchangeable", async () => {
    const { client, store } = await connect("station-1", "HEAD");
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 1000 });
    store.recordSignoff({ taskId: id, checkpoint: "pre-ship", verdict: "approved", originSha: "HEAD", by: "expo", now: 2000 });
    const res = await call(client, "hands_task_update", { id, state: "returned", result: "done, see PR" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("no pre-return CDC sign-off");
  });
});
