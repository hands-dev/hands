---
name: low-usage
description: Turns on hands' global economy dial — every expo/station raises the bar on sub-agent fan-out, shifts review depth down one notch (never past the irreversible-action gates), leans tickets toward the cheaper model tier, and dispatched craft sub-agents get the same signal in their own briefing. Machine-wide (every repo on this machine, not just the current one), takes effect on each pane's next hands_board poll — no restart needed. Use when the principal says /hands:low-usage, "go easy on usage", "be more judicious", "cut costs", or wants a cost-sensitive stretch without hand-editing config or re-explaining it every session.
---

# Low usage — a global economy dial

`hands usage low` (`engine/src/cli.ts`) writes `usage.mode: "low"` to the USER-level config
(`~/.claude/hands.config.json`) — machine-wide, every repo, not just the one you're in. Every
expo/station reads it off `hands_board`'s response (already polled every pass, no new call) and
every dispatched craft sub-agent sees it in its own chit/mise briefing. This is a conversational
wrapper, same shape as `/hands:login`: check current state, explain, run, relay, confirm.

## Steps

1. **Check current mode first.** Run `hands usage` (Bash, no arg) — local-only, no network call.
   If already `low`, say so and stop; don't re-run underneath the principal. If they want the
   opposite, point at `/hands:normal-usage`.
2. **Set expectations before running it** — say plainly: *"I'll run `hands usage low`. This is
   machine-wide: it affects every repo's expo and stations on this machine, not just this one, and
   an already-running pane picks it up on its very next board check — no restart needed."*
3. **Run `hands usage low`** (Bash). It writes the user-level config and prints a confirmation.
4. **Explain concretely what changes**, so the principal isn't guessing at the effect:
   - Sub-agent fan-out gets a higher bar — expo/stations prefer doing small/borderline work
     directly instead of spinning up a fleet, and batch more into fewer, larger dispatches.
   - Review depth drops one notch — routine PRs that would've gotten the default `/code-review`
     now get `/code-review low` instead. Complex/sensitive work (auth, payments, migrations,
     CI/deploy, infra) is unaffected — it still gets full `/code-review high` regardless of mode.
   - Ticket tags lean toward the cheaper model tier unless the work genuinely needs the strong one.
   - Craft dispatch batches more slices per brief, and trivial slices get done in-pane instead of
     spinning up a craft sub-agent.
5. **Mention the reset.** `/hands:normal-usage` flips it back anytime; nothing else about hands'
   behavior depends on which mode is set.

## Guardrails

- Never claim this changes anything about correctness or safety gates — it only narrows judgment
  calls (dispatch, review depth, model tier). Merge/deploy/irreversible-action gates are identical
  in both modes.
- This is machine-wide by design — if the principal seems to want a PER-REPO-only change instead,
  say so plainly: that needs hand-editing this repo's own `hands.config.json` (`usage.mode`),
  which isn't wrapped in a slash command today.
- Don't hand-edit `~/.claude/hands.config.json` yourself — always go through `hands usage low`, so
  the write stays a single, safe, well-formed JSON merge rather than a manual edit that could
  corrupt other settings already in that file.
