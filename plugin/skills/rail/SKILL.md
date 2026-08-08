---
name: rail
description: Print the current rail — tickets grouped by dish, menu coverage, the needs-you lane, and station on-duty count — in the deterministic format the expo's own reports use. Invocable directly in any session, not routed through a running expo loop. Use when the principal says /hands:rail, "what's on the rail?", "show me the tickets", or wants a status snapshot without opening the dashboard.
---

# Rail — the deterministic status snapshot

Print the kitchen's current ticket state in the exact shape the expo itself uses for "What's on
the rail?" — same data, same format, whether you read it here or on the live dashboard
(`/hands:dashboard`). This is a **read-only viewer**: never register on the bus, never fire
tickets, never touch state.

## Steps

1. **One call, one source of truth.** `hands_board({ full: true })` — the exact MCP call (and
   therefore the exact underlying store) `engine/src/serve.ts`'s `/api/state` reads from for the
   dashboard's rail. Do not re-derive or separately re-query anything below — every field needed
   comes back in this one response (`peers`, `activeTasks`, `openQuestions`, `menu`). If
   chat output and the dashboard ever show different rails for the same instant, that's a bug —
   they must compute from this identical read.

2. **Render in this exact shape** (canonical definition: `plugin/skills/expo/SKILL.md`'s
   "What's on the rail?" section — hands#52/#90/#94/#108; keep both in sync if either changes):

   ```
   Rail: <dish>: #<id> <title> — <station>[·<craft>] (<state>)[; #<id> <title> — <station> (<state>)]
   Rail: unattached: #<id> <title> — <station-or-"queue"> (<state>)
   Menu coverage: P1×<n>, P2×<n>, P3×<n>[, P<k> unstaffed]
   Needs you: <n> open — #<id> <one-line>[, #<id> <one-line>][ | none]
   Stations: <onDuty>/<total> on duty
   ```

   Build it from the response:
   - **Group `activeTasks` by `dish`** in the array's own order (no re-sorting — a missing dish
     goes under `unattached`). One `Rail:` line per dish; entries within a line joined by `; `.
     Each entry: `#<id> <title> — <station>[·<craft>] (<state>)`, where `<station>` is `assignee`
     (or `queue` when unassigned) and `<craft>` is that station's `focus` from `peers` (look it up
     by matching `peers[].id === assignee`; omit the `·<craft>` suffix when there isn't one).
   - **Menu coverage:** `menu.items` is the ranked recipe list — each item's own `rank` field IS
     its P-number directly (rank 1 is P1, rank 2 is P2, and so on; recipes carry rank on the file
     itself now, hands#96/#137 — no index math needed). For each ranked item, count `activeTasks`
     whose `priority` equals that rank string (`"P1"`, `"P2"`, …). Render `P<rank>×<count>` for
     staffed ranks; collect zero-count ranks into a trailing `, P<k> unstaffed` (join multiple with
     `, `, e.g. `P3, P4 unstaffed`).
   - **Needs you:** from `openQuestions` (already state=`open` only — `needs_human` escalations
     are `/hands:hands`'s job, not this command's; the two are complementary, not overlapping).
     `<n>` is the count; list each as `#<id> <question, truncated to ~50 chars>`. Zero open →
     `Needs you: none`.
   - **Stations:** `<onDuty>` = count of `peers` where `online` is true; `<total>` = `peers.length`.
   - The last three lines are always present even when a section is empty — `none`/`unstaffed`
     rather than omitting the line, so a missing line always means "didn't fetch," never "nothing
     to report."

3. **Print it verbatim** — no extra commentary, no summarizing prose above or below. The whole
   point is a stable, grep-friendly block the principal can scan or pipe.

## Guardrails

- Read-only. Never call `hands_task_update`, `hands_delegate`, `hands_answer`, or anything else
  that mutates the bus — this command only looks.
- One `hands_board` call, nothing else. If you find a real gap where it doesn't expose something
  the dashboard shows, say so rather than adding a second query path — that's a signal the MCP
  tool itself needs a field added, not a workaround here.
