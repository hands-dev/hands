import * as fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { dbPath } from "./paths.js";
import { buildSnapshot, type Snapshot } from "./snapshot.js";
import { Store } from "./store.js";

/** The one wire shape — served by /api/state and pushed on /api/events. */
export type DashboardPayload = Snapshot & { db: string; principal: string };

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

/** Static shell; all data (including the principal) arrives via SSE/JSON. */
const SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="icon" href="data:,"/><title>yes-chef</title>
<link rel="stylesheet" href="/assets/dashboard.css"/>
</head><body><div id="root"></div>
<script type="module" src="/assets/dashboard.js"></script></body></html>
`;

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
 * Start the read-only dashboard server. Binds to localhost only. Does NOT
 * register itself as an agent — it's a viewer, not a participant. Live
 * updates ride /api/events (SSE): a lazy ~1s tick rebuilds the snapshot
 * while at least one client is connected and pushes only when it changed.
 */
export function serve(opts?: {
  port?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  /** SSE change-poll interval (test hook) */
  tickMs?: number;
  /** where dashboard.js/.css live (test hook) */
  assetsDir?: string;
}): Promise<ServeHandle> {
  const env = opts?.env ?? process.env;
  const host = opts?.host ?? "127.0.0.1";
  const port = opts?.port ?? Number(env.YES_CHEF_PORT ?? 4319);
  const tickMs = opts?.tickMs ?? 1000;
  const assetsDir = opts?.assetsDir ?? defaultAssetsDir();
  const store = new Store({ env });
  const db = dbPath(env);
  const principal = loadConfig({ env }).principal.name;

  const payload = (): { json: string; key: string } => {
    const snapshot = buildSnapshot(store, Date.now(), env);
    return { json: JSON.stringify({ ...snapshot, db, principal }), key: snapshotKey(snapshot) };
  };

  const clients = new Set<ServerResponse>();
  let timer: NodeJS.Timeout | null = null;
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
      res.end(SHELL);
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
      req.on("close", () => {
        clients.delete(res);
        if (clients.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
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
      resolve({
        port: boundPort,
        host,
        url: `http://${host}:${boundPort}/`,
        close: () => {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          for (const res of clients) res.end();
          clients.clear();
          server.close();
          store.close();
        },
      });
    });
  });
}
