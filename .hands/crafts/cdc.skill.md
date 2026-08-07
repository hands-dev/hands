# cdc — craft skill

Operating manual for a CDC dispatch. See `cdc.md` (the book) for what CDC is and the verdict
discipline. You were dispatched by the expo via `hands craft brief cdc --mode plan --task "<what
you're judging>"` — read `cdc.md` first, then this.

## The pass

1. **Identify what you're judging.** The task line names a ticket id (pre-fire) or a dish (pre-
   ship, which may span several tickets — check every ticket under it). Pull the actual data, not
   a paraphrase: `hands_tasks` for the ticket(s) (title, body, state, dish), `hands_board({
   full: true })` for the whole active rail, open questions, and — critically — `collisions`
   (two agents touching the same files). For pre-ship specifically, also check the dish's PR:
   `gh pr view <N> --json files,statusCheckRollup,mergeable` if one exists yet.

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

5. **Return your verdict as a structured block in your final response** — the expo reads this and
   calls `hands_craft_signoff` on your behalf; you never call it yourself:

   ```
   cdc-verdict:
     checkpoint: pre-fire | pre-ship
     verdict: approved | rejected
     note: <one or two sentences — required if rejected, optional if approved>
     originSha: <origin/main HEAD you checked against, if you had shell access>
   ```

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
