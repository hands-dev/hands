---
name: init
description: Set up yes-chef for THIS repo from inside Claude Code — scaffolds yes-chef.config.json (principal, optional books/durable-journal repo). Use when the principal says /yc:init, "set up yes-chef here", "initialize the bus for this repo", or when a yes-chef skill finds no config. Conversational wrapper over the `yes-chef init` CLI (and `yes-chef books` for attaching the books later).
---

# Init — set up yes-chef for this repo

Configure yes-chef for the current repo without leaving the session. You collect the answers
conversationally, then drive the CLI non-interactively — never hand-write the config file; the CLI
owns the format.

## Steps

1. **Locate + check.** Call `yc_paths`. If `repoRoot` is null, stop: yes-chef is per-repo —
   ask the principal to open the session in a git repo's main checkout. If
   `<repoRoot>/yes-chef.config.json` already exists (one Bash `test -f`), say so and show its
   contents. The one late addition with a CLI path is the books:
   `yes-chef books <url> [--handle <name>]` attaches them to an existing config. For any other
   field, edit the file directly (plain JSON, documented in the README).
2. **Ask two questions** (in chat, together):
   - **Who is the principal?** — the human the expo reports to — the chef. Default: the user you're
     talking to; use the name they go by.
   - **The books?** — optional but recommended: a **separate, private, empty** git repo
     (e.g. `git@github.com:<them>/yes-chef-books.git`). It keeps coordination state so it survives
     restarts and machine moves, and renders browsable daily digest pages. If they want it but the repo
     doesn't exist yet, create it first (`gh repo create <name> --private`) with their go-ahead.
     Skipping is fine — attach later with `yes-chef books <url>`.
   - If a books url was given, also confirm the **handle** (their contributor namespace in the
     books — default their OS username / first name, lowercase).
3. **Run the CLI** (Bash — quote everything):

   ```
   yes-chef init --yes --principal "<name>" [--journal "<url>" --handle "<handle>"]
   ```

   `--yes` makes it non-interactive. Idempotent — an existing config is left untouched on re-runs.
4. **Confirm + hand off.** Echo the ✔ lines, then point at the next step:
   *"Run `/yc:expo` here to work the pass (or `/loop /yc:expo` for always-on)."*
   If they configured the books, note that the first sync initializes the repo's structure
   automatically.

## Guardrails

- Never write `yes-chef.config.json` by hand on first setup — always via the CLI. The sanctioned
  late edits: `yes-chef books <url>` for the books; direct JSON edits for other fields on an
  existing config.
- Never invent a books url; if unsure whether the repo exists, check with `gh repo view`.
- The books repo must be private — plaintext coordination bodies live there. Say so when asking.
