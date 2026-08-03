---
name: init
description: Set up roundhouse for THIS repo from inside Claude Code — scaffolds agent-bus.config.json (principal, optional durable-journal repo), cleans up any pre-plugin install, and offers legacy-state migration. Use when the principal says /rh:init, "set up roundhouse here", "initialize the bus for this repo", or when a roundhouse skill finds no config. Conversational wrapper over the `roundhouse init` CLI.
---

# Init — set up roundhouse for this repo

Configure roundhouse for the current repo without leaving the session. You collect the answers
conversationally, then drive the CLI non-interactively — never hand-write the config file; the CLI
owns the format, the pre-plugin cleanup, and the migration logic.

## Steps

1. **Locate + check.** Call `agent_bus_paths`. If `repoRoot` is null, stop: roundhouse is per-repo —
   ask the principal to open the session in a git repo's main checkout. If
   `<repoRoot>/agent-bus.config.json` already exists (one Bash `test -f`), say so, show its
   contents, and stop — offer to edit specific fields instead (edit the file directly for that;
   it's plain JSON documented in the README).
2. **Ask two questions** (in chat, together):
   - **Who is the principal?** — the human the foreman reports to. Default: the user you're
     talking to; use the name they go by.
   - **Durable journal?** — optional but recommended: a **separate, private, empty** git repo
     (e.g. `git@github.com:<them>/roundhouse-state.git`). It makes coordination state survive
     restarts and machine moves, and renders browsable daily digests. If they want it but the repo
     doesn't exist yet, create it first (`gh repo create <name> --private`) with their go-ahead.
     Skipping is fine — it can be enabled later by re-running this with the url.
   - If a journal url was given, also confirm the **handle** (their contributor namespace in the
     journal — default their OS username / first name, lowercase).
3. **Run the CLI** (Bash — quote everything):

   ```
   roundhouse init --yes --principal "<name>" [--journal "<url>" --handle "<handle>"] [--migrate]
   ```

   `--yes` makes it non-interactive: pre-plugin cleanup runs default-yes (removes old user-scope
   MCP/hooks/skills so nothing double-fires against the plugin), and legacy coordination-dir
   migration is SKIPPED unless you pass `--migrate`. If the CLI output mentions legacy files were
   left in place, relay that and ask whether to migrate; if yes, re-run
   `roundhouse init --yes --migrate` (idempotent — config is left untouched on re-runs).
4. **Confirm + hand off.** Echo the ✔ lines, then point at the next step:
   *"Run `/rh:foreman` here to start the command center (or `/loop /rh:foreman` for always-on)."*
   If they configured a journal, note that the first sync initializes the journal repo's structure
   automatically.

## Guardrails

- Never write `agent-bus.config.json` by hand — always via the CLI (it owns cleanup + migration).
- Never invent a journal url; if unsure whether the repo exists, check with `gh repo view`.
- The journal repo must be private — plaintext coordination bodies live there. Say so when asking.
