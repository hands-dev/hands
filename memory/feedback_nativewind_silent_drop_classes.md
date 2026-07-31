---
name: feedback_nativewind_silent_drop_classes
description: "Mobile NativeWind silently drops unknown Tailwind classes (no error, no style) — brand green is the `brand` token (#219f55), not a `primary-green-*` scale; verify against apps/mobile/tailwind.config.js"
metadata: 
  node_type: memory
  type: feedback
  sourceDream: 2026-07-29
  sourceRun: 2026-07-29-1335
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

In the mobile app, **NativeWind silently drops unknown Tailwind classes** — no error, the element just renders with no style. The palette is limited: the brand green is the **`brand`** token (`#219f55`) and a light surface is `ink-subtle` — there is **no `primary-green-*` scale** (only `primary` is defined).

Always verify class names against `apps/mobile/tailwind.config.js` before using them, or a component ships with a missing background/color that looks like a layout bug.

**Why:** an invalid class produces no error and no style, so the miss surfaces only as a visual bug later.
**How to apply:** check `apps/mobile/tailwind.config.js` for the real token names (brand green = `brand` #219f55) before writing NativeWind classes.
