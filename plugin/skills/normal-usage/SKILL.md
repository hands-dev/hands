---
name: normal-usage
description: Resets hands' global economy dial back to normal — undoes /hands:low-usage. Every expo/station goes back to today's default dispatch/review-depth/model-tier judgment, machine-wide (every repo on this machine), effective on each pane's next hands_board poll — no restart needed. Use when the principal says /hands:normal-usage, "back to normal usage", "turn off low-usage mode", "stop being so conservative", or wants to undo a prior /hands:low-usage.
---

# Normal usage — reset the economy dial

`hands usage normal` (`engine/src/cli.ts`) writes `usage.mode: "normal"` to the USER-level config
(`~/.claude/hands.config.json`) — the explicit reset, not just "the thing you do if you forget you
turned low-usage on." Same conversational shape as `/hands:low-usage`: check, explain, run, relay.

## Steps

1. **Check current mode first.** Run `hands usage` (Bash, no arg). If already `normal`, say so and
   stop — nothing to do. If it's `low`, continue.
2. **Set expectations** — say plainly: *"I'll run `hands usage normal`. This is machine-wide: it
   affects every repo's expo and stations on this machine, and an already-running pane picks it up
   on its very next board check — no restart needed."*
3. **Run `hands usage normal`** (Bash). It writes the user-level config and prints a confirmation.
4. **Confirm what reverts:** dispatch economics, review depth, and model-tier tagging all go back
   to their default judgment (documented in `plugin/skills/expo/SKILL.md`'s "Usage mode" section) —
   nothing was permanently changed by having been in low-usage mode; this is a full, clean reset.

## Guardrails

- Don't hand-edit `~/.claude/hands.config.json` yourself — always go through `hands usage normal`,
  same reasoning as `/hands:low-usage`'s guardrail.
- If a repo's own committed `hands.config.json` sets its own `usage.mode`, that repo-level setting
  still overrides this machine-wide reset for anyone working in it — say so if the principal seems
  surprised a repo isn't reflecting the change (check `hands usage`'s no-arg output, which reports
  which layer set the current mode).
