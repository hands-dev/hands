---
name: feedback
description: Send feedback about the hands plugin to its maintainer — collects the principal's note, stamps light context (handle, repo, date), and files it as a GitHub issue on hands-dev/hands, which lands in the maintainer's email via GitHub notifications. Use when the principal says /hands:feedback, "send feedback", "report a bug in hands", "this plugin is broken", or similar.
---

# Feedback — a note to the chef

Get the principal's feedback about hands (bug, rough edge, wish, praise) out of the
session and in front of the maintainer. The channel is a GitHub issue on the plugin's
repo, filed via `hands feedback` — the same CLI command the dashboard's own feedback
form calls (engine/src/feedback.ts), so the filing mechanics (context footer, target
repo, label-fallback retry) live in exactly one place, not duplicated here.

## Steps

1. **Collect.** If the invocation carried the feedback text, use it verbatim as the
   body. Otherwise ask the principal what they want to send — one question, their
   words, no editorializing. Distill a short title: `feedback: <gist>`.
2. **Confirm.** Show the principal the composed title and body and get a yes before
   filing — it posts to an external tracker under their identity. They may trim it.
3. **File.**

   ```bash
   hands feedback "<body>" --title "feedback: <gist>"
   ```

   `hands feedback` stamps the context footer itself (`filed by @<handle> from
   <repo> · <date>`, each field best-effort), always targets `hands-dev/hands`
   regardless of which repo the session is in, and retries once without the
   `feedback` label if it's rejected (doesn't exist / no permission) — none of that
   needs re-deriving here. If it fails outright (`gh` unauthenticated, no access),
   don't lose the note: print the composed title + body and tell the principal to
   pass it to the maintainer directly.
4. **Report.** Read the issue URL `hands feedback` printed back to the principal.

## Guardrails

- Never file without the principal's explicit yes on the composed text (step 2).
- Never include secrets, env values, file contents, or transcript excerpts in the
  body — the principal's words plus the command's own footer, nothing else.
- One issue per send; don't batch unrelated feedback into one ticket.
