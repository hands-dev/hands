# Yes, Chef

An **expo/station agent fleet for Claude Code.** The repo's main checkout runs the **expo** — the
expeditor at the pass: all of the context, none of the cooking. **Stations** are autonomous Claude
instances that know exactly two things: their **focus** (an evolving specialization) and the
**ticket** at hand. The principal — you — is the chef. Everything is coordinated over a local,
per-repo message bus with strict pass discipline, and optionally recorded in **the books**: a
durable, browsable journal.

Distributed as a Claude Code plugin (this repo is its own marketplace).

## Install

```
/plugin marketplace add heymichaelp/yes-chef
/plugin install yc@yes-chef
```

That registers everything: the MCP server (`yc_*` tools), the passive-standup hooks
(`Stop → publish`, `UserPromptSubmit → board`), the `/yc:expo` · `/yc:station` · `/yc:init`
skills, and the `yes-chef` CLI on your Bash PATH. Requires Node ≥ 22.5.

Then, per repo (from its main checkout) — one slash command:

```
/yc:init          # conversational setup: principal + optional books repo
                  # (or skip it — /yc:expo bootstraps itself on first run)
```

## Run the kitchen

```bash
/yc:expo                     # main checkout — or /loop /yc:expo for always-on
yes-chef station add -n 3    # open 3 stations (tmux/iTerm/paste-command)
yes-chef serve               # live dashboard → http://localhost:4319
```

The expo asks for **today's specials** (the ranked priorities — they change day to day with what's
available and what the day calls for), then works the pass: fires **tickets** to stations, reviews
everything that returns, escalates only what genuinely needs the chef. Ask it *"what's on the
rail?"* any time for the in-flight picture, grouped by **dish** (the external deliverable — your
Linear ticket or PR; several rail tickets usually assemble one dish; the tracker itself is **the
board**, which yes-chef references but never owns). When a dish is finished, call **hands** — the
ship step: *"get hands on PR 1234"* → reviewed, merged, deployed.

Manage the line: `yes-chef station ls` · `yes-chef scale <N>` · `yes-chef station rm station-<n>`
— or let the expo scale it (`stations.allowScaling`). Stations carry focus labels
(`station-2 · developer API`) set via `yc_focus` — addressable by label, journaled, shown
everywhere; the numeric id stays the routing key.

## How it stays cheap (wakes are the cost)

A **wake** — a `.notify` line firing a station's Monitor — costs one full model turn over that
station's entire context. The bus minimizes and meters wakes structurally:

- **Strict pass discipline, server-enforced:** stations talk only to the expo and the chef;
  station↔station sends and broadcasts are rejected *before* any write. (`topology: "open"` opts
  out.)
- **Non-waking FYIs:** `yc_send({ wake: false })` delivers on the next natural drain.
- **Burst suppression:** an undrained recipient isn't re-woken; one drain returns everything.
- **`stateHash` + one bundled read:** the expo's 15-minute utilization review short-circuits when
  nothing changed; `board({ full: true })` is one read, not four.
- **Wake accounting:** every real wake is logged and surfaced per station on the dashboard.

## The books (opt-in) — restarts, machine moves, multiplayer

Point the bus at a **separate, private** git repo and every action goes **on the books** — an
append-only event log rendered into browsable daily digest pages (repo → contributor → date):

```
yes-chef.json                                           layout marker
journal/<project>/<handle>/<date>.md                    the day's page — the primary artifact
journal/<project>/<handle>/README.md                    per-contributor index
journal/<project>/<handle>/log/<date>.<machine>.ndjson  machine event log
```

```jsonc
"remote": { "url": "git@github.com:you/yes-chef-books.git", "handle": "michael", "project": null }
```

- **Digest pages are deterministic markdown:** the expo's Notes first (see
  `yc_digest_note` — its end-of-day narrative), then per-agent sections
  (`## station-2 · developer API`): ticket lifecycle with dish refs, questions + answers,
  specials, message *counts*. Message **bodies never render** — they stay in the NDJSON layer.
  Regenerated automatically on every sync, including past days when events arrive late;
  `yes-chef digest [--date]` re-renders manually.
- **One books repo serves every project and contributor.** `project` derives from the code repo's
  origin (`owner--repo`); writers only touch their own namespace, so sync needs no merge logic.
  Digest conflicts (same handle, two machines) auto-resolve and re-render from the merged events.
- Pushes ride the turn-end hook (debounced ~1/min, offline-tolerant, never fails a bus action).
- `yes-chef restore` rebuilds the whole coordination state — tickets, questions, specials, focus,
  history — on a restart or a new machine. **If it's not on the books, it didn't happen; you also
  can't cook them** (append-only by construction).
- **Shape is validated, never assumed:** empty repos self-initialize; a repo with other content is
  refused until an explicit `yes-chef sync --adopt`; a layout newer or older than this build fails
  loudly.
- **Open books = multiplayer.** Two people pointing at one books repo each write their own pages
  and read each other's — the whole cross-kitchen story is "every kitchen keeps its book; skim the
  other kitchens' pages." (A dashboard lane for that is the natural next phase.)
- **Plaintext.** Private repo only; never put secrets on the bus.

## Configuration

`yes-chef.config.json` at the repo root (user fallback `~/.claude/yes-chef.config.json`).
Scaffold it with `yes-chef init`; attach the books to an existing config with
`yes-chef books <url> [--handle <name>]`:

```jsonc
{
  "principal": { "name": "Michael" },          // the chef
  "topology":  "strict-hub",                   // or "open"
  "expo":      { "basename": null },           // null = main-worktree autodetect
  "stations": {
    "model": "sonnet",                         // default tier
    "overrides": { "station-4": "opus" },      // per-station tier
    "launcher": "auto",                        // auto | tmux | iterm | manual
    "worktreeRoot": null,                      // null = ~/.yes-chef/worktrees/<slug>
    "baseBranch": null,                        // null = current HEAD of the main checkout
    "allowScaling": true                       // may the expo open/close stations itself
  },
  "merge":  { "adminMergeLowRisk": false },    // may the expo admin-merge low-risk PRs
  "remote": { "url": null, "handle": null, "project": null },   // the books (opt-in)
  "gh":     { "poll": true }
}
```

Each git repo gets its own isolated bus automatically;
`yc_paths` (or `yes-chef paths`) shows where anything resolves, including books sync health.

## Choosing an execution pattern

The expo picks **per ticket**, never by habit: **durable sub-agents** (session-scoped, hub-and-
spoke, per-spawn cheap-model overrides, resumable mid-session) for work that decomposes and
converges; **stations** for isolated parallel file-writes, cross-session persistence, and
independent ownership. Three questions decide — parallel file mutation? cross-session ownership?
converging vs independent stream? Default to sub-agents; escalate to a station when the answer
says so.

## Repo layout

```
plugin/          the Claude Code plugin (manifest, .mcp.json, hooks, skills, bin, committed bundles)
engine/          the TypeScript source + tests (bundled into plugin/dist by `npm run bundle`)
SETUP.md         dev setup · BOOTSTRAP.md  restore-a-machine runbook
```

Development: `cd engine && npm install && npm run test:run`. After changing `src/`, run
`npm run bundle` — installs execute the committed bundles, and `bundle.test.ts` fails when stale.
