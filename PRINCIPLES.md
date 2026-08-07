# Design principles

Why hands is shaped the way it is. A living document — added to over time, as the
reasons become clear rather than all at once. Each principle should say what we
*won't* do as clearly as what we will, because that's the part that decides
arguments later.

---

## 1. Bring your own IDE

We are not in the IDE race. An editor is a personal choice, and a strongly held
one — you should be able to keep yours and still get the whole value of hands.

**What this means:**

- hands is a **plugin and a CLI**, not an environment. It coordinates work; it
  does not host it.
- No feature should require a particular editor to be usable. If something is
  only reachable through one IDE's integration, it isn't finished.
- The surfaces we own are the ones that are genuinely ours: the bus, the books,
  the dashboard, the CLI. Not the place you write code.

**What we give up by this:** the tight in-editor affordances an
IDE-first product could offer. That's the trade, and it's deliberate — the
editor is the one part of a developer's setup where taste is not negotiable, and
a coordination layer that demands you change editors will simply not be adopted.

---

## 2. Station details are available, but obscured by default

Most code a station writes will never be read, and doesn't need to be. The
default posture is that you **don't** watch the work happen.

**What this means:**

- It should be **rare** that having station terminals open is necessary. If a
  normal day requires watching panes, something is wrong with the tooling, not
  with the user.
- Detail is *available on demand*, never *required by default* — you can always
  drop into a station and see everything, but you shouldn't have to in order to
  know what's going on.
- The summary surfaces carry the truth: the rail, the dashboard, `hands doctor`,
  `hands logs`. If the only way to learn something is to read a pane, that fact
  is missing from the tools.
- Corollary: **anything you'd have to open a terminal to discover is a gap.**
  "Is this station actually moving?" and "what has it got armed?" were both
  answerable only by hand until recently — that's the shape of the bug this
  principle predicts.

**What we give up by this:** the reassurance of watching. Some people will want
to, and they should be able to — but the product optimises for the case where
you trust the line and read the pass.

---

<!--
Add principles here as they earn their place. Keep the same shape:
what it means, what it costs, and what it rules out.
-->
