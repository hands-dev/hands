# engine/ — the yes-chef engine

TypeScript source for the yes-chef coordination bus: the stdio MCP server
(`src/server.ts`), the provisioning CLI (`src/cli.ts`), the SQLite store, the
books journal (`src/remote.ts`), and the dashboard. The product story — the
expo/station model, the pass, the books — lives in the [root README](../README.md).

## Develop

```bash
npm install
npm run test:run      # vitest, full suite
npm run check-types   # tsc --noEmit
npm run bundle        # rebuild plugin/dist (COMMITTED — bundle.test.ts fails when stale)
```

The plugin executes the committed bundles in `../plugin/dist/` — a plugin
install is a plain copy with no npm step — so every `src/` change must be
followed by `npm run bundle`.

## Layout

```
src/server.ts     MCP server + yc_* tools (identity derived per-cwd at runtime)
src/store.ts      shared SQLite (WAL) — one DB per repo slug
src/cli.ts        yes-chef CLI (init, books, station, scale, sync, restore, serve, paths)
src/provision.ts  managed station worktrees + launchers
src/remote.ts     the books — append-only NDJSON journal + digest rendering
src/dashboard.ts  read-only dashboard (yes-chef serve)
```

`DESIGN.md` is the original build plan, kept as a historical artifact — it
predates the yes-chef naming.
