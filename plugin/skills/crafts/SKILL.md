---
name: crafts
description: Survey THIS repo and propose the crafts worth establishing — the named, portable specializations (book + mise + skill) dispatched as sub-agents for the tickets they cover (hands#81/#96). Recommends a tight roster (2–5) mapped to the codebase's real seams, or says plainly that the kitchen is small and doesn't need crafts yet. Use when the principal says /hands:crafts, "what crafts should this repo have", "identify candidate crafts", "design the brigade", or when setting up a new kitchen and deciding how to organize the line.
---

# Crafts survey — design the brigade for this kitchen

A **craft** is a named, portable specialization (what a chef de partie carries): a book + mise +
skill under `craftsDir`, dispatched as a sub-agent (`hands craft brief`) for the ticket-slices it covers —
by any station, or the expo directly for read-only work. A craft earns existence only where
accumulated context pays rent across many future tickets. Your job: look at THIS codebase and
either name the crafts worth establishing, or say — plainly and without apology — that this
kitchen is too small to need any.

## 1. Gate + the existing roster

Call `hands_paths`: need `repoRoot` (stop if null — per-repo, like everything here) and
`craftsDir`. Read what already exists: `head -n 12 <craftsDir>/*.md 2>/dev/null`. If a roster
exists, this is a **re-survey**: propose only deltas — new seams the roster misses, and any
near-duplicate pairs that should merge ("ordering API" + "orders backend" = one craft). Never
re-propose what's already established.

## 2. Survey the codebase — delegated, compact

You are sizing seams, not auditing code. For a small repo, one pass yourself (top-level layout,
READMEs, manifests, rough file/LOC counts per area) is enough. For anything bigger, fan out 1–3
read-only sub-agents (Agent tool) with a compact-return contract — each maps one angle:

- **Structure**: services/packages/top dirs, languages, rough size of each area
- **Seams**: distinct domains (billing, ordering, auth), heavy subsystems (data pipeline,
  infra/CI, design system), cross-cutting specialties (migrations, performance, test infra)
- **Churn** (cheap and telling): `git log --format= --name-only -200 | sort | uniq -c | sort -rn | head -20`
  — where the work actually happens, which beats recur

Their returns accrue in your context — demand maps, not file dumps.

## 3. The smallness verdict (a first-class outcome)

If the repo is one service, one language, one deploy surface, and roughly under ~15k lines or
~50 source files — or the churn map shows everything landing in a handful of files — recommend
**no crafts**:

> *"This kitchen is small — run one generalist line. A craft's book would restate the README.
> Revisit when: a second real domain appears, a beat starts recurring (same subsystem, third
> ticket), or a specialty develops genuine gotchas worth distilling."*

Stations work fine craftless (they get a pointer, not an error). Do not manufacture a roster to
seem useful — a wrong craft fragments knowledge into half-books.

## 4. Candidate criteria — when a seam is a craft

Propose a craft only when ALL four hold:

1. **Recurs** — the beat will produce tickets for months, not once.
2. **Deep** — real gotchas, conventions, and decisions to distill; not derivable from a README.
3. **Bounded** — a ≤150-line prep book can hold its essentials.
4. **Ownable** — maps to files/dirs one craft can claim in its `covers:` line without constantly
   overlapping a DIFFERENT craft's — two crafts fighting over the same files is a sign they're
   really one craft.

Cap the proposal at **2–5 crafts** regardless of repo size. Dormant crafts are cheap (a name on
the roster); roster sprawl is not. Crafts no longer compete for seats — any station (or the expo,
read-only) can dispatch any craft — so the cap is purely about keeping the roster legible, not
about seat scarcity.

## 5. Present the proposal

One tight table in chat — no file writes yet:

| craft (slug-friendly) | covers | why it earns a book | first ticket |
|---|---|---|---|
| `ordering-api` | app.py routes, order flow | 3 of top 5 churn files; 400-handling conventions | DELETE /order 404 semantics |

Plus, when re-surveying: proposed merges. Plus always: what you deliberately did NOT propose and
why (the near-miss seams) — that's how the principal calibrates your judgment.

## 6. Establish (only with the principal's go-ahead)

On approval, found each craft as a **charter stub only** — identity, never knowledge:

```markdown
# ordering-api
> covers: app.py order routes, menu validation · founded: 2026-08-04
(Charter only — the first craft-subagent dispatched for this writes the real book.)
```

The `> covers:` line is load-bearing: it's what `hands craft mise`'s read-in check runs `git log --
<paths>` over, and what every dispatcher's roster summary shows — make it real paths/domains, not
prose. `distilled:` gets added by the first `hands craft fold` pass.

Write it to `<craftsDir>/<slug>.md` (personal by default — `hands craft promote <slug>` moves it
to the repo-shared tier once it's proven, a separate, human-reviewed step), nothing else. The
book's actual contents are the first craft-subagent's (via its return note) and the first fold
pass's to write — pre-filling "knowledge" you guessed from a survey would seed the exact
hallucinations the prep-book system exists to prevent. No `.mise.md`/`.skill.md` stub at all (an
empty operating manual is noise; the craft writes its own as it works). If the books are
configured, personal-tier charters ride the next sync automatically; shared-tier charters need a
commit + PR like any other repo file.

Hand off: *"Roster founded — run `hands craft ls` anytime to see it; any station or the expo
dispatches these by name via `hands craft brief` as work arrives."*

## Guardrails

- Read-only until the principal approves; charters are the ONLY writes, ever.
- Never write knowledge into a book you won't be the one maintaining.
- "No crafts needed" is a success, not a failure — say it when it's true.
- Don't propose crafts mechanically from the directory tree — seams, recurrence, and depth decide,
  not folder names.
