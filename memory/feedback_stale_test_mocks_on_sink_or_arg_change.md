---
name: feedback_stale_test_mocks_on_sink_or_arg_change
description: "Adding instrumentation (Sentry span/getTraceData) or a new arg to instrumented code breaks existing test doubles — budget mock updates in the same diff"
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-31
  sourceBranch: feature/eng-1064
  written: 2026-07-31
  originSessionId: a45d0fa5-735b-455c-bf0f-295134fdd2b5
---

When you add instrumentation (a new `Sentry.startSpan` / `getTraceData` call) or a new function argument to code that has existing unit tests, the test **doubles** break — and the break is separate from typecheck, surfacing only at test-run:

- **Partial `@sentry/node` mocks** that stub only `captureException`/`captureMessage` throw `undefined is not a function` the moment production calls a newly-used SDK fn (`startSpan`, `getTraceData`, `serializeTraceContext`). Add the new fn to the mock.
- **Positional-only stub lambdas** (`lambda *a: ...`) break when you pass a new **keyword** arg (`execution_beats=`). Widen to `**k`.
- **Full-barrel `vi.mock('…')` replacements** drop the real exports the module needs at import — partial-mock the barrel (spread `await vi.importActual`), and because `vi.mock` factories hoist above `const` decls, reach for `vi.hoisted`.

**Why:** these mock breaks are predictable byproducts of the instrumentation/arg change, not surprises — but they don't show in typecheck, only at test-run, so they read as a regression if unbudgeted.
**How to apply:** budget the mock updates in the same diff as the instrumentation change. The same instrumentation also trips [[feedback_data_classification_ratchet]] (regen the snapshot).
