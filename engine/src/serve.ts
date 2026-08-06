import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type HandsConfig, loadConfig } from "./config.js";
import { fileFeedback, type FeedbackResult, type GhRunner } from "./feedback.js";
import { dbPath, pidPath } from "./paths.js";
import {
  openJournal,
  type OtherCraft,
  type OtherKitchen,
  readOtherCrafts,
  readOtherKitchens,
  syncPull,
} from "./remote.js";
import { buildSnapshot, type Snapshot } from "./snapshot.js";
import { Store } from "./store.js";
import { TokenSampler, type TokenSeries } from "./tokens.js";

/**
 * Liveness of the books pull-and-reread tick (readOtherKitchens/readOtherCrafts
 * are purely local reads — this is the only signal that the pull feeding them
 * is actually succeeding). `syncPull` failures were previously discarded
 * entirely (hands#59) — a stuck sync looked identical to "no other kitchens."
 */
export interface BooksSyncStatus {
  /** when refreshKitchens last ran, regardless of outcome */
  lastAttempt: number | null;
  /** when a pull last succeeded — the age of what kitchens/crafts actually reflect */
  lastSuccess: number | null;
  ok: boolean;
  reason: "offline" | "conflict" | "error" | null;
}

/** The one wire shape — served by /api/state and pushed on /api/events. */
export type DashboardPayload = Snapshot & {
  /** discriminates against HostedDashboardPayload (dashboard/use-snapshot.ts) */
  mode: "local";
  db: string;
  principal: string;
  /** other handles' recent books activity (empty when the books are off) */
  kitchens: OtherKitchen[];
  /** other handles' craft books/skills in this project's books (empty when the books are off) */
  crafts: OtherCraft[];
  /** null when the books aren't configured at all; otherwise the pull tick's liveness */
  booksSync: BooksSyncStatus | null;
  /** per-pane token burn from Claude Code transcripts (null until first sample) */
  tokens: TokenSeries | null;
  /** approximate output-token cost per rail ticket (assignee's spend over the working interval) */
  taskCosts: Record<number, number>;
};

export interface ServeHandle {
  port: number;
  host: string;
  url: string;
  close: () => void;
}

/**
 * The committed SPA assets, by exact name — an allowlist, so path traversal
 * fails the map lookup instead of needing normalization.
 */
const ASSETS: Record<string, string> = {
  "dashboard.js": "text/javascript; charset=utf-8",
  "dashboard.css": "text/css; charset=utf-8",
};

/** Feedback is a short note, not a file upload — generous enough for anything a human would type, small enough that a runaway client can't build up memory on this server. */
const MAX_FEEDBACK_BODY_BYTES = 100_000;
/** A title is a one-liner, not a body — bounded independently of the aggregate body cap so a huge "title" alone can't slip through under it. */
const MAX_FEEDBACK_TITLE_BYTES = 300;
const FEEDBACK_RATE_LIMIT_MAX = 5;
const FEEDBACK_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Same-origin check for state-changing routes (currently just POST
 * /api/feedback). Binding to 127.0.0.1 stops a remote attacker but NOT a
 * same-machine cross-origin request — any webpage open in the same browser
 * while `hands serve` runs could otherwise POST here and file an issue
 * under the operator's own `gh` identity. Origin is checked first: it's
 * sent by browsers on every cross-origin "unsafe method" request (POST
 * included) and — unlike Referer — can't be suppressed via
 * `Referrer-Policy`, so it's the harder-to-spoof signal. Neither header
 * present at all (no browser involved — curl, a script, these tests)
 * is allowed: that's not the threat this guards against.
 *
 * Accepted residual risk: Origin/Host-based localhost defenses are
 * generically exposed to DNS rebinding (a public DNS name resolving to
 * 127.0.0.1, satisfying the Host check while genuinely being cross-origin)
 * — the same gap webpack-dev-server, Vite, etc. carry, not specific to
 * this implementation. Not worth defending against for a single-operator
 * local tool.
 */
function isTrustedOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const matchesHost = (value: string | undefined): boolean | null => {
    if (!value) return null;
    try {
      return new URL(value).host === host;
    } catch {
      return false; // present but unparseable — treat as a mismatch, not "absent"
    }
  };
  const origin = matchesHost(req.headers.origin);
  if (origin !== null) return origin;
  const referer = matchesHost(req.headers.referer);
  if (referer !== null) return referer;
  return true;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/** Repo/kitchen name for the browser tab — same derivation as the sidebar label. */
export function kitchenName(db: string): string {
  return path.basename(path.dirname(db)) || "kitchen";
}

/**
 * Static shell; all data (including the principal) arrives via SSE/JSON. The
 * tab title is namespaced to the kitchen so multiple hands dashboards (one
 * per repo) are distinguishable at a glance.
 */
function shellHtml(kitchen: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="icon" href="data:,"/><title>hands · ${escapeHtml(kitchen)}</title>
<link rel="stylesheet" href="/assets/dashboard.css"/>
</head><body><div id="root"></div>
<script type="module" src="/assets/dashboard.js"></script></body></html>
`;
}

function defaultAssetsDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return (
    [
      path.join(here, "assets"), // plugin/dist/server-impl.mjs → sibling assets/
      path.join(here, "..", "..", "plugin", "dist", "assets"), // engine/src (tsx) + engine/dist (tsc)
    ].find((d) => fs.existsSync(d)) ?? null
  );
}

/**
 * The SSE change key: the serialized snapshot minus `now`, the only field
 * that churns every tick. Everything else changes discretely and deserves a
 * push (state flips at the idle threshold, wake counts crossing the window).
 */
export function snapshotKey(snapshot: Snapshot): string {
  const { now: _now, ...rest } = snapshot;
  return JSON.stringify(rest);
}

/**
 * Start the dashboard server. Binds to localhost only — that keeps remote
 * attackers out, but NOT another page in the operator's own browser, which
 * is why the one write route (POST /api/feedback) has its own same-origin
 * check and rate limit (see isTrustedOrigin above). Everything else is
 * read-only. Does NOT register itself as an agent — it's a viewer/reporter,
 * not a participant. Live updates ride /api/events (SSE): a lazy ~1s tick
 * rebuilds the snapshot while at least one client is connected and pushes
 * only when it changed.
 */
export function serve(opts?: {
  port?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  /** SSE change-poll interval (test hook) */
  tickMs?: number;
  /** books pull-and-reread interval (test hook) */
  booksTickMs?: number;
  /** token-transcript sampling interval (test hook) */
  tokensTickMs?: number;
  /** transcripts root, default ~/.claude/projects (test hook) */
  projectsDir?: string;
  /** where dashboard.js/.css live (test hook) */
  assetsDir?: string;
  /** bypass loadConfig's real repo/user file lookup entirely (test hook) */
  config?: HandsConfig;
  /** override the whole feedback-filing function POST /api/feedback calls (test hook) — takes priority over feedbackGh below */
  fileFeedback?: (opts: { body: string; title?: string; cwd?: string }) => FeedbackResult;
  /** override just the `gh` invocation the REAL fileFeedback() uses (test hook) — lets a test drive the actual route → fileFeedback() → gh chain without either mocking the whole function or shelling out for real */
  feedbackGh?: GhRunner;
}): Promise<ServeHandle> {
  const env = opts?.env ?? process.env;
  const host = opts?.host ?? "127.0.0.1";
  const port = opts?.port ?? Number(env.HANDS_PORT ?? 4319);
  const tickMs = opts?.tickMs ?? 1000;
  const booksTickMs = opts?.booksTickMs ?? 60_000;
  const assetsDir = opts?.assetsDir ?? defaultAssetsDir();
  const fileFeedbackFn =
    opts?.fileFeedback ?? ((args: { body: string; title?: string; cwd?: string }) =>
      fileFeedback({ ...args, gh: opts?.feedbackGh }));
  let feedbackRequestTimes: number[] = [];
  const store = new Store({ env });
  const db = dbPath(env);
  const shell = shellHtml(kitchenName(db));
  const config = opts?.config ?? loadConfig({ env });
  const principal = config.principal.name;
  // Multiplayer read: other handles in the books. The viewer never appends —
  // it only pulls (best-effort, on the slow tick) and reads the clone.
  const journal = openJournal({ env, config });
  let kitchens: OtherKitchen[] = [];
  let crafts: OtherCraft[] = [];
  let booksSync: BooksSyncStatus | null = journal
    ? { lastAttempt: null, lastSuccess: null, ok: true, reason: null }
    : null;
  const tokensTickMs = opts?.tokensTickMs ?? 60_000;
  const sampler = new TokenSampler(opts?.projectsDir ? { projectsDir: opts.projectsDir } : undefined);
  let tokens: TokenSeries | null = null;

  let taskCosts: Record<number, number> = {};

  const refreshTokens = (): void => {
    try {
      const peers = store.listPeers().map((p) => ({ id: p.id, cwd: p.cwd ?? null }));
      tokens = sampler.sample(peers);
      // Ticket cost ≈ the assignee pane's output tokens over the ticket's
      // working interval — an approximation by construction (whatever else
      // the pane did in that window rides along).
      const costs: Record<number, number> = {};
      const now = Date.now();
      for (const t of store.listTasks({ limit: 40 })) {
        if (!t.assignee || t.started_at == null) continue;
        costs[t.id] = sampler.usageBetween(t.assignee, t.started_at, t.finished_at ?? now).out;
      }
      taskCosts = costs;
    } catch {
      // keep the previous sample
    }
  };

  const refreshKitchens = (): void => {
    if (!journal) return;
    const now = Date.now();
    try {
      // best-effort — a failed pull leaves kitchens/crafts stale rather than
      // empty (still worth showing), but the failure itself must not vanish
      // silently (hands#59) — booksSync surfaces it either way.
      const pulled = syncPull(journal.dir);
      kitchens = readOtherKitchens(journal.dir, journal.project, journal.handle);
      crafts = readOtherCrafts(journal.dir, journal.project, journal.handle);
      booksSync = {
        lastAttempt: now,
        lastSuccess: pulled.ok ? now : (booksSync?.lastSuccess ?? null),
        ok: pulled.ok,
        reason: pulled.ok ? null : (pulled.reason ?? "error"),
      };
    } catch {
      // keep the previous kitchens/crafts read, but the attempt still counts
      booksSync = {
        lastAttempt: now,
        lastSuccess: booksSync?.lastSuccess ?? null,
        ok: false,
        reason: "error",
      };
    }
  };

  const payload = (): { json: string; key: string } => {
    const snapshot = buildSnapshot(store, Date.now(), env);
    return {
      json: JSON.stringify({
        ...snapshot,
        mode: "local",
        db,
        principal,
        kitchens,
        crafts,
        booksSync,
        tokens,
        taskCosts,
      }),
      key:
        snapshotKey(snapshot) +
        JSON.stringify(kitchens) +
        JSON.stringify(crafts) +
        JSON.stringify(booksSync) +
        JSON.stringify(tokens?.totals24h ?? null) +
        JSON.stringify(taskCosts),
    };
  };

  const clients = new Set<ServerResponse>();
  let timer: NodeJS.Timeout | null = null;
  let booksTimer: NodeJS.Timeout | null = null;
  let tokensTimer: NodeJS.Timeout | null = null;
  let lastKey = "";
  let ticks = 0;

  const tick = (): void => {
    let p: { json: string; key: string };
    try {
      p = payload();
    } catch {
      return; // a transient read failure must not kill the stream
    }
    if (p.key !== lastKey) {
      lastKey = p.key;
      for (const res of clients) res.write(`data: ${p.json}\n\n`);
    } else if (++ticks % 20 === 0) {
      for (const res of clients) res.write(`:hb\n\n`); // flush half-open sockets
    }
  };

  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/" || url.startsWith("/index")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(shell);
      return;
    }

    if (url.startsWith("/assets/")) {
      const name = url.slice("/assets/".length);
      const type = ASSETS[name];
      if (!type || !assetsDir) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      try {
        // read per request so a dev re-bundle shows up on refresh
        const body = fs.readFileSync(path.join(assetsDir, name));
        res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
      return;
    }

    if (url.startsWith("/api/events")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      try {
        const p = payload();
        lastKey = p.key;
        res.write(`data: ${p.json}\n\n`);
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
      }
      clients.add(res);
      if (!timer) timer = setInterval(tick, tickMs);
      if (journal && !booksTimer) {
        refreshKitchens(); // first viewer gets a fresh multiplayer read
        booksTimer = setInterval(refreshKitchens, booksTickMs);
      }
      if (!tokensTimer) {
        refreshTokens(); // first viewer gets a fresh burn read
        tokensTimer = setInterval(refreshTokens, tokensTickMs);
      }
      req.on("close", () => {
        clients.delete(res);
        if (clients.size === 0) {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          if (booksTimer) {
            clearInterval(booksTimer);
            booksTimer = null;
          }
          if (tokensTimer) {
            clearInterval(tokensTimer);
            tokensTimer = null;
          }
        }
      });
      return;
    }

    if (url.startsWith("/api/state")) {
      try {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(payload().json);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url.startsWith("/api/feedback")) {
      if (!isTrustedOrigin(req)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "cross-origin request rejected" }));
        return;
      }
      // Check-but-don't-yet-consume: fail fast on a request that's already
      // over the limit (skip buffering its body), but the slot itself is
      // only spent once the request passes validation below — a user
      // retrying after a typo'd title shouldn't burn through the window on
      // requests that never reached fileFeedback() at all.
      const now = Date.now();
      feedbackRequestTimes = feedbackRequestTimes.filter((t) => now - t < FEEDBACK_RATE_LIMIT_WINDOW_MS);
      if (feedbackRequestTimes.length >= FEEDBACK_RATE_LIMIT_MAX) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "too many feedback submissions — try again in a minute" }));
        return;
      }

      const chunks: Buffer[] = [];
      let tooLarge = false;
      req.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        chunks.push(chunk);
        if (chunks.reduce((n, c) => n + c.length, 0) > MAX_FEEDBACK_BODY_BYTES) {
          tooLarge = true;
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "feedback body too large" }));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (tooLarge) return;
        let parsed: { body?: unknown; title?: unknown };
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
        if (typeof parsed.body !== "string" || !parsed.body.trim()) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "body is required" }));
          return;
        }
        if (typeof parsed.title === "string" && Buffer.byteLength(parsed.title, "utf8") > MAX_FEEDBACK_TITLE_BYTES) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `title exceeds the ${MAX_FEEDBACK_TITLE_BYTES}-byte size bound` }));
          return;
        }
        // validation passed — NOW this request counts against the window
        feedbackRequestTimes.push(now);
        const title = typeof parsed.title === "string" ? parsed.title : undefined;
        let result: FeedbackResult;
        try {
          result = fileFeedbackFn({ body: parsed.body, title });
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (result.ok) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ url: result.url }));
        } else {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: result.error ?? "filing failed" }));
        }
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  // SSE requests never "finish"; Node's 5-minute default would sever them.
  server.requestTimeout = 0;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      // Best-effort — a stale/unwritable pidfile must never block the dashboard itself. Matches
      // notify.ts's 0600 convention (this file records nothing sensitive, but same posture).
      const pidFile = pidPath(env);
      try {
        fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
      } catch {
        // proceed without a pidfile — doctor/the dashboard skill just won't find one to check
      }
      resolve({
        port: boundPort,
        host,
        url: `http://${host}:${boundPort}/`,
        close: () => {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          if (booksTimer) {
            clearInterval(booksTimer);
            booksTimer = null;
          }
          if (tokensTimer) {
            clearInterval(tokensTimer);
            tokensTimer = null;
          }
          for (const res of clients) res.end();
          clients.clear();
          server.close();
          store.close();
          // Only remove a pidfile that's still ours — a second instance that raced past
          // EADDRINUSE (or a stale-pidfile cleanup elsewhere) may have already replaced it.
          try {
            if (fs.readFileSync(pidFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(pidFile);
          } catch {
            // already gone, or never written — fine either way
          }
        },
      });
    });
  });
}
