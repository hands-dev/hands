---
name: questions
description: Surface every escalation waiting on the principal through Claude Code's native AskUserQuestion dialog — structured options, recommendation first, batched up to 4 per dialog — and write the answer straight back to the bus. The local view of the shared record (hands#84/#162): same questions, same options, any surface would show, just rendered natively for whoever is watching this terminal right now. Use when the principal says /hands:questions, "what needs my answer", "go through the open questions", or wants to clear escalations from the terminal rather than the dashboard.
---

# Questions — the AskUserQuestion surface on the shared record

Pull every escalation the expo bubbled up (`state: "needs_human"`), present the structured ones
through the native `AskUserQuestion` dialog — one dialog costs one interaction, even for several
decisions at once — and write each answer back to the bus via `hands_answer`. This command
**writes**, unlike `/hands:rail` and `/hands:hands`: answering is its whole job, not a side
effect. The record stays the source of truth; this is one more renderer over it, same as the
dashboard's buttons.

## Steps

1. **Pull the queue.** `hands_questions({ state: "needs_human" })`. Nothing open → print
   `Questions — nothing waiting on you` and stop.

2. **Split into structured vs free-text.** A question has `options` (2-4 entries) or it doesn't.
   `AskUserQuestion` wants concrete choices, not an open prompt — forcing a genuinely open-ended
   question into it by inventing fake options would misrepresent what the asker actually offered
   (hands#84's plan explicitly rejected this). So:
   - **Has `options`** → goes through the dialog (step 3).
   - **No `options`** → list it as plain text instead, same one-line style as `/hands:hands`:
     `#<id> <asker>: <question>` (+ `— <recommendation>` if the expo left one), with a pointer —
     "answer these in chat with the expo." Print this block after the dialog work in step 5,
     never silently drop them.

3. **Build the dialog batch(es).** Up to 4 structured questions per `AskUserQuestion` call — a
   hard limit the tool itself enforces (`questions[]` maxItems 4), not just pacing. More than 4 →
   multiple sequential calls. For each question, build one `questions[]` entry:
   - `question`: the record's `question` text.
   - `header`: a short chip label — derive from `priority` if set (e.g. `"P1"`), else truncate the
     question to ~12 chars.
   - `multiSelect`: the record's `multiSelect`.
   - `options`: map the record's `options` 1:1 to `{ label, description }`, **except**: move the
     option with `recommended: true` (if any) to the front, and append literal `" (Recommended)"`
     to its `label`. `AskUserQuestion` has no native recommended field — ordering-plus-suffix is
     the only way to convey it, per the tool's own documented convention. Keep a mapping from
     *this authored label* back to the *original option label* (strip the suffix) for step 4 —
     you'll need it to reconstruct what was actually chosen.

4. **Parse what came back.** `AskUserQuestion` returns one string per question (`answers`, keyed
   by the question text), even for `multiSelect` — it does not hand you a clean array. For each
   question's returned string:
   - Split on `", "` and map each piece back through the label mapping from step 3 (stripping
     `" (Recommended)"` before comparing). If every piece matches a known option, that's your
     `chosenLabels` — pass to `hands_answer` as `chosenLabels`, not `answer`.
   - If any piece doesn't match a known label, the operator used the dialog's built-in "Other"
     free-text escape hatch — pass the **whole returned string** as `answer` instead (don't try
     to split or salvage a partial label match out of it).

5. **Write each answer back.** `hands_answer({ id, chosenLabels, by: "human", answeredVia: "tui" })`
   (or `answer` for the free-text path). No need to pass `priority` — omitting it preserves
   whatever the expo already set at escalation time. **Check the result** — don't assume success:
   - `ok: true` → done, move to the next.
   - `ok: false, reason: "already-answered"` → someone else (the dashboard, most likely) answered
     it first while this dialog was open. Tell the operator plainly, don't retry, don't silently
     drop it: `#<id> was already answered — <resolvedBy> via <answeredVia>: <existing answer>`.
     This is the same bar the dashboard's toast and the MCP tool's own response hold (hands#84):
     the loser learns who won and what they answered, not just that it lost.

6. **Print a short summary** — what got answered, what lost a race, and the free-text list from
   step 2. No extra commentary beyond that; this command's job is to clear the queue, not narrate.

## Guardrails

- Never invent options for a free-text question to force it through the dialog — list it as plain
  text instead (step 2). A dialog that offers fake choices misrepresents the asker's actual ask.
- Always check `hands_answer`'s return before reporting an answer as landed — the concurrent-answer
  race (hands#84) is real now that the dashboard can also answer the same escalation.
- One `hands_questions` call for the pull, `hands_answer` once per question actually answered —
  don't re-derive the queue from `hands_board` or anywhere else.
