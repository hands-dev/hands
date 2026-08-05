import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBooksServer, journalPath, resolveBooksConfig, type BooksConfig } from "../src/books-server.js";

let sandbox: string;
let root: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "hands-books-server-"));
  root = path.join(sandbox, "books");
  fs.mkdirSync(root);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
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

function writeCraft(
  dir: string,
  project: string,
  handle: string,
  slug: string,
  parts: { book?: string; skill?: string },
): void {
  const craftsDir = path.join(dir, "journal", project, handle, "crafts");
  fs.mkdirSync(craftsDir, { recursive: true });
  if (parts.book !== undefined) fs.writeFileSync(path.join(craftsDir, `${slug}.md`), parts.book);
  if (parts.skill !== undefined) fs.writeFileSync(path.join(craftsDir, `${slug}.skill.md`), parts.skill);
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

  it("lists crafts across every handle and reads one back", async () => {
    writeCraft(root, "hands", "michael", "saucier", { book: "# saucier book\n", skill: "# saucier skill\n" });
    writeCraft(root, "hands", "station-1", "ordering-api", { book: "# api book\n" });
    const { client, close } = await connect({ dir: root, project: "hands" });

    const list = await call(client, "books_list_crafts");
    expect(list.isError).toBe(false);
    expect(list.body.crafts).toEqual(
      expect.arrayContaining([
        { handle: "michael", slug: "saucier" },
        { handle: "station-1", slug: "ordering-api" },
      ]),
    );

    const read = await call(client, "books_read_craft", { handle: "michael", slug: "saucier" });
    expect(read.isError).toBe(false);
    expect(read.body.book).toBe("# saucier book\n");
    expect(read.body.skill).toBe("# saucier skill\n");

    // a slug with only a book (no skill file) still reads — the missing half is null, not an error
    const partial = await call(client, "books_read_craft", { handle: "station-1", slug: "ordering-api" });
    expect(partial.isError).toBe(false);
    expect(partial.body.book).toBe("# api book\n");
    expect(partial.body.skill).toBeNull();

    const missing = await call(client, "books_read_craft", { handle: "michael", slug: "poissonnier" });
    expect(missing.isError).toBe(true);
    await close();
  });
});

describe("journalPath (path-traversal containment)", () => {
  it("stays under <dir>/journal for benign segments", () => {
    expect(journalPath(root, "hands", "michael")).toBe(path.join(root, "journal", "hands", "michael"));
  });

  it("neutralizes a traversal-bearing segment instead of escaping", () => {
    const p = journalPath(root, "../../../../../../etc", "passwd");
    expect(p).not.toBeNull();
    const journalRoot = path.resolve(root, "journal");
    expect(p!.startsWith(`${journalRoot}${path.sep}`)).toBe(true);
  });

  it("a bare '..' or '.' segment resolves to a confined literal, never the parent dir", () => {
    const p = journalPath(root, "..");
    expect(p).not.toBeNull();
    const journalRoot = path.resolve(root, "journal");
    expect(p === journalRoot || p!.startsWith(`${journalRoot}${path.sep}`)).toBe(true);
  });
});

describe("books MCP tools — path traversal is neutralized end-to-end", () => {
  it("a traversal-bearing handle can never read a file outside the books clone", async () => {
    const secret = path.join(sandbox, "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET — must never be readable via the books MCP\n");
    writeDigest(root, "hands", "michael", "2026-08-01", "# real digest\n");
    const { client, close } = await connect({ dir: root, project: "hands" });

    const evilHandle = "../".repeat(8) + "secret.txt";
    const digest = await call(client, "books_read_digest", { handle: evilHandle, date: "2026-08-01" });
    expect(digest.isError).toBe(true);
    expect(JSON.stringify(digest.body)).not.toContain("TOP SECRET");

    const index = await call(client, "books_read_index", { handle: evilHandle });
    expect(index.isError).toBe(true);
    expect(JSON.stringify(index.body)).not.toContain("TOP SECRET");

    const days = await call(client, "books_list_days", { handle: evilHandle });
    expect(days.isError).toBe(false);
    expect(days.body.days).toEqual([]);

    const craft = await call(client, "books_read_craft", { handle: evilHandle, slug: "../secret" });
    expect(craft.isError).toBe(true);
    expect(JSON.stringify(craft.body)).not.toContain("TOP SECRET");

    const handles = await call(client, "books_list_handles", { project: "../../../../../../etc" });
    expect(handles.isError).toBe(false);
    expect(handles.body.handles).toEqual([]);

    await close();
  });
});
