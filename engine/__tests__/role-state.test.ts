import { execFileSync } from "node:child_process";
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
let root: string;
let env: NodeJS.ProcessEnv;
let stores: Store[];
let cleanups: Array<() => Promise<void>>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hands-role-state-"));
  home = path.join(root, "coord");
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
  fs.rmSync(root, { recursive: true, force: true });
});

/** A real bare git repo standing in for the books remote — hands_role_note refuses without one configured. */
function bareRemote(): string {
  const dir = path.join(root, "books-remote");
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
  return dir;
}

async function connect(agentId: string, config: HandsConfig): Promise<Client> {
  const store = new Store({ env });
  stores.push(store);
  store.registerAgent({ id: agentId, cwd: "/", pid: 1 });
  const server = buildServer(store, agentId, config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

describe("hands_role_note / hands_role_state / hands_role_fold_done (hands#115)", () => {
  it("a station never even sees these tools — expo-only, conditionally registered", async () => {
    const station = await connect("station-1", DEFAULT_CONFIG);
    // Not a normal tool-result error — the tool was never registered for
    // this agent, so the SDK rejects the call with a protocol-level "MCP
    // error" (an unknown-tool message), not a JSON {ok:false} payload.
    const res = await station.callTool({ name: "hands_role_note", arguments: { text: "should not work" } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(res.isError).toBe(true);
    expect(text).toMatch(/unknown tool|not found/i);
  });

  it("refuses to ingest without remote journaling configured — same bar as hands_digest_note", async () => {
    const expo = await connect("expo", DEFAULT_CONFIG); // remote.url is null
    const res = await call(expo, "hands_role_note", { text: "gates re-attest on every merge" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("remote journaling is not configured");
  });

  it("ingests a note, reads it back pending, then folding clears it from the pending list", async () => {
    const config: HandsConfig = { ...DEFAULT_CONFIG, remote: { url: bareRemote(), handle: "test-handle", project: "test-project" } };
    const expo = await connect("expo", config);

    const ingested = await call(expo, "hands_role_note", { text: "a busy main produces a re-attest treadmill" });
    expect(ingested.isError).toBe(false);
    const noteId = ingested.body.id as number;
    expect(noteId).toBeGreaterThan(0);

    const state = await call(expo, "hands_role_state", {});
    expect(state.isError).toBe(false);
    expect(state.body.ok).toBe(true);
    expect(state.body.role).toBe("expo"); // defaulted
    expect(state.body.text).toBe(""); // never distilled yet — not a failure
    expect(state.body.pending).toEqual([{ id: noteId, by: "expo", text: "a busy main produces a re-attest treadmill", at: expect.any(String) }]);

    const folded = await call(expo, "hands_role_fold_done", { through: noteId });
    expect(folded.isError).toBe(false);

    const after = await call(expo, "hands_role_state", {});
    expect(after.body.pending).toEqual([]); // folded, no longer pending
  });

  it("is scoped per role — a note for one role never appears in another's pending read", async () => {
    const config: HandsConfig = { ...DEFAULT_CONFIG, remote: { url: bareRemote(), handle: "test-handle", project: "test-project" } };
    const expo = await connect("expo", config);

    await call(expo, "hands_role_note", { text: "expo's own friction note" });
    await call(expo, "hands_role_note", { text: "a future sous's own note", role: "sous" });

    const expoState = await call(expo, "hands_role_state", {});
    expect((expoState.body.pending as unknown[]).length).toBe(1);
    expect(((expoState.body.pending as Array<{ text: string }>)[0]!).text).toBe("expo's own friction note");

    const sousState = await call(expo, "hands_role_state", { role: "sous" });
    expect((sousState.body.pending as unknown[]).length).toBe(1);
    expect(((sousState.body.pending as Array<{ text: string }>)[0]!).text).toBe("a future sous's own note");
  });
});
