# Hands — terminal palette

Truecolor first; the 256-colour fallbacks are the nearest xterm cube entries.
Every hue clears 5.6:1 on `#0B0B0C`, so all five are safe for status text on a dark terminal.
On a light terminal use `--hands-accent-on-light` (#7A28C9) for accent text and keep the
palette for glyphs and rules only.

| station | name   | hex     | truecolor SGR              | 256 |
|---------|--------|---------|----------------------------|-----|
| 1       | aqua   | #00E0C6 | \e[38;2;0;224;198m | 50 |
| 2       | cobalt | #4D7CFF | \e[38;2;77;124;255m | 70 |
| 3       | orchid | #B85CFF | \e[38;2;184;92;255m | 172 |
| 4       | coral  | #FF5C7A | \e[38;2;255;92;122m | 240 |
| 5       | amber  | #FFB020 | \e[38;2;255;176;32m | 256 |

## Suggested semantics

    aqua    info / expo speaking
    cobalt  station running
    orchid  queued, accent, prompts
    coral   failed, conflict
    amber   warning, needs the chef

Cap concurrent stations at five. A sixth reuses station 1 with a dim/stripe modifier —
five is the mark, and the mark is the legend.
