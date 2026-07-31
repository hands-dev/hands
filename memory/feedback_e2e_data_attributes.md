---
name: E2E tests must use data attributes
description: All e2e test assertions against HTML must target data-testid or data- attributes, never text content, CSS, or implementation details
type: feedback
---

E2E test assertions against HTML must target `data-testid` or other `data-` attributes — never specific text content, CSS classes, colors, or implementation details like button labels.

**Why:** Text and styling are implementation details that change frequently and create brittle tests. Data attributes represent stable semantic contracts between components and tests.

**How to apply:** When writing e2e step definitions, use `getByTestId()` and `toHaveAttribute()` for assertions. If the element doesn't have a `data-testid`, add one to the component. This is also codified in CLAUDE.md under "E2E Test Assertions".
