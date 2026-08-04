---
name: feedback
description: Send feedback about the hands plugin to its maintainer — collects the principal's note, stamps light context (handle, repo, date), and files it as a GitHub issue on heymichaelp/hands, which lands in the maintainer's email via GitHub notifications. Use when the principal says /hands:feedback, "send feedback", "report a bug in hands", "this plugin is broken", or similar.
---

# Feedback — a note to the chef

Get the principal's feedback about hands (bug, rough edge, wish, praise) out of the
session and in front of the maintainer. The channel is a GitHub issue on the plugin's
repo — no new credentials, no config: `gh` is already the one CLI hands requires.

## Steps

1. **Collect.** If the invocation carried the feedback text, use it verbatim as the
   body. Otherwise ask the principal what they want to send — one question, their
   words, no editorializing. Distill a short title: `feedback: <gist>`.
2. **Stamp.** Append a context footer to the body — each line best-effort; a failed
   command drops the line, never blocks the send:

   ```bash
   HANDLE=$(gh api user --jq .login 2>/dev/null)
   REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)
   ```

   Footer shape: `---` then `filed by @<HANDLE> from <REPO> · <YYYY-MM-DD>`.
3. **Confirm.** Show the principal the composed title and body and get a yes before
   filing — it posts to an external tracker under their identity. They may trim it.
4. **File.**

   ```bash
   gh issue create --repo heymichaelp/hands --title "feedback: <gist>" \
     --label feedback --body "<body + footer>"
   ```

   - Label rejected (doesn't exist / no permission) → retry once without `--label`.
   - `gh` unauthenticated or no access to the repo (it may be private) → don't lose
     the note: print the composed title + body and tell the principal to pass it to
     the maintainer directly.
5. **Report.** Read the issue URL back to the principal.

## Guardrails

- Never file without the principal's explicit yes on the composed text (step 3).
- Never include secrets, env values, file contents, or transcript excerpts in the
  body — the principal's words plus the three-field footer, nothing else.
- The target repo is always `heymichaelp/hands`, never the repo the session is in.
- One issue per send; don't batch unrelated feedback into one ticket.
