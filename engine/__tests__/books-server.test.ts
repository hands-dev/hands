import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBooksServer, resolveBooksConfig, type BooksConfig } from "../src/books-server.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hands-books-server-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a digest + README under journal/<project>/<handle>/ directly — the server only ever reads these files, never the event log. */
function writeDigest(dir: string, project: string, handle: string, date: string, body: string): void {
  const handleDir = path.join(dir, "journal", project, handle);
  fs.mkdirSync(handleDir, { recursive: true });
  fs.writeFileSync(path.join(handleDir, `${date}.md`), body);
}

function writeReadme(dir: string, project: string, handle: string, body: string): void {
  const handleDir = path.join(dir, "journal", project, handle);
  fs.mkdirSync(handleDir, { recursive: true });
  fs.writeFileSync(path.join(handleDir, "README.md"), body);
}

async function connect(cfg: BooksConfig | null) {
  const server = buildBooksServer(cfg);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

describe("resolveBooksConfig", () => {
  it("is null when HANDS_BOOKS_DIR is unset", () => {
    expect(resolveBooksConfig({})).toBeNull();
  });

  it("reads dir + optional project from env", () => {
    expect(resolveBooksConfig({ HANDS_BOOKS_DIR: "/x", HANDS_BOOKS_PROJECT: "hands" })).toEqual({
      dir: "/x",
      project: "hands",
    });
    expect(resolveBooksConfig({ HANDS_BOOKS_DIR: "/x" })).toEqual({ dir: "/x", project: null });
  });
});

describe("books MCP tools — not configured", () => {
  it("every tool errors with actionable guidance when cfg is null", async () => {
    const { client, close } = await connect(null);
    for (const name of ["books_list_projects", "books_list_handles", "books_sync"]) {
      const res = await call(client, name);
      expect(res.isError).toBe(true);
      expect(String(res.body.error)).toContain("hands mcp install");
    }
    await close();
  });
});

describe("books MCP tools — configured", () => {
  it("lists projects and the configured default", async () => {
    fs.mkdirSync(path.join(root, "journal", "hands"), { recursive: true });
    fs.mkdirSync(path.join(root, "journal", "other-repo"), { recursive: true });
    const { client, close } = await connect({ dir: root, project: "hands" });
    const res = await call(client, "books_list_projects");
    expect(res.isError).toBe(false);
    expect(res.body.projects).toEqual(["hands", "other-repo"]);
    expect(res.body.default).toBe("hands");
    await close();
  });

  it("lists handles under the default project when none is passed", async () => {
    writeDigest(root, "hands", "michael", "2026-08-01", "x");
    writeDigest(root, "hands", "station-1", "2026-08-01", "x");
    const { client, close } = await connect({ dir: root, project: "hands" });
    const res = await call(client, "books_list_handles", {});
    expect(res.isError).toBe(false);
    expect(res.body.handles).toEqual(["michael", "station-1"]);
    await close();
  });

  it("errors asking for a project when none is configured or passed", async () => {
    const { client, close } = await connect({ dir: root, project: null });
    const res = await call(client, "books_list_handles", {});
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("no project given");
    await close();
  });

  it("lists digest days newest-first and reads one back", async () => {
    writeDigest(root, "hands", "michael", "2026-08-01", "# day one\n");
    writeDigest(root, "hands", "michael", "2026-08-03", "# day three\n");
    const { client, close } = await connect({ dir: root, project: "hands" });

    const days = await call(client, "books_list_days", { handle: "michael" });
    expect(days.body.days).toEqual(["2026-08-03", "2026-08-01"]);

    const digest = await call(client, "books_read_digest", { handle: "michael", date: "2026-08-03" });
    expect(digest.isError).toBe(false);
    expect(digest.body.markdown).toBe("# day three\n");

    const missing = await call(client, "books_read_digest", { handle: "michael", date: "2026-08-02" });
    expect(missing.isError).toBe(true);
    await close();
  });

  it("rejects a malformed date before touching disk", async () => {
    const { client, close } = await connect({ dir: root, project: "hands" });
    const res = await call(client, "books_read_digest", { handle: "michael", date: "not-a-date" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("YYYY-MM-DD");
    await close();
  });

  it("reads the per-handle README index", async () => {
    writeReadme(root, "hands", "michael", "# michael · hands\n\n- [2026-08-01](./2026-08-01.md) — 1 item\n");
    const { client, close } = await connect({ dir: root, project: "hands" });
    const res = await call(client, "books_read_index", { handle: "michael" });
    expect(res.isError).toBe(false);
    expect(String(res.body.markdown)).toContain("michael · hands");
    await close();
  });

  it("an explicit project argument overrides the configured default", async () => {
    writeDigest(root, "other-repo", "michael", "2026-08-01", "# other\n");
    const { client, close } = await connect({ dir: root, project: "hands" });
    const res = await call(client, "books_read_digest", {
      handle: "michael",
      date: "2026-08-01",
      project: "other-repo",
    });
    expect(res.isError).toBe(false);
    expect(res.body.project).toBe("other-repo");
    await close();
  });
});
