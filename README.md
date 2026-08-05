# Hands

**Extra hands for your repo.** An expo/station agent fleet for Claude Code, run like a kitchen:
the repo's main checkout is the **expo** — the expeditor at the pass, all of the context and none
of the cooking. **Stations** are autonomous Claude instances that know exactly two things: their
**focus** (an evolving specialization) and the **ticket** at hand. The principal — you — is the
chef. Everything is coordinated over a local, per-repo message bus with strict pass discipline,
and optionally recorded in **the books**: a durable, browsable journal. The fleet is Hands — and
calling *"hands"* on a finished dish is how you summon them to ship it.

Distributed as a Claude Code plugin (this repo is its own marketplace).

## Install

```
/plugin marketplace add hands-dev/hands
/plugin install hands@hands
```

That registers everything: the MCP server (`hands_*` tools), the passive-standup hooks
(`Stop → publish`, `UserPromptSubmit → board`), the `/hands:expo` · `/hands:station` · `/hands:init` ·
`/hands:crafts` · `/hands:dashboard` · `/hands:feedback` skills, and the `hands` CLI on your
Bash PATH. Requires Node ≥ 22.5.

Then, per repo (from its main checkout) — one slash command:

```
/hands:init       # conversational setup: principal + optional books repo
                  # (or skip it — /hands:expo bootstraps itself on first run)
```

## Run the kitchen

```bash
/hands:expo               # main checkout — or /loop /hands:expo for always-on
hands station add -n 3    # open 3 stations (tmux/iTerm/paste-command)
/hands:dashboard          # live admin dashboard (SSE) → http://localhost:4319  (or: hands serve)
                          # incl. per-pane token burn, read from Claude Code's own transcripts
/hands:feedback           # hit a rough edge? files your note as a GitHub issue for the maintainer
```

The expo asks for **today's specials** (the ranked priorities — they change day to day with what's
available and what the day calls for), then works the pass: fires **tickets** to stations, reviews
everything that returns, escalates only what genuinely needs the chef. Ask it *"what's on the
rail?"* any time for the in-flight picture, grouped by **dish** (the external deliverable — your
Linear ticket or PR; several rail tickets usually assemble one dish; the tracker itself is **the
board**, which hands references but never owns). When a dish is finished, call **hands** — the
ship step: *"get hands on PR 1234"* → reviewed, merged, deployed.

Manage the line: `hands station ls` · `hands scale <N>` · `hands station rm station-<n>`
— or let the expo scale it (`stations.allowScaling`). A station holds a **craft** — the named,
portable specialization (`station-2 · saucier`) assigned via `hands_focus`, addressable by label,
journaled, shown everywhere; the numeric id stays the routing key. Crafts hot-swap between seats:
move the saucier to the poissonnier's station and the whole skillset moves too. Not sure what
crafts your repo warrants? `/hands:crafts` surveys the codebase and proposes a tight roster — or
tells you honestly that the kitchen is small and doesn't need one.

## How it stays cheap (wakes are the cost)

A **wake** — a `.notify` line firing a station's Monitor — costs one full model turn over that
station's entire context. The bus minimizes and meters wakes structurally:

- **Strict pass discipline, server-enforced:** stations talk only to the expo and the chef;
  station↔station sends and broadcasts are rejected *before* any write. (`topology: "open"` opts
  out.)
- **Non-waking FYIs:** `hands_send({ wake: false })` delivers on the next natural drain.
- **Burst suppression:** an undrained recipient isn't re-woken; one drain returns everything.
- **`stateHash` + one bundled read:** the expo's 15-minute utilization review short-circuits when
  nothing changed; `board({ full: true })` is one read, not four.
- **Wake accounting:** every real wake is logged and surfaced per station on the dashboard.

## The books (opt-in) — restarts, machine moves, multiplayer

Point the bus at a **separate, private** git repo and every action goes **on the books** — an
append-only event log rendered into browsable daily digest pages (repo → contributor → date):

```
hands.json                                           layout marker
journal/<project>/<handle>/<date>.md                    the day's page — the primary artifact
journal/<project>/<handle>/README.md                    per-contributor index
journal/<project>/<handle>/log/<date>.ndjson             the day's event log
journal/<project>/<handle>/crafts/<name>.md              a craft's prep book (self-managed)
journal/<project>/<handle>/crafts/<name>.skill.md        a craft's own SKILL (self-managed)
```

```jsonc
"remote": { "url": "git@github.com:you/hands-books.git", "handle": "michael", "project": null }
```

- **Digest pages are deterministic markdown:** the expo's Notes first (see
  `hands_digest_note` — its end-of-day narrative), then per-agent sections
  (`## station-2 · developer API`): ticket lifecycle with dish refs, questions + answers,
  specials, message *counts*. Message **bodies never render** — they stay in the NDJSON layer.
  Regenerated automatically on every sync, including past days when events arrive late;
  `hands digest [--date]` re-renders manually.
- **One books repo serves every project and contributor.** `project` is the code repo's name
  (from its origin; `remote.project` disambiguates same-named repos); the handle defaults to your
  GitHub username. Writers only touch their own namespace, so sync needs no merge logic. Digest
  conflicts auto-resolve and re-render from the merged events; one handle = one machine writing at
  a time (concurrent same-day appends on a shared handle conflict loudly rather than merge).
- Pushes ride the turn-end hook (debounced ~1/min, offline-tolerant, never fails a bus action).
- `hands restore` rebuilds the whole coordination state — tickets, questions, specials, focus,
  history — on a restart or a new machine. **If it's not on the books, it didn't happen; you also
  can't cook them** (append-only by construction).
- **Shape is validated, never assumed:** empty repos self-initialize; a repo with other content is
  refused until an explicit `hands sync --adopt`; a layout newer or older than this build fails
  loudly.
- **Crafts mature on their own.** A **craft** is a named, portable specialization — what a chef
  de partie carries between stations. Each craft self-curates a **prep book** (distilled
  knowledge) and its own **craft skill** (its operating manual) under the contributor's
  namespace, keyed by the craft's name, not the seat. The server injects both into whichever
  station holds the craft, so a rebooted, machine-moved, or newly-assigned station comes up
  already knowing the craft. Digests never render them: the shared narrative stays the expo's;
  each kitchen's crafts mature under its own handle.
- **Open books = multiplayer.** Two people pointing at one books repo each write their own pages
  and read each other's — the whole cross-kitchen story is "every kitchen keeps its book; skim the
  other kitchens' pages." The dashboard's **Other kitchens** panel shows the rest of the books
  live.
- **Plaintext.** Private repo only; never put secrets on the bus.

## Configuration

`hands.config.json` at the repo root (user fallback `~/.claude/hands.config.json`).
Scaffold it with `hands init`; attach the books to an existing config with
`hands books <url> [--handle <name>]`:

```jsonc
{
  "principal": { "name": "Michael" },          // the chef
  "topology":  "strict-hub",                   // or "open"
  "expo":      { "basename": null },           // null = main-worktree autodetect
  "stations": {
    "model": "sonnet",                         // default tier
    "overrides": { "station-4": "opus" },      // per-station tier
    "launcher": "auto",                        // auto | tmux | iterm | manual
    "worktreeRoot": null,                      // null = ~/.hands/worktrees/<slug>
    "baseBranch": null,                        // null = current HEAD of the main checkout
    "allowScaling": true                       // may the expo open/close stations itself
  },
  "merge":  { "adminMergeLowRisk": false },    // may the expo admin-merge low-risk PRs
  "remote": { "url": null, "handle": null, "project": null },   // the books (opt-in)
  "gh":     { "poll": true }
}
```

Each git repo gets its own isolated bus automatically;
`hands_paths` (or `hands paths`) shows where anything resolves, including books sync health.

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
