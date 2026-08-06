---
name: hands
description: Print everything currently waiting on the principal — open to-do items and unanswered needs_human escalations, grouped by priority and terse. Invocable directly in any session, not routed through a running expo loop. Use when the principal says /hands:hands, "what needs my hands?", "what's waiting on me?", or wants the operator queue without opening the dashboard.
---

# Hands — what's waiting on the operator

Print the concrete things only the principal can do right now — a merge click, a decision, a
reply they owe — the same items the dashboard's "Needs you" lane renders from. This is a
**read-only viewer**: never register on the bus, never mutate anything.

## Steps

1. **Two calls, same source the dashboard uses:**
   - `hands_todos({ state: "open" })` — the expo-managed personal to-do list (merge clicks, PRs
     needing a click, returned plans awaiting product judgment).
   - `hands_questions({ state: "needs_human" })` — escalations the expo bubbled up that the
     principal hasn't answered yet (`hands_answer` clears them; `answered` state is excluded by
     the query itself, so everything returned here is genuinely still open).

   Don't derive either list from `hands_board` or anywhere else — these two calls are the whole
   data source, matching what the dashboard's needs-you lane and to-do panel read from.

2. **Group by priority, terse, one line per item:**

   ```
   Needs you —
   P1: <todo title or question text> [· <origin/PR#/dedupKey>]
   P1: <...>
   P2: <...>
   (unranked): <...>
   ```

   - Todos: `priority` field for the group key, `title` for the line text, `origin` appended
     after `·` when present (a PR#, question id, or similar).
   - Needs-human questions: `priority` for the group key, the `question` text for the line
     (truncate to ~60 chars if it runs long); append `— <recommendation>` when the expo left one,
     since that's the fast path to a yes/no.
   - Items with no `priority` set fall into an `(unranked)` group, listed last.
   - Preserve each source's own ordering within a group — todos already come open-first,
     most-recently-touched; questions come by ask order. Don't re-sort by anything else.
   - Nothing in either list → print `Needs you — nothing waiting on you` and stop; don't print an
     empty grouped block.

3. **Print it verbatim** — no extra commentary. Same grep-friendly, no-prose-wrapper convention
   as `/hands:rail`.

## Guardrails

- Read-only. Never call `hands_todo_update`, `hands_answer`, or anything else that resolves an
  item — surfacing is this command's whole job; resolving is the principal's (or the expo's, on
  their behalf).
- Exactly the two calls above — if you find something the dashboard's needs-you lane shows that
  neither `hands_todos` nor `hands_questions` exposes, flag the gap rather than adding a third
  query path.
