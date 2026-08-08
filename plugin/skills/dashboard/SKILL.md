---
name: dashboard
description: Open the live hands dashboard — boots `hands serve` in the background if it isn't already running, then opens the browser at the kitchen's single-page view (the rail, the line, questions, the menu, the book — live over SSE). Use when the principal says /hands:dashboard, "open the dashboard", "show me the board", or "show me the kitchen".
---

# Dashboard — open the kitchen's live view

Boot (if needed) and open the read-only dashboard: a single page showing the rail, the line
(stations), open questions, today's menu, the principal's list, and the book — updating live
over SSE, no refresh. It is a viewer, not a participant: it never registers on the bus.

## Steps

1. **Resolve the URL.** `PORT="${HANDS_PORT:-4319}"`, `URL="http://127.0.0.1:$PORT/"`.
2. **Probe** (one Bash call — detects already-running and squatters at once):

   ```bash
   BODY=$(curl -sf -m 2 "http://127.0.0.1:$PORT/api/state" 2>/dev/null); echo "$BODY" | head -c 100
   ```

   - Body contains `"agents"` → **already running**: skip to step 4.
   - Empty (connection refused) → **not running**: boot it (step 3).
   - Non-empty but no `"agents"` → **another service owns the port**: stop and tell the
     principal to set `HANDS_PORT` to a free port and re-run. Never boot over it, never kill
     the unknown process.
3. **Boot** with the Bash tool and `run_in_background: true` (no `nohup`, no trailing `&`):

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/hands" serve
   ```

   Then re-run the step-2 probe until `"agents"` appears (up to ~10 tries, `sleep 0.5` between).
   Still nothing → surface the background task's output instead of guessing. (If two sessions
   race, the second boot exits with EADDRINUSE — re-probe and carry on; the winner is serving.)
4. **Open + report.** `open "$URL"` (macOS; elsewhere `xdg-open`). Report the URL and whether the
   server was freshly booted or already up. The page streams updates itself — nothing to poll.

## Guardrails

- Never double-boot; the probe decides, EADDRINUSE is the backstop.
- Never kill whatever else answers on the port — redirect via `HANDS_PORT` instead.
- The serve process belongs to this session's background tasks; if the principal asks to stop it,
  `TaskStop` it. **Never `pkill -f "hands.*serve"` (hands#77)** — that pattern matches the MCP
  server's own process path too (`.../plugins/cache/hands/hands/<sha>/dist/server.mjs` contains
  both `hands` and `serve` as substrings) and has killed every station's MCP server machine-wide in
  practice, not just the dashboard. If `TaskStop` isn't available (its task id is unknown), fall
  back to the pidfile `hands serve` itself writes: `kill "$(cat <coordinationDir>/dashboard.pid)"`
  — precise by construction, no pattern to over-match. `hands doctor` also reports and (`--fix`)
  clears a stale pidfile if the process is already gone.
