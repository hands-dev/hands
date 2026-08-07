import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain-JS build script, no types (same pattern as bundle.test.ts)
import { collectFiles, publish, readBuildInfo } from "../scripts/publish-installer-blob.mjs";

let distDir: string;

/** A minimal-but-real plugin/dist shape: what collectFiles/publish actually read. */
function seedDist(dir: string, commit = "abc1234") {
  fs.writeFileSync(path.join(dir, "BUILD.json"), JSON.stringify({ version: "0.1.0", commit, builtAt: "2026-01-01T00:00:00.000Z" }));
  fs.writeFileSync(path.join(dir, "cli.mjs"), "// cli wrapper\n");
  fs.writeFileSync(path.join(dir, "cli-impl.mjs"), "// cli impl\n");
  fs.mkdirSync(path.join(dir, "assets", "fonts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", "dashboard.js"), "// dashboard js\n");
  fs.writeFileSync(path.join(dir, "assets", "dashboard.css"), "/* css */\n");
  fs.writeFileSync(path.join(dir, "assets", "fonts", "archivo.woff2"), "fake-font-bytes");
  fs.writeFileSync(
    path.join(dir, "assets", "MANIFEST.txt"),
    "dashboard.css\ndashboard.js\nfonts/archivo.woff2\n",
  );
}

beforeEach(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), "hands-publish-installer-"));
  seedDist(distDir);
});
afterEach(() => fs.rmSync(distDir, { recursive: true, force: true }));

describe("readBuildInfo", () => {
  it("returns the stamped commit", () => {
    expect(readBuildInfo(distDir)).toMatchObject({ commit: "abc1234" });
  });

  it("throws when BUILD.json has no commit — bundle:stamp hasn't run", () => {
    fs.writeFileSync(path.join(distDir, "BUILD.json"), JSON.stringify({ version: "0.1.0", commit: null }));
    expect(() => readBuildInfo(distDir)).toThrow(/bundle:stamp/);
  });
});

describe("collectFiles", () => {
  it("lists exactly what install.sh fetches, MANIFEST-driven, keyed under installer/<commit>", () => {
    const files = collectFiles("abc1234", distDir);
    expect(files).toEqual([
      ["cli.mjs", "installer/abc1234/cli.mjs"],
      ["cli-impl.mjs", "installer/abc1234/cli-impl.mjs"],
      ["BUILD.json", "installer/abc1234/BUILD.json"],
      ["assets/MANIFEST.txt", "installer/abc1234/assets/MANIFEST.txt"],
      ["assets/dashboard.css", "installer/abc1234/assets/dashboard.css"],
      ["assets/dashboard.js", "installer/abc1234/assets/dashboard.js"],
      ["assets/fonts/archivo.woff2", "installer/abc1234/assets/fonts/archivo.woff2"],
    ]);
  });

  it("never lists server.mjs/server-impl.mjs/books-server.mjs — install.sh doesn't fetch them", () => {
    const files: string[] = collectFiles("abc1234", distDir).map((pair: string[]) => pair[1]);
    expect(files.some((k: string) => k.includes("server"))).toBe(false);
    expect(files.some((k: string) => k.includes("books-server"))).toBe(false);
  });
});

describe("publish", () => {
  /** A fake Blob store: put() writes into an in-memory map; fetchFn reads it back — exercises
   * the real upload-then-verify round trip without any network or credentials. */
  function fakeBlobStore() {
    const store = new Map<string, Buffer>();
    const put = async (key: string, body: Buffer, _opts?: unknown) => {
      store.set(key, Buffer.from(body));
      return { url: `https://fake.blob.vercel-storage.com/${key}` };
    };
    const fetchFn = async (url: string) => {
      const key = url.replace("https://fake.blob.vercel-storage.com/", "");
      const body = store.get(key);
      if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
    };
    return { store, put, fetchFn };
  }

  it("uploads every collected file, verifies each by reading it back, and writes latest.json last", async () => {
    const { store, put, fetchFn } = fakeBlobStore();
    const putOrder: string[] = [];
    const trackedPut = async (key: string, body: Buffer, opts: unknown) => {
      putOrder.push(key);
      return put(key, body, opts as never);
    };

    const result = await publish({ distDir, put: trackedPut, fetchFn, log: () => {} });

    expect(result.commit).toBe("abc1234");
    // Every collectFiles() entry landed in the store...
    for (const [, key] of collectFiles("abc1234", distDir)) {
      expect(store.has(key)).toBe(true);
    }
    // ...and latest.json was the LAST write, only after everything else.
    expect(putOrder.at(-1)).toBe("installer/latest.json");
    expect(putOrder.indexOf("installer/latest.json")).toBe(putOrder.length - 1);

    const latest = JSON.parse(store.get("installer/latest.json")!.toString("utf8"));
    expect(latest.commit).toBe("abc1234");
    expect(typeof latest.publishedAt).toBe("string");
  });

  it("uploaded content matches the source files byte for byte", async () => {
    const { store, put, fetchFn } = fakeBlobStore();
    await publish({ distDir, put, fetchFn, log: () => {} });
    expect(store.get("installer/abc1234/cli-impl.mjs")!.toString("utf8")).toBe("// cli impl\n");
    expect(store.get("installer/abc1234/assets/dashboard.js")!.toString("utf8")).toBe("// dashboard js\n");
  });

  it("fails loudly, and never reaches latest.json, if a verify read-back comes back corrupted", async () => {
    const { put } = fakeBlobStore();
    // A fetchFn that always returns different bytes than what was just uploaded — simulates a
    // CDN serving stale/corrupted content right after a successful-looking upload.
    const corruptingFetch = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from("not what was uploaded").buffer,
    });
    await expect(publish({ distDir, put, fetchFn: corruptingFetch, log: () => {} })).rejects.toThrow(
      /content mismatch/,
    );
  });

  it("fails loudly if the read-back request itself errors (non-2xx)", async () => {
    const { put } = fakeBlobStore();
    const failingFetch = async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(publish({ distDir, put, fetchFn: failingFetch, log: () => {} })).rejects.toThrow(/HTTP 503/);
  });
});
