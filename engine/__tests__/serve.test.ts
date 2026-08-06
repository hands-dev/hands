import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDLE_THRESHOLD_MS } from "../src/board.js";
import { DEFAULT_CONFIG, resetConfigCache } from "../src/config.js";
import type { FeedbackResult, GhRunner } from "../src/feedback.js";
import { pidPath } from "../src/paths.js";
import { openJournal, syncPush } from "../src/remote.js";
import { buildSnapshot } from "../src/snapshot.js";
import { kitchenName, serve, type ServeHandle, snapshotKey } from "../src/serve.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;
let handle: ServeHandle | null = null;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-serve-"));
  // This suite never creates its own fixture repo, so a real hands.config.json
  // in whatever repo the test process happens to run from (a worktree of this
  // very repo, when dogfooded) must not bleed in — see config.ts repoConfigPath.
  // Also matters for loadConfig's cache key, which is keyed on cwd (constant
  // across this whole file) — without this, the FIRST test to populate that
  // cache entry pollutes every later test that shares the same default cwd.
  env = { HANDS_HOME: home, HANDS_NO_REPO_CONFIG: "1" };
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

function post(
  url: string,
  body: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: "POST", headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
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
    // the tab title is namespaced to the kitchen (#40)
    expect(shell.body).toMatch(/<title>hands · [^<]+<\/title>/);

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

describe("dashboard pidfile (hands#77/#82)", () => {
  it("writes its own pid on bind, and removes it on close", async () => {
    handle = await serve({ port: 0, env });
    const pid = pidPath(env);
    expect(fs.existsSync(pid)).toBe(true);
    expect(fs.readFileSync(pid, "utf8").trim()).toBe(String(process.pid));

    handle.close();
    handle = null;
    expect(fs.existsSync(pid)).toBe(false);
  });

  it("doesn't clobber a newer instance's pidfile on close", async () => {
    handle = await serve({ port: 0, env });
    const pid = pidPath(env);
    // simulate a second instance having already replaced the file with its own pid
    fs.writeFileSync(pid, "999999");
    handle.close();
    handle = null;
    expect(fs.readFileSync(pid, "utf8").trim()).toBe("999999");
    fs.rmSync(pid, { force: true });
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
    const serveEnv = { HANDS_HOME: home, HANDS_TEST_HOME: path.join(home, "user"), HANDS_NO_REPO_CONFIG: "1" };
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

    // a successful pull tick reports it, not just silence (hands#59)
    const withBooksSync = JSON.parse(await get(`${handle.url}api/state`).then((r) => r.body)) as {
      booksSync: { ok: boolean; lastAttempt: number | null; lastSuccess: number | null; reason: string | null } | null;
    };
    expect(withBooksSync.booksSync?.ok).toBe(true);
    expect(withBooksSync.booksSync?.lastSuccess).not.toBeNull();
    expect(withBooksSync.booksSync?.reason).toBeNull();

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

describe("books sync status (hands#59)", () => {
  it("surfaces a failed pull instead of silently discarding it", async () => {
    // never created — `git fetch` against it fails deterministically (PullResult reason "offline").
    // Passed via the `config` test hook (bypasses loadConfig's real repo/user
    // file lookup entirely) — this project's own real hands.config.json is
    // itself remote-configured, so relying on env-based isolation alone would
    // leak the real remote.url in on this exact machine/repo combination.
    const remote = path.join(home, "nonexistent-remote.git");
    handle = await serve({
      port: 0,
      env: { HANDS_HOME: home },
      config: { ...DEFAULT_CONFIG, remote: { url: remote, handle: "michael", project: "proj" } },
      tickMs: 25,
      booksTickMs: 100,
    });

    type BooksSyncFrame = { ok: boolean; reason: string | null; lastAttempt: number | null } | null;
    const stream = sse(`${handle.url}api/events`);
    let booksSync: BooksSyncFrame = null;
    for (let i = 0; i < 20 && !(booksSync && booksSync.lastAttempt != null); i++) {
      const frame = JSON.parse(await stream.next(3000)) as { booksSync: BooksSyncFrame };
      booksSync = frame.booksSync;
    }
    expect(booksSync?.ok).toBe(false);
    expect(booksSync?.reason).toBe("offline");
    expect(booksSync?.lastAttempt).not.toBeNull();

    stream.close();
  }, 20_000);

  it("reports null (not an unattempted status) when the books aren't configured at all", async () => {
    handle = await serve({ port: 0, env: { HANDS_HOME: home }, config: DEFAULT_CONFIG });
    const state = await get(`${handle.url}api/state`);
    const payload = JSON.parse(state.body) as { booksSync: unknown };
    expect(payload.booksSync).toBeNull();
  });
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
    const serveEnv = { HANDS_HOME: home, HANDS_TEST_HOME: path.join(home, "user"), HANDS_NO_REPO_CONFIG: "1" };
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

describe("kitchenName (dashboard repo/kitchen namespacing, #40)", () => {
  it("derives the kitchen from the coordination-dir basename above hands.db", () => {
    expect(kitchenName("/Users/michael/.claude/coordination/hands-3667facd/hands.db")).toBe(
      "hands-3667facd",
    );
  });

  it("falls back to a generic label when the parent basename is empty", () => {
    expect(kitchenName("/hands.db")).toBe("kitchen");
  });
});

describe("POST /api/feedback", () => {
  it("files via the injected fileFeedback and returns its url", async () => {
    let received: { body: string; title?: string } | null = null;
    handle = await serve({
      port: 0,
      env,
      fileFeedback: (opts) => {
        received = { body: opts.body, title: opts.title };
        return { ok: true, url: "https://github.com/hands-dev/hands/issues/1" };
      },
    });

    const res = await post(`${handle.url}api/feedback`, JSON.stringify({ body: "the rail truncates", title: "feedback: rail" }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: "https://github.com/hands-dev/hands/issues/1" });
    expect(received).toEqual({ body: "the rail truncates", title: "feedback: rail" });
  });

  it("passes title through as undefined when the client omits it", async () => {
    let received: { title?: string } | null = null;
    handle = await serve({
      port: 0,
      env,
      fileFeedback: (opts) => {
        received = { title: opts.title };
        return { ok: true, url: "https://example/1" };
      },
    });
    await post(`${handle.url}api/feedback`, JSON.stringify({ body: "no title given" }));
    expect(received).toEqual({ title: undefined });
  });

  it("returns 400 for a missing/empty body without calling fileFeedback", async () => {
    let called = false;
    handle = await serve({
      port: 0,
      env,
      fileFeedback: (): FeedbackResult => {
        called = true;
        return { ok: true, url: "https://example/1" };
      },
    });

    const missing = await post(`${handle.url}api/feedback`, JSON.stringify({}));
    expect(missing.status).toBe(400);
    const blank = await post(`${handle.url}api/feedback`, JSON.stringify({ body: "   " }));
    expect(blank.status).toBe(400);
    expect(called).toBe(false);
  });

  it("returns 400 for malformed JSON", async () => {
    handle = await serve({ port: 0, env });
    const res = await post(`${handle.url}api/feedback`, "not json");
    expect(res.status).toBe(400);
  });

  it("returns 502 with the underlying error when filing fails", async () => {
    handle = await serve({
      port: 0,
      env,
      fileFeedback: () => ({ ok: false, error: "gh: authentication required" }),
    });
    const res = await post(`${handle.url}api/feedback`, JSON.stringify({ body: "bug: X" }));
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "gh: authentication required" });
  });

  it("rejects an oversized body without ever reaching fileFeedback", async () => {
    let called = false;
    handle = await serve({
      port: 0,
      env,
      fileFeedback: (): FeedbackResult => {
        called = true;
        return { ok: true, url: "https://example/1" };
      },
    });
    const huge = JSON.stringify({ body: "x".repeat(200_000) });
    const res = await post(`${handle.url}api/feedback`, huge);
    expect(res.status).toBe(413);
    expect(called).toBe(false);
  });

  it("a GET to the same path is not treated as the feedback route (falls through to 404)", async () => {
    handle = await serve({ port: 0, env });
    const res = await get(`${handle.url}api/feedback`);
    expect(res.status).toBe(404);
  });

  it("rejects a title over the independent title bound, without ever reaching fileFeedback", async () => {
    let called = false;
    handle = await serve({
      port: 0,
      env,
      fileFeedback: (): FeedbackResult => {
        called = true;
        return { ok: true, url: "https://example/1" };
      },
    });
    const res = await post(`${handle.url}api/feedback`, JSON.stringify({ body: "x", title: "y".repeat(301) }));
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("drives the real HTTP route through the REAL fileFeedback() to a fake gh — not just the route handler and fileFeedback tested in isolation", async () => {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      if (args[0] === "issue") return "https://github.com/hands-dev/hands/issues/999\n";
      return "";
    };
    handle = await serve({ port: 0, env, feedbackGh: gh });

    const res = await post(`${handle.url}api/feedback`, JSON.stringify({ body: "end-to-end note", title: "feedback: e2e" }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: "https://github.com/hands-dev/hands/issues/999" });
    const issueCall = calls.find((c) => c[0] === "issue")!;
    expect(issueCall).toContain("feedback: e2e");
    expect(issueCall.find((a) => a.includes("end-to-end note"))).toBeDefined();
  });

  describe("CSRF (same-origin) protection", () => {
    it("rejects a cross-origin POST (a same-machine malicious page can't silently file feedback under the operator's identity)", async () => {
      let called = false;
      handle = await serve({
        port: 0,
        env,
        fileFeedback: (): FeedbackResult => {
          called = true;
          return { ok: true, url: "https://example/1" };
        },
      });
      const res = await post(`${handle.url}api/feedback`, JSON.stringify({ body: "x" }), {
        origin: "https://evil.example",
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    });

    it("rejects based on a mismatched Referer when Origin is absent", async () => {
      let called = false;
      handle = await serve({
        port: 0,
        env,
        fileFeedback: (): FeedbackResult => {
          called = true;
          return { ok: true, url: "https://example/1" };
        },
      });
      const res = await post(`${handle.url}api/feedback`, JSON.stringify({ body: "x" }), {
        referer: "https://evil.example/attack.html",
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    });

    it("accepts a same-origin POST (Origin matching the dashboard's own host:port)", async () => {
      handle = await serve({
        port: 0,
        env,
        fileFeedback: (): FeedbackResult => ({ ok: true, url: "https://example/1" }),
      });
      const origin = new URL(handle.url).origin;
      const res = await post(`${handle.url}api/feedback`, JSON.stringify({ body: "x" }), { origin });
      expect(res.status).toBe(200);
    });

    it("allows a request with neither Origin nor Referer (non-browser callers — curl, scripts — aren't the threat this guards against)", async () => {
      handle = await serve({
        port: 0,
        env,
        fileFeedback: (): FeedbackResult => ({ ok: true, url: "https://example/1" }),
      });
      const res = await post(`${handle.url}api/feedback`, JSON.stringify({ body: "x" }));
      expect(res.status).toBe(200);
    });
  });

  describe("rate limiting", () => {
    it("allows up to the limit, then 429s, without reaching fileFeedback on the throttled request", async () => {
      let calls = 0;
      handle = await serve({
        port: 0,
        env,
        fileFeedback: (): FeedbackResult => {
          calls++;
          return { ok: true, url: "https://example/1" };
        },
      });
      const body = JSON.stringify({ body: "x" });
      for (let i = 0; i < 5; i++) {
        const res = await post(`${handle.url}api/feedback`, body);
        expect(res.status).toBe(200);
      }
      const sixth = await post(`${handle.url}api/feedback`, body);
      expect(sixth.status).toBe(429);
      expect(calls).toBe(5);
    });

    it("does NOT consume a slot for a request that fails validation — a typo'd request retried a few times shouldn't trip the limit for legitimate use right after", async () => {
      let calls = 0;
      handle = await serve({
        port: 0,
        env,
        fileFeedback: (): FeedbackResult => {
          calls++;
          return { ok: true, url: "https://example/1" };
        },
      });

      // 10 back-to-back INVALID requests (empty body) — well past the limit of 5, if they counted
      for (let i = 0; i < 10; i++) {
        const res = await post(`${handle.url}api/feedback`, JSON.stringify({ body: "   " }));
        expect(res.status).toBe(400);
      }
      // the window is untouched — a genuinely valid request right after still succeeds
      const valid = await post(`${handle.url}api/feedback`, JSON.stringify({ body: "real feedback" }));
      expect(valid.status).toBe(200);
      expect(calls).toBe(1);
    });
  });
});
