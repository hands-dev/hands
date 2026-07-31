---
name: feedback_native_todo_delete_on_complete
description: "Native Claude Code task list: delete tasks on completion (not mark-completed) AND keep a contiguous numbered prefix (1..N) on every task, renumbering on add/remove."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8b3a496c-bd42-4eb7-934b-b9020d7b1621
---

When mirroring Michael's to-dos into the **native Claude Code task list** (the foreman pane's
checklist, managed via TaskCreate/TaskUpdate), **DELETE a task the instant it's crossed off** —
`TaskUpdate status=deleted`, not `completed`. He does not want finished items lingering as
checked-off clutter; the native list should show ONLY pending/active tasks.

**Why:** it keeps his to-do view visually clean — he only wants what's left to do.

**The list is THE surface for "what am I waiting on you for."** Michael (2026-07-31): "keep your
todo list updated as you pause and wait for me for things … it's hard to know out of the wall of
text what calls you're actually waiting on. Tasks are the best surface for that." So: the native
list must, at all times, contain EXACTLY the decisions/clicks the foreman is genuinely blocked on
Michael for (a merge word, an in-pane approval, a go/no-go) — nothing more, nothing less. Add a
task the moment you pause for him; delete it the moment it resolves. Do NOT list things the foreman
is handling itself, things already delegated/flowing, or future-gated items that aren't pending yet
— those live in prose, not on his list. Prose can be a wall of text; the task list is the crisp
"here's what you owe."

**Numbered prefixes:** every task subject carries a **contiguous number prefix starting at 1**
("1. …", "2. …"). Claude Code's internal task IDs do NOT renumber when one is deleted (delete #1
and the rest stay #2–#5), so put the number in the SUBJECT and **renumber the prefixes on every
add/remove** so the visible list is always 1..N with no gaps — that's how Michael references tasks
("do #3").

**How to apply:** on completion → `TaskUpdate status=deleted`, then re-`TaskUpdate` the remaining
subjects to close the numbering gap. Keep the durable record + auto-cross-off signal history in the
**agent-bus todo list** (the source of truth he can still audit on the dashboard); the native list
is just the clean, numbered live view. See [[feedback_foreman_delegates_even_env_tasks]].
