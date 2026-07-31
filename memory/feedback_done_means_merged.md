---
name: Done means merged to staging
description: Don't mark Linear tickets as Done until the PR is merged into staging — use In Review while the PR is open
type: feedback
originSessionId: ca0541bf-8557-4205-821e-373a202651f4
---
Don't mark Linear tickets as "Done" when the code is committed on a feature branch. Done = merged to staging.

**Why:** The team's workflow treats "Done" as shipped to staging, not just code-complete. Marking tickets Done prematurely misrepresents sprint progress.

**How to apply:** After committing, move tickets to "In Review" (or leave in "In Progress") while the PR is open. Only mark "Done" after the PR merges into staging.
