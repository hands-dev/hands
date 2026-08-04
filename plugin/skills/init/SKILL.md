---
name: init
description: Set up hands for THIS repo from inside Claude Code — scaffolds hands.config.json (principal, optional books/durable-journal repo). Use when the principal says /hands:init, "set up hands here", "initialize the bus for this repo", or when a hands skill finds no config. Conversational wrapper over the `hands init` CLI (and `hands books` for attaching the books later).
---

# Init — set up hands for this repo

Configure hands for the current repo without leaving the session. You collect the answers
conversationally, then drive the CLI non-interactively — never hand-write the config file; the CLI
owns the format.

## Steps

1. **Locate + check.** Call `hands_paths`. If `repoRoot` is null, stop: hands is per-repo —
   ask the principal to open the session in a git repo's main checkout. If
   `<repoRoot>/hands.config.json` already exists (one Bash `test -f`), say so and show its
   contents. The one late addition with a CLI path is the books:
   `hands books <url> [--handle <name>]` attaches them to an existing config. For any other
   field, edit the file directly (plain JSON, documented in the README).
2. **Ask two questions** (in chat, together):
   - **Who is the principal?** — the human the expo reports to — the chef. Default: the user you're
     talking to; use the name they go by.
   - **The books?** — optional but recommended: a **separate, private, empty** git repo
     (e.g. `git@github.com:<them>/hands-books.git`). It keeps coordination state so it survives
     restarts and machine moves, and renders browsable daily digest pages. If they want it but the repo
     doesn't exist yet, create it first (`gh repo create <name> --private`) with their go-ahead.
     Skipping is fine — attach later with `hands books <url>`.
   - If a books url was given, also confirm the **handle** (their contributor namespace in the
     books — the CLI defaults it to their GitHub username via `gh`, falling back to the OS
     username).
3. **Run the CLI** (Bash — quote everything):

   ```
   hands init --yes --principal "<name>" [--journal "<url>" --handle "<handle>"]
   ```

   `--yes` makes it non-interactive. Idempotent — an existing config is left untouched on re-runs.
4. **Confirm + hand off.** Echo the ✔ lines, then point at the next step:
   *"Run `/hands:expo` here to work the pass (or `/loop /hands:expo` for always-on)."*
   If they configured the books, note that the first sync initializes the repo's structure
   automatically.

## Guardrails

- Never write `hands.config.json` by hand on first setup — always via the CLI. The sanctioned
  late edits: `hands books <url>` for the books; direct JSON edits for other fields on an
  existing config.
- Never invent a books url; if unsure whether the repo exists, check with `gh repo view`.
- The books repo must be private — plaintext coordination bodies live there. Say so when asking.
