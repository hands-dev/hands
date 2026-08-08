---
name: line-check
description: The expo-driven shift-open (hands#156/#157) — read the previous shift's page from the books, bring the expo's OWN checkout current, see which stations are ready for service, and re-confirm today's menu against what actually happened. The counterpart to /hands:last-call. Use when the principal says /hands:line-check, "open the kitchen", "start of shift", "what happened yesterday", or on the first pass of a new day before dispatching anything.
---

# Line check — opening the kitchen

Expo-only. `/hands:last-call` closes a shift; this opens one. **The opening is where accuracy is
decided** — a ticket is only as good as the picture behind it, and the expo is the single point
where a stale picture becomes *everyone's* stale picture.

Run this **before firing the first ticket of a shift.** Hang it on the once-a-day marker the
greeting already uses (`expo.last-greeting`, `find -mmin +1440`) — same cadence, same trigger, no
new timer.

Measured once, mid-shift, before this existed: not one workspace was ready, and the expo — the
pane writing every ticket — was **992 commits behind and dirty**. It filed a false "this is
unversioned, one `git clean` from gone" alarm about a directory that was tracked the whole time.
Nothing in the tool surface reported any of it.

## 1. Read the previous shift

```bash
hands journal read --previous
```

The last page *strictly before* today, so a Monday reads Friday's close. Surface the **Notes**
section to the principal in a couple of lines — that's the narrative handoff, and it is the part
that changes what every later decision is built on.

This is not ceremony. One line in a previous page — *"the chain now runs dispatch → match → claim
→ exchange on real code paths"* — was the fact three agents spent an afternoon re-deriving from a
branch it wasn't true of, while the status board sat disputed for an hour.

If it reports a **mirror problem** (diverged, behind, no upstream), say so plainly and stop
relying on the books until it's fixed — a journal you cannot read is not a handoff.

## 2. Bring your OWN checkout current

You clean your own station and **nobody else's**. Stations attest for themselves (step 3); you do
not reach into their worktrees.

```bash
git fetch && git status --short && git log --oneline -1
```

Report your own behind/ahead/dirty. If you are behind, **pull before you read any code to write a
ticket from** — a bare `git`/`Read` in your checkout answers from whatever snapshot this pane is
sitting on, and nothing warns you. That is exactly how the false "unversioned" alarm reached a
human.

## 3. Who is ready for service

```bash
hands doctor
```

Read the `dispatch` line and each `<station>.ready`:

- **ready** — attested clean; you may dispatch.
- **unattested** — never declared itself clean. `hands_delegate` will refuse. Tell it to run
  `/hands:ready`.
- **declined** — it *tried* and said no, in its own words. Read the reason: it is information only
  that station has, and it may be a question for you or the principal rather than for the station.
- **expired** — it attested, then the world moved (its HEAD, origin, or its worktree lock). One
  re-run of `/hands:ready` there.

**Offline stations still count.** A station that is not running may have died mid-dish, and its
leftovers sit in the worktree invisibly. Detecting that does not require the station — but
*judging* it does, so report what you see and let the station or the principal decide. **Never
clean another station's worktree.**

A station that attested clean and then sat offline is **still clean** — nothing ran, so nothing
changed. Don't make anyone boot five stations to collect signatures.

## 4. Re-confirm the menu against EVENTS

`hands_menu` reports `stale: false` when someone merely **confirmed** it recently — so an
out-of-date menu arrives with a freshness stamp on it. Check it against what step 1 and step
3 just told you:

- does it name a blocker that last night's page says was resolved?
- does it name a station that is offline or blocked?
- did anything merge overnight that finishes a recipe outright (check its acceptance criteria)?

If any of those hold, the menu is stale regardless of what the API says. Show it to the principal
and re-confirm before dispatching.

## 5. Report, then open

One short block: yesterday's headline, your own checkout state, who's ready and who isn't, and
anything on the menu that looks superseded. Then work the pass normally.

## Guardrails

- **Never clean, pull, or reset another station's worktree.** You may look; you may not touch.
  Their leftovers are theirs to judge, and destroying work that has no other copy is worse than
  any staleness.
- Don't skip step 1 because the books look quiet. An empty read is a fact worth reporting —
  especially if the reason is a broken mirror rather than a quiet night.
- Don't dispatch around a blocked station by rerouting its work without saying so. The block is
  information; silently routing past it hides the thing the principal needs to fix.
