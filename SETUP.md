# yes-chef — setup

> **Normal install is the plugin — see [README.md](README.md).** Two slash commands, then
> `yes-chef init` per repo. This file covers development setup and the manual bits the plugin
> doesn't own.

## Development setup

```bash
cd engine
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

## Per-repo pieces (what `yes-chef init` handles)

- `yes-chef.config.json` scaffold at the repo root — principal, topology, station tiers/launcher,
  optional books journal (`remote.url` + `remote.handle`). Full reference in README. Attach the
  books to an existing config later with `yes-chef books <url>`.

## Optional extras (not plugin-managed)

`claude-config/` holds reference config from the original setup — a memory-autocommit
`PostToolUse` hook and a statusline script. Merge into `~/.claude/settings.json` by hand if
wanted; fix the `ABS_PATH…` placeholders.

## Seed priorities (optional)

```bash
cp coordination/priorities.example.md "$(yes-chef paths | jq -r .coordinationDir)/priorities.md"
```

Or just answer the expo when it asks for the day's ranked priorities.

## Two repos side by side

Nothing to do — each repo's bus auto-scopes by git common-dir. Run `yes-chef init` in each repo
for its config; the plugin registration is machine-wide. `YES_CHEF_HOME` pins a bus location
explicitly if you ever need to.
