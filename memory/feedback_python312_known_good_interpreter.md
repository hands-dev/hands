---
name: feedback_python312_known_good_interpreter
description: "python3.12 is the single known-good interpreter for BOTH gcloud AND fleet-runner python tests; a gcloud failure that looks like expired auth is often just the wrong Python"
metadata:
  node_type: memory
  type: feedback
  sourceDream: 2026-07-31
  sourceBranch: feature/eng-1064
  written: 2026-07-31
  originSessionId: 8c69c495-38b9-465e-9f1e-044dc5b98a35
---

`/opt/homebrew/bin/python3.12` (`brew install python@3.12`) is the one interpreter that works for both jobs on this machine. Two default `python3`s are traps:

- **Xcode/system `python3` = 3.9** — gcloud refuses it, AND the fleet-host runner code (`checkout_executor.py` / `workspace_runner.py`) raises `TypeError` on PEP 604 `X | Y` runtime type unions, so its unittests can't even import under 3.9.
- **Homebrew default `python3` is now 3.14.x** — also outside gcloud's supported range.

Practical rules:
- Prefix every gcloud/Cloud-SQL call with `CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.12`.
- Run the fleet-host runner python tests with `python3.12` explicitly (needs 3.10+).
- **A gcloud failure that reads like expired auth** (empty project, no output, blocked secret read) is *often just the wrong Python*. Set `CLOUDSDK_PYTHON=python3.12` and **retry first**, BEFORE concluding the token expired and asking Michael to `! gcloud auth login` (that path is [[feedback_gcloud_auth_expiry]] — a genuinely expired token, distinct from this).

**Why:** the wrong-Python failure mimics expired auth, and mis-reading it wastes a turn asking Michael to re-auth when a one-line env prefix fixes it.
**How to apply:** always prefix gcloud with `CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.12`; run runner tests under `python3.12`; on an "auth-looking" gcloud failure, retry with 3.12 before blaming the token. Overlaps curated [[reference_staging_gcp_access]] (which carries the CLOUDSDK_PYTHON line for gcloud).
