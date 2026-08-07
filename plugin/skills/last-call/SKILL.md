---
name: last-call
description: The expo-driven end-of-shift close-out (hands#118) — stand down every station, sweep mergeable dishes, distill every craft's pending notes, close the books with a digest note, and prep tomorrow's in-flight work so each station knows what to pick up. Use when the principal says /hands:last-call, "close out the shift", "end of day", "wrap it up", "call it a night", or is wrapping for the day and wants a clean stop rather than leaving things mid-air.
---

# Last call — closing the kitchen for the day

Expo-only. Run this when the principal is wrapping for the day, rather than the lighter
single note in expo/SKILL.md §8 — last call is the full ritual: nothing left mid-air, nothing
learned left unfolded, tomorrow already knows where to start.

Its counterpart is **`/hands:line-check`** — the shift-open that reads what this writes. Last call
puts the dishes away; line check still looks in the walk-in before service, because things happen
overnight.

## 1. Stop-work broadcast

`hands_send({ to: "*", wake: true, body: "Last call — wrap what you're on, park cleanly (stop
pushing, no re-runs, no new work), then reply with one status line." })` — the same park-cleanly
discipline as the utilization beat's stand-down (expo/SKILL.md §4), just deliberate rather than
saturation-triggered. Wait for each station's status line before moving on — step 5 needs it.

**Ask each station to attest before it stands down** (hands#157): *"…then run `/hands:ready` and
tell me what it says."* This is the only moment in the day when every station is alive at once, so
it is the cheapest possible place to establish that they are clean. Fixed at close = free in the
morning; a station that attests clean and then sits offline is **still** clean at line-check,
because nothing ran.

A station that **declines** is a good outcome, not a failure — its reason is information only it
has. Carry that into step 5 rather than pressing it to go green; a station that got clean by
discarding something has destroyed the one thing nobody else knew.

## 2. Merge sweep

For every dish that's ready to ship, run the hands flow (expo/SKILL.md §5) — pull facts, pick
review depth, merge per `merge.adminMergeLowRisk`. Don't force anything through a hard gate just
because it's end of day; a dish that isn't ready stays open, carried into step 5.

## 3. Craft distillation (hands#81/#96/#49/#118)

`hands craft distill` — the full cross-craft backlog in one call. mise entries won't show up
there; they already applied themselves mechanically the instant they were harvested, no fold
needed. For each craft listed: `hands craft fold <slug>` (acquires the lease, returns the current
book/skill — including their `## Raw notes (unfolded)` section — plus the pending notes list),
rewrite book/skill **in place** per the printed instructions (fold the raw notes into curated
prose, discard restatements, keep the book ≤150 lines, remove the raw-notes section, stamp
`distilled:`), then `hands craft fold-done <slug> --through <n>`. Do this yourself or dispatch a
general-purpose agent per craft — either way, every craft with a backlog gets distilled before you
close the books.

## 4. Close the books

`hands_digest_note` with the day's narrative (supersedes the lighter version in expo/SKILL.md
§8) — what moved, what's blocked, what tomorrow opens with. This is the one thing every kitchen
leaves behind for the next person — yourself tomorrow, or a collaborator — to read cold.

## 5. Prep next day

For anything still in flight or blocked (including a dish that didn't clear step 2's merge
sweep), leave it in a state a station can pick up on wake without you: `hands_task_update` with a
clear `result`/status note. If the principal named specific upcoming work, file it now with
`hands_delegate` so it's waiting rather than something tomorrow has to ask for.

**Park it back to `assigned`, don't leave it `in_progress`.** `in_progress` means *someone is
cooking this right now*. Once you've stood the line down, nobody is — and a ticket that claims a
stood-down station is working produces exactly the lie the board already tells about idle-versus-
deaf: the expo routes around a station it believes is busy, and the rail shows work in flight that
nothing is advancing. An order waiting on the rail is the menu; a dish nobody is cooking should not
say it is on the pass.

The station picks it straight back up on its next wake — `assigned` is where it looks.

The server enforces this too: any ticket left `in_progress` by an offline station is parked
automatically on the expo's next board read. This step is the deliberate version — do it with a
status note attached, rather than letting the sweep do it silently with none.

## 6. Report

One summary line to the principal: dishes merged, crafts distilled, stations parked, anything
carried to tomorrow.
