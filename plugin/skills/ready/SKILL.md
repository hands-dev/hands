---
name: ready
description: The station-side shift-open (hands#157) — get this station to zero state and attest that it is clean and ready, so the expo can dispatch to it. Covers what to do with leftovers from a previous shift: uncommitted work, stashes, a branch from a closed ticket, being behind origin, a dead inbox monitor. Use when the principal or the expo says /hands:ready, "get clean", "are you ready", "attest", at the start of a shift, or when `hands attest` has refused and you need to fix what it named.
---

# Ready — getting this station to zero state

Station-only. The expo does not clean your worktree; it reads what you say about it. No current
attestation means no tickets to you — so this is how you come on shift.

**Clean means zero state: no dish left half-made, no missing ingredients.** Two halves, both
required. `hands attest` verifies them mechanically; this skill is how you get there.

## The rule that governs everything below

**Never destroy work that has no other copy.**

Staying unattested and saying why is *better* than getting clean by throwing something away. A
station that reports *"14 uncommitted files I don't recognise"* is giving the expo information
only you have. A station that ran `git reset --hard` to go green has destroyed it and told
nobody. If you are ever unsure, stop and say so — declining is a first-class outcome, not a
failure.

## 1. Claim the seat

```bash
hands claim
```

If it refuses, **stop** — another session holds this worktree and two sessions in one tree commit
over each other. Report the pid it names to the expo and end your turn.

## 2. See what you're carrying

```bash
hands attest
```

Run it *first*, before fixing anything. It names exactly what is wrong, and several checks are
about things you might otherwise not think to look at. If it passes, you're done — say so and
start work.

## 3. Deal with each leftover — decisions, not reflexes

**Uncommitted changes.** Look at them before doing anything. Is this yours, finished work? Commit
it to your station branch. Half-finished but worth keeping? `git stash push -m "<what it is and
why>"` — a named stash, never a bare one. Genuinely yours to discard? Then discard it, but say in
your attestation that you did and what it was. **Never `git reset --hard` to make a check pass.**

**Stashes.** An unclaimed stash is a question for the expo, not garbage. If you know what it is,
apply or drop it deliberately. If you don't recognise it, leave it and decline — name it in your
reason.

**On the wrong branch.** A branch from a closed ticket is finished business. Start fresh:
`git checkout hands/<your-id>` and bring it to current `origin/main`. If the old branch has
unmerged commits, leave the branch alone — it stays until its PR merges or someone abandons it
explicitly.

**Behind origin.** Rebase. If you have no local commits, fast-forward. Being behind is the
"missing ingredients" half — a station reading stale code will write a ticket's fix against a
file that changed yesterday, and that error reaches a human as a confident wrong answer.

**Inbox monitor dead.** Arm it (station/SKILL.md §"First invocation"). A station with a dead tail
looks *idle* on the board when it is actually *deaf* — it will never wake again, and nobody will
know why it went quiet.

**Tickets you already hold.** A ticket of yours sitting `in_progress` is **not** dirt — it's work
to resume, left for you on purpose by `/hands:last-call`. Pick it up. An order waiting is the
menu; only uncommitted *changes* are a half-made dish.

## 4. Attest

```bash
hands attest
```

Green: you're on the line, and the expo can dispatch to you.

Red: it records *why*, in your words, where the expo and the dashboard can see it. That's a real
answer, not a failure — go back to step 3, or escalate if the right call isn't yours to make.

## Guardrails

- **Never** `git reset --hard`, `git clean -fd`, or `git stash drop` to satisfy a check. The
  check exists to protect that work.
- Never attest by asserting. `hands attest` re-derives everything; saying "I'm clean" without
  running it is worth nothing at the moment someone relies on it.
- If a leftover isn't yours to judge — an unrecognised stash, a branch you didn't create,
  uncommitted work you don't remember — **decline and name it**. That's the expo's call or the
  principal's, not yours.
- Attesting is not once-a-day. It dies when your HEAD moves, when `origin/main` advances past it,
  when the worktree lock changes hands, or on a new shift. Re-run it when it does.
