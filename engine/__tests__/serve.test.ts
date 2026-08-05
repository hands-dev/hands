import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDLE_THRESHOLD_MS } from "../src/board.js";
import { DEFAULT_CONFIG, resetConfigCache } from "../src/config.js";
import { openJournal, syncPush } from "../src/remote.js";
import { buildSnapshot } from "../src/snapshot.js";
import { serve, type ServeHandle, snapshotKey } from "../src/serve.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;
let handle: ServeHandle | null = null;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-serve-"));
  env = { HANDS_HOME: home };
});
afterEach(() => {
  handle?.close();
  handle = null;
  fs.rmSync(home, { recursive: true, force: true });
});

function get(url: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body }),
        );
      })
      .on("error", reject);
  });
}

/** Open an SSE stream; resolves helpers to await data frames in arrival order. */
function sse(url: string): {
  next: (timeoutMs?: number) => Promise<string>;
  close: () => void;
} {
  const frames: string[] = [];
  const waiters: Array<(f: string) => void> = [];
  let buffer = "";
  const req = http.get(url, (res) => {
    res.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice("data: ".length))
          .join("\n");
        if (!data) continue; // retry:/comment frames
        const waiter = waiters.shift();
        if (waiter) waiter(data);
        else frames.push(data);
      }
    });
  });
  return {
    next: (timeoutMs = 2000) => {
      const queued = frames.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("no SSE frame within timeout")), timeoutMs);
        waiters.push((f) => {
          clearTimeout(t);
          resolve(f);
        });
      });
    },
    close: () => req.destroy(),
  };
}

describe("serve", () => {
  it("serves the SPA shell and guards the asset allowlist", async () => {
    const assets = path.join(home, "assets");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "dashboard.js"), "// js");
    fs.writeFileSync(path.join(assets, "dashboard.css"), "/* css */");
    handle = await serve({ port: 0, env, assetsDir: assets });

    const shell = await get(handle.url);
    expect(shell.status).toBe(200);
    expect(shell.body).toContain('<div id="root">');
    expect(shell.body).toContain("/assets/dashboard.js");
    expect(shell.body).toContain("/assets/dashboard.css");

    expect((await get(`${handle.url}assets/dashboard.js`)).type).toContain("text/javascript");
    expect((await get(`${handle.url}assets/dashboard.css`)).type).toContain("text/css");
    expect((await get(`${handle.url}assets/nope.js`)).status).toBe(404);
    expect((await get(`${handle.url}assets/../server.mjs`)).status).toBe(404);
    expect((await get(`${handle.url}assets/%2e%2e%2fdashboard.js`)).status).toBe(404);
  });

  it("includes principal and db in /api/state", async () => {
    handle = await serve({ port: 0, env });
    const res = await get(`${handle.url}api/state`);
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as { agents: unknown[]; principal: string; db: string };
    expect(Array.isArray(payload.agents)).toBe(true);
    expect(typeof payload.principal).toBe("string");
    expect(payload.db).toContain(home);
  });

  it("SSE: initial frame on connect, a frame per store change, none from time alone", async () => {
    const store = new Store({ env });
    store.setStatus({ id: "station-1", cwd: "/w1", pid: 1, branch: "b1", now: Date.now() });
    handle = await serve({ port: 0, env, tickMs: 25 });

    const stream = sse(`${handle.url}api/events`);
    const first = JSON.parse(await stream.next()) as { agents: Array<{ id: string }>; principal: string };
    expect(first.agents.map((a) => a.id)).toContain("station-1");
    expect(typeof first.principal).toBe("string");

    // a real change → a push
    store.journalAdd({ agentId: "station-1", kind: "note", ref: "n1", text: "did a thing", now: Date.now() });
    const second = JSON.parse(await stream.next()) as { journal: Array<{ text: string }> };
    expect(second.journal.map((j) => j.text)).toContain("did a thing");

    // time passing alone (several ticks) → no push
    await expect(stream.next(300)).rejects.toThrow("no SSE frame");

    stream.close();
    store.close();
  });

  it("close() resolves with a connected SSE client", async () => {
    handle = await serve({ port: 0, env, tickMs: 25 });
    const stream = sse(`${handle.url}api/events`);
    await stream.next(); // connected + initial frame received
    handle.close();
    handle = null;
    stream.close();
  });
});

describe("other kitchens (books multiplayer)", () => {
  it("surfaces another handle's books activity over SSE, refreshed on the books tick", async () => {
    // a shared bare books remote
    const remote = path.join(home, "books.git");
    fs.mkdirSync(remote);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);

    // casey's kitchen appends + pushes from its own clone
    const casey = openJournal({
      env: { HANDS_HOME: path.join(home, "casey-home") },
      cwd: process.cwd(),
      config: { ...DEFAULT_CONFIG, remote: { url: remote, handle: "casey", project: "proj" } },
      agentId: "expo",
    })!;
    casey.append("task.create", { id: 1, by: "expo", title: "casey's ticket", at: Date.now() });
    expect(syncPush(casey, { force: true }).status).toBe("pushed");

    // our serve reads the same books via user-level config (michael's handle)
    const userClaude = path.join(home, "user", ".claude");
    fs.mkdirSync(userClaude, { recursive: true });
    fs.writeFileSync(
      path.join(userClaude, "hands.config.json"),
      JSON.stringify({ remote: { url: remote, handle: "michael", project: "proj" } }),
    );
    resetConfigCache();
    const serveEnv = { HANDS_HOME: home, HANDS_TEST_HOME: path.join(home, "user") };
    handle = await serve({ port: 0, env: serveEnv, tickMs: 25, booksTickMs: 100 });

    const stream = sse(`${handle.url}api/events`);
    // kitchens arrive on the first refresh after connect (initial frame may be empty)
    let kitchens: Array<{ handle: string; updates: Array<{ summary: string }> }> = [];
    for (let i = 0; i < 10 && !kitchens.some((k) => k.handle === "casey"); i++) {
      const frame = JSON.parse(await stream.next()) as { kitchens: typeof kitchens };
      kitchens = frame.kitchens;
    }
    const caseyKitchen = kitchens.find((k) => k.handle === "casey");
    expect(caseyKitchen).toBeDefined();
    expect(caseyKitchen!.updates.map((u) => u.summary)).toContain("ticket #1 fired: casey's ticket");

    // a NEW casey push shows up via the periodic pull, no reconnect
    casey.append("task.update", { id: 1, state: "returned", result: "done", at: Date.now() });
    expect(syncPush(casey, { force: true }).status).toBe("pushed");
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      const frame = JSON.parse(await stream.next(3000)) as { kitchens: typeof kitchens };
      seen = frame.kitchens.some((k) =>
        k.updates.some((u) => u.summary === "ticket #1 → returned"),
      );
    }
    expect(seen).toBe(true);

    stream.close();
    resetConfigCache();
  }, 20_000);
});

describe("other kitchens' crafts (books multiplayer)", () => {
  it("surfaces another handle's craft book/skill over SSE, refreshed on the books tick", async () => {
    // a shared bare books remote
    const remote = path.join(home, "crafts-books.git");
    fs.mkdirSync(remote);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);

    // casey's kitchen writes a craft's book + skill under its own namespace, then pushes
    const casey = openJournal({
      env: { HANDS_HOME: path.join(home, "casey-home") },
      cwd: process.cwd(),
      config: { ...DEFAULT_CONFIG, remote: { url: remote, handle: "casey", project: "proj" } },
      agentId: "station-1",
    })!;
    const craftsDir = path.join(casey.dir, "journal", casey.project, casey.handle, "crafts");
    fs.mkdirSync(craftsDir, { recursive: true });
    fs.writeFileSync(path.join(craftsDir, "saucier.md"), "casey's saucier book\ncovers: sauces\n");
    fs.writeFileSync(path.join(craftsDir, "saucier.skill.md"), "casey's saucier skill\n");
    expect(syncPush(casey, { force: true }).status).toBe("pushed");

    // our serve reads the same books via user-level config (michael's handle)
    const userClaude = path.join(home, "user", ".claude");
    fs.mkdirSync(userClaude, { recursive: true });
    fs.writeFileSync(
      path.join(userClaude, "hands.config.json"),
      JSON.stringify({ remote: { url: remote, handle: "michael", project: "proj" } }),
    );
    resetConfigCache();
    const serveEnv = { HANDS_HOME: home, HANDS_TEST_HOME: path.join(home, "user") };
    handle = await serve({ port: 0, env: serveEnv, tickMs: 25, booksTickMs: 100 });

    const stream = sse(`${handle.url}api/events`);
    // crafts arrive on the first refresh after connect (initial frame may be empty)
    let crafts: Array<{ handle: string; slug: string; book: string | null; skill: string | null }> = [];
    for (let i = 0; i < 10 && !crafts.some((c) => c.handle === "casey"); i++) {
      const frame = JSON.parse(await stream.next()) as { crafts: typeof crafts };
      crafts = frame.crafts;
    }
    const caseyCraft = crafts.find((c) => c.handle === "casey" && c.slug === "saucier");
    expect(caseyCraft).toBeDefined();
    expect(caseyCraft!.book).toContain("casey's saucier book");
    expect(caseyCraft!.skill).toContain("casey's saucier skill");

    stream.close();
    resetConfigCache();
  }, 20_000);
});

describe("snapshotKey (SSE change detection)", () => {
  it("ignores `now` but keys on the derived idle flip", () => {
    const store = new Store({ env });
    const t = 3_000_000_000_000;
    store.setStatus({ id: "station-1", cwd: "/w1", pid: 1, branch: "b1", now: t });

    const atT = snapshotKey(buildSnapshot(store, t, env));
    const fiveSecondsOn = snapshotKey(buildSnapshot(store, t + 5_000, env));
    expect(fiveSecondsOn).toBe(atT); // still active — nothing to push

    const pastIdle = snapshotKey(buildSnapshot(store, t + IDLE_THRESHOLD_MS + 1_000, env));
    expect(pastIdle).not.toBe(atT); // active → idle IS a pushable change

    store.close();
  });
});
