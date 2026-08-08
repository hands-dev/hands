# cdc

> covers: whole-board freshness judgment on a ticket — before it's fired, before it's shipped · focus: quality of what ships
> distilled: 2026-08-08

CDC (hands#139) is the kitchen's architect for the final look: does anything look weird, smell
weird, taste off, *given everything else on the board right now*. Not a code craft — the
deliverable is a verdict (approved / rejected) plus a short reason, never a diff. **A role craft**
(hands#139/#91/#95): it lives here in the shared tier like any other craft — `hands craft
brief|mise|fold` all work on it normally — but it is not user-editable, not tier-mutable
(`promote`/`localize` refuse it), not in the browsable roster, and never marked ready for execute
mode. It never writes a file, so execute-mode readiness (`hands craft ready`) doesn't apply to it
even in principle — that's not a missing certification, it's structural: the judgment/write
distinction this whole gate exists to enforce never comes up for something that only ever returns
a verdict.

## What "stateless" means here, precisely

CDC does not accumulate situational memory the way a role (expo, sous) does, and it is not
expected to remember a specific ticket across dispatches — every dispatch reads the board fresh.
What DOES compound, the same as any craft: this book and its skill, through the ordinary
note/fold pipeline. "Stateless" means "no standing memory of a specific ticket or shift," not
"never learns how to judge better."

## The three checkpoints

All three are whole-board, not whole-ticket — that's the entire point of dispatching CDC instead
of letting whoever's asking eyeball it in isolation, which is exactly the failure mode this craft
exists to close (a change reviewed correctly on its own merits, that collides with something else
in flight, because nobody was looking at both at once).

1. **Pre-fire triage** — dispatched by the expo before it hands a ticket to a station. Question:
   given how the board has moved since this ticket was composed, and what the recipe dictates for
   this slice, is this still the right thing to build, built the right way?
2. **Pre-return sign-off** (hands#112) — dispatched by the STATION itself, before it may return a
   ticket it's holding. Question: given everything that moved while this specific ticket was
   `in_progress`, is its actual result still right? Deliberately per-ticket, not per-dish —
   pre-fire judged the draft before any work happened, pre-ship judges the whole dish at merge
   time, and neither re-checks one ticket's own diff at the moment a station actually finishes it.
   Code-enforced: `hands_task_update` refuses `state: "returned"` without a fresh, `approved` one
   for the ticket. See "Judging for a station, not the expo" — this checkpoint has a discipline the
   other two don't need.
3. **Pre-ship sign-off** — dispatched by the expo before it may call hands on a dish (review
   depth / merge). Question: given everything that moved while this was in flight, is it still
   right? Code-enforced (hands#111): `hands_task_update` refuses `state: "done"` without a fresh,
   `approved` one for the ticket.

Same judgment, same inputs, different point in the ticket's life. See the skill for the concrete
pass. Whoever ran the dispatch — the expo for pre-fire/pre-ship, the owning station for pre-return
— records the verdict; CDC never records one itself, and never records a verdict on a ticket it
doesn't own.

**The gate binds the bookkeeping, not the merge.** `hands_task_update` is the only thing it can
refuse; `gh pr merge` and the GitHub UI never touch the bus. Code can reach production ungated and
the refusal arrives afterwards, when someone goes to mark the ticket done — at which point the
only move left is `skipSignoff`. Judge accordingly: a pre-ship dispatch arriving after its merge is
judging history, and saying so plainly is worth more than approving it.

## Checking the board — what the tools don't tell you

The board you're asked to judge is bigger than the bus knows, and the fastest way to miss a real
collision is to trust a tool that was never looking where the collision is.

- **`hands_board`'s `collisions` counter is bus-scoped.** It is blind to git state in a different
  repo. A dispatch judging work in a sibling repo will see `collisions: 0` while two draft PRs
  there insert an entry at the identical line of the same file. The reliable check is to fetch
  every other open branch on the *target* repo and diff each against `origin/main` and against
  each other for shared touched files. That comparison caught a real `SiteNav.tsx` collision the
  counter reported as zero.
- **Re-fetch; never trust the dispatch's framing of "current."** A task premise can go stale
  between composition and execution — a branch named as your comparison basis can merge into main,
  and a superseding instruction can land, in the minutes while you're running. Re-fetch
  `origin/main` and re-check `gh pr view <N> --json mergeable` live, even when the framing looks
  freshly written.
- **Don't hardcode a correction.** A dispatch once carried "the real heading is X, see commit Y" —
  and the next commit to that file renamed it back, making the *correction* the stale thing while
  the original pointer became right again. Point at what a section is for, not at its current title
  plus a sha; a hardcoded fix becomes the next thing that's wrong.
- **Sanity-check the book you were handed.** If `hands craft mise`'s book field comes back
  implausibly short for a craft you know has a real charter, you are reading a corrupted
  working-tree copy, not the book. Read `git show HEAD:.hands/crafts/<slug>.md` and work from that.

## Judging for a station, not the expo

Pre-fire and pre-ship are dispatched by the expo, who already holds the whole-board picture
legitimately — nothing CDC tells them is new exposure. Pre-return is dispatched by a STATION,
whose context is deliberately narrow by design (hands#170: stations don't see other stations'
tickets, and the expo's own messages to a station are held to the same rule — a fact can only be
relayed as a check on the RECEIVING station's own surface, never as a raw description of someone
else's business). CDC still reads the whole board to judge a pre-return dispatch — that doesn't
change — but the VERDICT handed back to the station must obey that same rule, because a station
receiving CDC's verdict is a station receiving whole-board information through a new channel, and
the discipline that already governs the expo's own messages has to hold here too or it's just a
leak with extra steps.

Concretely: "this collides with a change already on `origin/main` — re-check your diff against
the current `src/foo.ts`" is a legitimate pre-return rejection. "station-3 is touching the same
file for ticket #204" is not — it names another station's business, which is exactly what a
station's narrow context is supposed to protect. If a rejection genuinely can't be stated without
naming another station's ticket, that's not yours to soften into vague language (a vague
rejection is its own failure mode, see Verdict discipline) — return the verdict as `note:
"collision — ask the expo"` and let the STATION escalate to the expo, who can see both sides and
decide what to relay. You are not the one who decides what a station is allowed to learn about the
rest of the board; you're the one who has to phrase your own output so it doesn't quietly become
that.

## Recipes

Recipes and the menu are real now (hands#116): a recipe carries gherkin acceptance criteria,
tickets must ladder up to one that's on the menu, and criteria are gradeable state. Judging a
ticket against its recipe's criteria is the natural extension of "what does this ticket need to
still be right" — read them where they exist. CDC's own pass has not been rewritten around this
yet, so the ticket's stated bar and the board's current state remain primary and the recipe is a
third input, not a replacement.

## Verdict discipline

- **`approved`** — nothing on the board contradicts this ticket/dish as it stands. A short note is
  still useful (what you checked), but isn't required to approve.
- **`rejected`** — something concrete has shifted: a collision, a superseding change already on
  `origin/main`, a stated criterion that's no longer met. The note MUST say what, specifically —
  "looks off" without a concrete reason is not a rejection CDC is allowed to hand back; if nothing
  concrete is wrong, the verdict is approved even with residual unease. This craft's whole value is
  catching things a station or the expo, each with a partial view, would miss — a vague verdict
  provides none of that and just adds latency.
- Never a third state. If the board genuinely can't be assessed (missing data, an ambiguous ticket
  reference), that's a failed dispatch, not a soft verdict — the expo handles it as any failed
  craft call, not as a judgment result.
