import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { dashboardHtml } from "./dashboard.js";
import { dbPath } from "./paths.js";
import { buildSnapshot } from "./snapshot.js";
import { Store } from "./store.js";

export interface ServeHandle {
  port: number;
  host: string;
  url: string;
  close: () => void;
}

/**
 * Start the read-only dashboard server. Binds to localhost only. Does NOT
 * register itself as an agent — it's a viewer, not a participant.
 */
export function serve(opts?: {
  port?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ServeHandle> {
  const env = opts?.env ?? process.env;
  const host = opts?.host ?? "127.0.0.1";
  const port = opts?.port ?? Number(env.YES_CHEF_PORT ?? 4319);
  const store = new Store({ env });
  const db = dbPath(env);
  const html = dashboardHtml(loadConfig({ env }).principal.name);

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url.startsWith("/index")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (url.startsWith("/api/state")) {
      try {
        const snapshot = buildSnapshot(store);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ...snapshot, db }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve({
        port,
        host,
        url: `http://${host}:${port}/`,
        close: () => {
          server.close();
          store.close();
        },
      });
    });
  });
}
