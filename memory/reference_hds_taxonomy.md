---
name: HDS taxonomy location
description: Where the Human Decimal System taxonomy lives in the ampersand monorepo, with helpers and what's missing.
type: reference
originSessionId: 3c920124-da89-4e83-a899-105b978a801a
---
**File**: `packages/db/src/constants/hds.ts`

The HDS (Human Decimal System) is a hierarchical taxonomy for classifying personal identity data. Codes are dotted decimals — `4.3.4.2` is "Dietary Preferences" under "Dietary Restrictions" under "Food & Drink Preferences" under "Home & Daily Life".

10 top-level dimensions (`0` through `9`): Self & Identity, Body & Health, Mind & Growth, Relationships, Home & Daily Life, Work & Money, Interests & Media, Activities & Hobbies, Places & Travel, Time & Meaning.

**Existing helpers** in that file:
- `isValidHdsCode(code)` — boolean
- `getHdsLabel(code)` — string label or undefined
- `getHdsChildren(code)` — direct children only
- `getHdsTopLevel()` — the 10 top-level dimensions
- `hdsCodeToKey(code)` — slugified key

**Missing** (add when needed): `getHdsParent(code)` and `walkAncestors(code)`. Trivial implementation — split on `.`, pop segments. Used by node-level visibility inheritance.

**Source-of-truth doc** referenced in the file header: `engine/docs/reference/taxonomy/HDS_CODES.md` (in a separate engine repo, not ampersand).

**Tests**: `packages/db/__tests__/hds.test.ts`.
