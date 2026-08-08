---
name: recipe
description: Draft a recipe — a structured menu item (title, description, gherkin-flavored acceptance criteria) that replaces the old free-text "specials" list (hands#96/#137). Interviews the principal, writes the file, and can promote it straight onto today's menu. Use when the principal says /hands:recipe, "draft a recipe", "add this to the menu", or wants to define a piece of work with real acceptance criteria instead of a one-line priority.
---

# Recipe — draft a menu item

A **recipe** is a single markdown file: a title, a short description, and acceptance criteria as
GitHub-flavored-markdown checkboxes. It replaces `priorities.md`'s flat ranked list — a recipe
carries enough shape that "is this done" is closer to verification than vibes, without becoming a
form nobody fills in. The **menu** is the small set of recipes with `state: menu` (ranked) that the
expo actually works against right now; everything else sits in the **book** (the larger backlog).

You are drafting FOR the principal, in their voice — this is their content, not yours to invent.

## 1. Gate

Only the principal drafts recipes (they may ask you to run this on their behalf, but the content is
theirs). If a station or the expo lands here without the principal present, stop and say so — this
isn't a survey-and-propose skill like `/hands:crafts`.

## 2. Interview — keep it short

Ask, in one message if you can:

1. **What is this?** One line — becomes the title.
2. **Why / what's the shape of the work?** A short paragraph — becomes the description. Don't
   pad it; a recipe can be three sentences.
3. **How will you know it's done?** Each answer becomes one acceptance criterion, written
   gherkin-*flavored* — one sentence, loosely "given X, when Y, then Z" — not three separate
   structured fields. If the principal gives you a bare list ("fix the bug", "add a test"), turn
   each into one concrete, checkable sentence rather than leaving it as a vague fragment; ask a
   follow-up if a criterion is too fuzzy to ever mark done. 2-5 criteria is normal; more than that
   is a sign the recipe should split into two.
4. **Onto the menu now, or into the book for later?** Only a few recipes are in play on any given
   day — don't promote by default.

**Stress-test as you go, out loud, not silently:** if answering these questions is starting to feel
like filling out a form, stop and say so — a recipe nobody drafts is worse than the specials list
it replaced. Three sentences and two checkboxes is a complete, good recipe.

## 3. Write it

```bash
hands recipe new <slug> --title "<title>"
```

Then edit the file directly (`hands recipe ls` to find its path) to fill in the description body
and replace the placeholder `- [ ]` line with the real criteria, one per line, unchecked. Slug: a
short kebab-case handle for the work, not the literal title — `ordering-api-404-fix`, not
`fix-the-404-semantics-on-delete-order`.

If the principal wants it on the menu now:

```bash
hands recipe promote <slug> --rank <N>
```

Rank it after whatever's already on the menu unless the principal says otherwise (omit `--rank` to
default to "last").

## 4. Hand off

*"Drafted `<slug>`\<if promoted\>, onto the menu at #N\</if\>. `hands recipe ls` shows the full
roster; `hands recipe history <date>` answers what was on the menu on any past day."*

## Guardrails

- Never invent acceptance criteria the principal didn't actually say — a fuzzy answer gets a
  follow-up question, not a guess dressed up as a checkbox.
- Never promote onto the menu without the principal saying so explicitly this session.
- Editing an EXISTING recipe (not drafting a new one): read it first, change only what the
  principal asked to change, and don't silently reformat criteria they didn't ask you to touch.
