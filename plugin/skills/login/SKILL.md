---
name: login
description: Sign the local hands plugin in with GitHub (browser-handoff OAuth against the hands cloud) so it knows who you are, your subscription tier, and where your cloud books/dashboard live. Entirely optional — free tier never needs an account, and every other hands command works identically whether or not you're signed in. Use when the principal says /hands:login, "sign in to hands", "connect my GitHub account", "what's my hands account", or when a skill needs to know the signed-in identity.
---

# Login — sign in with GitHub (optional)

`hands login` is a thin, non-interactive CLI flow (`engine/src/login.ts`) that authenticates
against the same Descope-backed identity the hosted books MCP uses — one identity spine, not a
second account system. This skill is a conversational wrapper: explain what's about to happen,
run the CLI, relay the result.

## Steps

1. **Check current status first.** Run `hands whoami` (Bash) — it's local-only, no network call,
   safe to run anytime. If already signed in, tell the principal who as (`<login> (<tier> tier)`)
   and stop; don't re-run login underneath them. If they explicitly want to switch accounts, point
   at `hands logout` first, then re-run this skill.
2. **Set expectations before running the flow** — `hands login` opens a real browser and blocks
   until the principal finishes signing in there, or the flow fails. Say so plainly: *"I'll run
   `hands login` — it opens your browser to sign in with GitHub. Go through that, then come back
   here."* Don't run it silently.
3. **Run `hands login`** (Bash). It prints the authorization URL it opened (useful if the browser
   didn't auto-open — non-macOS hosts don't auto-open at all, by design) and, on success,
   `✔ signed in as <login> (<tier> tier)`. On failure it exits non-zero with a `hands: <reason>`
   message — relay that reason verbatim; don't guess at what went wrong.
4. **Offer to wire the books, don't auto-apply.** If inside a repo whose `hands.config.json` has
   no `remote.url` set (check via `hands paths`, or read the file), and the sign-in resolved a
   cloud books repo (a successful `hands whoami` after login implies one might exist), ask: *"Want
   me to point this repo's books at your cloud repo, or would you rather set that up yourself with
   `hands books <url>`?"* Only run `hands books <url>` if they say yes — this is the same
   "hand-edited config always wins, login only fills gaps" rule the CLI itself follows
   (`engine/src/config.ts`), applied at the conversational layer too.
5. **Confirm and hand off.** Summarize what changed; mention `hands logout` clears the local
   sign-in anytime, and that nothing else about hands' behavior depends on being signed in.

## Guardrails

- Never claim login is required for anything — free tier is fully functional with zero account.
  If a principal seems to think they need to sign in to use stations/books/the dashboard, correct
  that gently.
- Never silently rewrite `hands.config.json`'s `remote.url` — always ask first (step 4).
- If `hands login` hangs (browser never completed), it's waiting on the principal, not broken —
  say so rather than assuming failure; they can Ctrl-C and re-run when ready.
- Credentials live in `~/.hands/credentials.json`, not this repo and not `~/.claude/` — never read
  or print its contents; `hands whoami` is the sanctioned way to check identity.
