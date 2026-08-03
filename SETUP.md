# agent-bus — setup

> **Normal install is the plugin — see [README.md](README.md).** Two slash commands, then
> `agent-bus init` per repo. This file covers development setup and the manual bits the plugin
> doesn't own.

## Development setup

```bash
cd agent-bus
npm install
npm run test:run        # 100+ tests
npm run check-types
npm run bundle          # rebuild the COMMITTED plugin bundles (plugin/dist) after editing src/
```

The plugin executes the committed bundles in `plugin/dist` — not your working tree. Forgetting
`npm run bundle` after a src/ change is the classic mistake; `bundle.test.ts` fails when the
bundles are stale.

Test a local build without installing:

```bash
claude --plugin-dir ./plugin        # loads MCP server + hooks + skills from the working tree
claude plugin validate ./plugin     # manifest sanity
claude plugin validate .            # marketplace sanity
```

## Per-repo pieces (what `agent-bus init` handles)

- `agent-bus.config.json` scaffold at the repo root — principal, topology, worker tiers/launcher,
  optional journal (`remote.url` + `remote.handle`). Full reference in README.
- **Pre-plugin cleanup:** removes an old user-scope `mcpServers["agent-bus"]`, old
  `server.js publish|board` hooks, and copied `~/.claude/skills/{foreman,worker}` so nothing
  double-fires against the plugin's registrations.
- **Legacy migration:** offers to move a pre-isolation `~/.claude/coordination/*` state into the
  repo's slug-scoped bus dir.

## Optional extras (not plugin-managed)

`claude-config/` holds reference config from the original setup — a memory-autocommit
`PostToolUse` hook and a statusline script. Merge into `~/.claude/settings.json` by hand if
wanted; fix the `ABS_PATH…` placeholders.

## Seed priorities (optional)

```bash
cp coordination/priorities.example.md "$(agent-bus paths | jq -r .coordinationDir)/priorities.md"
```

Or just answer the foreman when it asks for the day's ranked priorities.

## Two repos side by side

Nothing to do — each repo's bus auto-scopes by git common-dir. Run `agent-bus init` in each repo
for its config; the plugin registration is machine-wide. `AGENT_BUS_HOME` pins a bus location
explicitly if you ever need to.
