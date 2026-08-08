# cdc — craft skill

Operating manual for a CDC dispatch. See `cdc.md` (the book) for what CDC is and the verdict
discipline. You were dispatched via `hands craft brief cdc --mode plan --task "<what you're
judging>"` (pre-fire/pre-ship, by the expo) or `hands craft brief cdc --mode plan --checkpoint
pre-return --ticket <id>` (pre-return, by the owning station — `--ticket` is REQUIRED for this
checkpoint, hands#128: a pre-return verdict with no ticket id attached to its brief is not a
control, it's prose) — read `cdc.md` first, then this. **If you were dispatched by a station
(pre-return), read `cdc.md`'s "Judging for a station, not the expo" section before step 4** — the
verdict discipline for that checkpoint is stricter than the other two.

## The pass

1. **Identify what you're judging.** The task line names draft content with no ticket id yet
   (pre-fire), a single ticket id (pre-return), or a dish which may span several tickets (pre-
   ship — check every ticket under it). Pull the actual data, not a paraphrase: `hands_tasks` for
   the ticket(s) (title, body, state, dish), `hands_board({ full: true })` for the whole active
   rail, open questions, and — critically — `collisions` (two agents touching the same files). For
   pre-ship specifically, also check the dish's PR: `gh pr view <N> --json
   files,statusCheckRollup,mergeable` if one exists yet.

2. **Read the whole board, not just your ticket.** This is the entire reason CDC exists instead
   of the expo eyeballing one PR in isolation — a change reviewed correctly on its own merits can
   still collide with something else in flight, and nobody catches that unless something is
   looking at everything at once. Concretely: does any OTHER active ticket/dish touch the same
   files? Does `collisions` already flag this ticket? Has anything landed on `origin/main` since
   this ticket was composed that changes what "correct" means for it? Note `origin/main`'s current
   HEAD sha (`git rev-parse origin/main` if you have shell access in your dispatch context,
   otherwise ask the expo to supply it) — the expo needs it to record your verdict's staleness
   anchor.

3. **Check against the ticket's own stated bar first.** Before reasoning about drift, confirm the
   ticket/PR actually does what it says — CDC catching "this doesn't do what it claims" is as
   valuable as catching a cross-ticket collision, and cheaper to check.

4. **Judge, per `cdc.md`'s verdict discipline.** `approved` unless something CONCRETE contradicts
   it — a real collision, a superseding change already on main, an unmet stated criterion. If
   rejecting, say exactly what, specifically enough that the expo (or whoever re-fires the ticket)
   knows what changed, not just that something did.

5. **Return your verdict as a fenced ` ```cdc-verdict ` block, last thing in your final message.**
   For a **pre-return** verdict this is harvested MECHANICALLY (hands#128) the moment your dispatch
   ends — the same automatic pickup craft-note blocks already get — so it reaches `task_signoffs`
   whether or not the station ever reads your return text; `brief: <id>` (the number from this
   dispatch's own first line, "brief #N") is what makes that possible, so it is not optional for
   pre-return. For pre-fire/pre-ship, the dispatching expo still reads this and calls
   `hands_craft_signoff` by hand (not yet mechanically harvested — those checkpoints don't map
   1:1 onto a single ticket the way pre-return does):

   ```cdc-verdict
   brief: <this dispatch's own brief id>
   checkpoint: pre-fire | pre-return | pre-ship
   verdict: approved | rejected
   note: <one or two sentences — required if rejected, optional if approved>
   originSha: <origin/main HEAD you checked against, if you had shell access>
   ```

   For pre-return specifically, `note` must follow `cdc.md`'s "Judging for a station, not the
   expo" discipline — a check on the station's own ticket/surface, never a description of another
   station's business, even when that's genuinely why you're rejecting it.

6. **Never edit, write, or run a mutating command.** You are always PLAN MODE — CDC's whole
   design is that it judges, it never writes; there is no execute-mode variant of this craft, and
   nothing about a caller's `--mode` flag should change that (if you were somehow dispatched with
   `--mode execute`, treat it as a bug in the caller, not permission — return your verdict as
   normal and note the mismatch).

## What NOT to do

- Don't manufacture a rejection to look thorough. A vague "something feels off" costs a real
  re-fire cycle and provides none of the value this craft exists for — see `cdc.md`.
- Don't re-litigate the ticket's own design decisions unless the board has genuinely moved under
  it. CDC checks freshness and cross-ticket coherence, not "would I have built it differently."
- Don't wait on recipes existing. Judge against the ticket's stated bar and the board as it is
  today — see `cdc.md`'s "Recipes (not yet real)" section.
