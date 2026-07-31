---
name: feedback_read_before_edit_barrel
description: "Always Read a barrel/index/target file before Edit — appending an export to schema/index.ts or queries/index.ts right after Writing the sibling module keeps hitting 'File has not been read yet'"
metadata: 
  node_type: memory
  type: feedback
  sourceDream: 2026-07-29
  sourceRun: 2026-07-29-1335
  sourceBranch: feature/inn-228
  written: 2026-07-29
  originSessionId: 51c19080-371a-41ee-aadf-0a3d868f7763
---

`Edit`/`Write` fails with **"File has not been read yet. Read it first before writing to it."** — or the variant **"File has been modified since read, either by the user or by a linter. Read it again..."** — whenever the harness has no current read-state for the exact path. Read the file in-session immediately before Edit/Write. This bites in more than the barrel case:

- **Barrel/index append** — appending a one-line export to `packages/db/src/schema/index.ts`, `queries/index.ts`, `route-owns-auth.ts` **right after `Write`-ing the new sibling module** — writing a file does not register it as read. Or editing `MEMORY.md`.
- **A file you just generated via another tool** — e.g. a drizzle-kit-generated migration `.sql` (`0163…`). Generating it ≠ reading it.
- **A file renamed with `git mv`** — the harness tracks read-state by path and has no record for the new path, so a `Write` to the renamed file is rejected.
- **"Modified since read"** — a linter (or the user) touched the file after your Read; Read it again before writing.

Always `Read` the exact target path first, even for a one-line append, even when you just created/generated/renamed it.

**Why:** the Write tool doesn't mark a file as read, and rename/generate/lint all invalidate read-state by path, so the follow-up Edit is rejected.
**How to apply:** `Read` the exact file you're about to `Edit`/`Write` first — barrels, freshly-generated files, `git mv` targets, and lint-touched files especially.
