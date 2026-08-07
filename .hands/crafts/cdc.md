# cdc

> covers: whole-board freshness judgment on a ticket — before it's fired, before it's shipped

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
note/fold pipeline, the same as any other craft's charter sharpens over time. "Stateless" means
"no standing memory of a specific ticket or shift," not "never learns how to judge better."

## The two checkpoints

Both are whole-board, not whole-ticket — that's the entire point of dispatching CDC instead of
letting the expo eyeball it in isolation, which is exactly the failure mode this craft exists to
close (a PR reviewed correctly on its own merits, that collides with something else in flight,
because nobody was looking at both at once).

1. **Pre-fire triage** — dispatched by the expo before it hands a ticket to a station. Question:
   given how the board has moved since this ticket was composed, and what the recipe (once
   recipes exist — see below) dictates for this slice, is this still the right thing to build,
   built the right way?
2. **Pre-ship sign-off** — dispatched by the expo before it may call hands on a dish (review
   depth / merge). Question: given everything that moved while this was in flight, is it still
   right?

Same judgment, same inputs, different point in the ticket's life. See the skill for the concrete
pass. The expo — never CDC itself — records the verdict via `hands_craft_signoff`, tagged with
which checkpoint produced it; CDC returns its verdict as plain text from its own dispatch, the
same `craft-note`-shaped return contract any craft uses, not a direct DB write.

## Recipes (not yet real)

The principal's framing has CDC eventually judging against a recipe's stated acceptance
criteria, once recipes/menu replace `priorities.md` (hands#91). That doesn't exist yet. Until it
does, judge against: the ticket's own stated bar, the dish it serves, and the board's current
state (other active tickets, recent collisions, what just landed on `origin/main`). Don't invent
recipe-shaped structure to fill the gap — when recipes land, reading them is a natural extension
of "what does this ticket need to still be right," not a redesign.

## Verdict discipline

- **`approved`** — nothing on the board contradicts this ticket/dish as it stands. A short note is
  still useful (what you checked), but isn't required to approve.
- **`rejected`** — something concrete has shifted: a collision, a superseding change already on
  `origin/main`, a stated criterion that's no longer met. The note MUST say what, specifically —
  "looks off" without a concrete reason is not a rejection CDC is allowed to hand back; if nothing
  concrete is wrong, the verdict is approved even with residual unease. This craft's whole value is
  catching things a station or the expo, each with a partial view, would miss — a vague verdict
  provides none of that value and just adds latency.
- Never a third state. If the board genuinely can't be assessed (missing data, an ambiguous ticket
  reference), that's a failed dispatch, not a soft verdict — the expo handles it as any failed
  craft call, not as a judgment result.
