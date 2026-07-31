---
name: project_feature_maturity_rubric
description: Feature-maturity rubric (0–6 eng maturity ladder) — step one of a company-wide automation epic
metadata: 
  node_type: memory
  type: project
  originSessionId: 3d6cac4d-692f-47e4-91fb-7f58e8be9b3a
---

Company-wide initiative to define + eventually automate **feature maturity across
engineering**. Step one shipped as a doc: `docs/feature-maturity-rubric.md`
(created 2026-07-07, branch `feature/notification-catalog`).

**The ladder (higher = more mature):** 0 Not Started · 1 Not Working (floor once
dev begins) · 2 Mostly Not Working · 3 Mostly Working · 4 Working+Not Observed ·
5 Working+Observed · 6 Working+Observed+Administerable (ceiling). Severity-anchored:
P0→1/2, P1→3, ≤P2→4, +observable(any surface: admin/Mixpanel/Sentry/Slack)→5,
+single control surface→6. "Administerable" = one authoritative control surface
(a code registry counts — e.g. shared push catalog; HDS taxonomy draft→publish is
the operator-UI exemplar); "default relevant" unless argued N/A.

**Miro feature board** (uXjVH-IYb0I) is the company-viewable artifact from the
epic vision — a feature inventory with columns Quadrant / Layer (Spine/Both) /
Value / Design / **Eng. Readiness** / Design LOE / Eng LOE / Priority / Status /
Assignee, keyed by **No.** (the stable feature id). The rubric owns only the
**Eng. Readiness** column (rename target: Eng. Maturity), scale **expands 1–5 →
0–6**. Binding is standalone+cross-ref for now (nothing auto-writes the board).
No Miro MCP is connected in this session.

**Evaluator architecture** (designed 2026-07-07, `docs/feature-maturity-evaluator.md`):
runs at **tag cut** (`push: tags: v*`, new non-blocking `engineering-maturity-eval.yml`,
NOT per-PR — corrects the rubric doc's older per-PR framing). Registry = **Linear
projects** (issues-in-project = feature's tickets; project id/slug = stable key,
supersedes Miro No.). Feature→code/signal mapping = **LLM-inferred each run**
(event namespaces auth./claim./photos./mcp. + Sentry op-tags already approximate
features). Evaluator = **hybrid** (deterministic signals bound the rung; LLM
adjudicates human AC + rationale). Telemetry = **downgrade-only gate** (Sentry
error-rate via existing `apps/web/src/lib/sentry-api/` + Mixpanel funnels can cap,
never raise). Outputs = committed `maturity/snapshots/<tag>.json` + Linear
write-back (rung field or `maturity/N` label + rationale status update) + Slack/
Release delta summary. **Human pin wins** (`maturity-override/N`). Gherkin =
**static v1** (live `/qa` browser exec deferred; e2e is `if:false`). New package
`packages/maturity-eval/`. Roadmap P0(done)→P1 foundations(Pn doc + Linear
registry)→P2 offline core→P3 telemetry gate→P4 write-back→P5 CI→P6 Miro/admin/
live-Gherkin. **Missing secrets:** `LINEAR_API_KEY` (MCP is interactive-only) +
`MIXPANEL_API_SECRET` (Sentry/OpenRouter/Slack/GCP already in CI).

Each rung's AC are tagged `auto` (bot-checkable) vs `human` (LLM judges).

**Scope scoring = SPEC-RELATIVE (strict)** (decided 2026-07-07): maturity is
relative to a feature's *current* spec; every feature is re-scored each tag cut.
Adding unbuilt scenarios to an existing feature **intentionally lowers its rung**
(coverage gap) with no code change — the fix is to build or de-scope. New features
are their own rows (rung 0/1), never drag others down. Two down-transition types:
spec-driven vs regression-driven (telemetry gate). Guardrail = human pin + surface
drops with confidence/rationale (LLM jitters ±1).

**De-scope convention = `@parked` Gherkin scenario tag, lightweight** (decided
2026-07-07): tag a scenario (or Rule/Feature to cascade) `@parked` to exclude it
from scored scope; parked≠deleted (stays as roadmap); no required reason/sign-off
(review culture is the check); `# park: <why>` comment encouraged. Visible — listed
per feature in the snapshot (`record.parked`). Implemented in
`packages/maturity-eval/src/gherkin.ts` `partitionGherkin` (strips parked before
scope inference + adjudication); wired into `evaluate.ts`; typechecks + verified in
dry-run.

**P3 telemetry downgrade gate BUILT** (2026-07-07, `packages/maturity-eval/src/signals/`):
`createTelemetryProvider` composes Sentry (primary) + Mixpanel (optional denominator)
+ pure `deriveSeverity` policy. Sentry = count `event.type:error` w/ `operation:<ns>.*`
in `environment:production`, current-window vs prior-window (mirrors
`apps/web/src/lib/sentry-api` querySentry, replicated standalone). Mixpanel = legacy
`/api/2.0/events` total for scope.eventNames (rate denominator; skipped if no secret).
Policy: **min-volume guard first** (≥5 errors or no cap — pre-scale safety); rate path
≥40%→P0 / ≥10%→P1; spike path ≥4×&≥20→P0 / ≥2×→P1; severity→cap via SEVERITY_CEILING;
downgrade-only. Fails safe to `stubTelemetry` (no cap) when unconfigured/dry-run/query
fails; **prod-only so staging never downgrades prod**. Scope gained `eventNames` (LLM
infers key success events as denominator). Pure policy unit-tested (10 tests, vitest);
typecheck clean; dry-run still offline. Activate w/ `SENTRY_API_TOKEN`+`SENTRY_ORG_SLUG`
(+`MIXPANEL_API_SECRET`, `MATURITY_TELEMETRY_WINDOW_DAYS`). then P5 CI workflow on `push: tags: v*`.

**P4 Linear adapter BUILT** (2026-07-07, `packages/maturity-eval/src/registry/linear.ts`):
`LINEAR_API_KEY` IS a GitHub secret (used by `.github/workflows/staging-cycle-gate.yml`,
raw `Authorization: <key>` header, POST api.linear.app/graphql — adapter mirrors this
standalone). Read: `loadLinearRegistry` — selection via `LINEAR_FEATURE_INITIATIVE`
(initiative id) else all projects; key=project slugId, externalId=project id,
gherkin=content||description, tickets=issues, override parsed from a
`maturity-override: N (reason)` line in project doc (no label-schema dependency).
Write-back: `writeBackMaturity` posts a **project status update** (rung+rationale+cap/
parked) + sets native **project health** (rung 5-6→onTrack, 3-4→atRisk, ≤2→offTrack);
gated behind `--write`; degrades to logged failure (never fails eval); retries w/o
health if enum differs. CLI gained `--source local|linear` + `--write`. FeatureInput
gained `externalId`. Typecheck clean; tests 10/10; local dry-run + no-key linear (exit 1)
verified. **NOT run against live Linear** — validate GraphQL field/mutation names
(projectUpdateCreate, initiative.projects, project.content, health enum) on first run.

**P5 CI workflow BUILT + END-TO-END VALIDATED** (2026-07-07):
`.github/workflows/engineering-maturity-eval.yml` — `push: tags: v*` +
`workflow_dispatch` (inputs: source/write/tag), non-blocking, own concurrency,
`pnpm install --no-frozen-lockfile` (pkg not in lockfile yet), step-summary table +
snapshot artifact. Secrets all exist in GH (LINEAR/OPENROUTER/SENTRY/MIXPANEL);
`LINEAR_FEATURE_INITIATIVE` should be a repo var.
**Live test:** created Linear initiative **Feature Catalog** (id da313259-45e2-43a5-8a55-51a0ed2fbb7c)
+ project **"View public &tag page (web)"** (id 89ca0bfb-757f-42f8-b7c5-b484ee311da2)
with Gherkin (incl a @parked NFC scenario) in its description. Ran the REAL LLM eval
locally (OPENROUTER_API_KEY from apps/api/.env.local, model `anthropic/claude-haiku-4-5`
via MATURITY_EVAL_MODEL) → **rung 3 / Mostly Working, conf 0.62**, @parked excluded,
coherent rationale (P1 gaps: no tests + no observability). Wrote back via Linear MCP
`save_status_update` (type project, health atRisk) — confirms adapter write shape is
API-correct. **Adapter's raw GraphQL read/write still un-run against live Linear.**
**KEY LIMITATION found:** scope inference is BLIND → LLM hallucinated pages-router paths
(repo is app-router), substring matcher hit marketing files not real feature code →
rung leans on Gherkin not verified code. FIX: feed real repo file tree to scope step +
verify inferred paths resolve. LINEAR_API_KEY is GH-secret-only (not in gcloud/local).
**CODE-GROUNDING FIX DONE** (2026-07-07, `packages/maturity-eval/src/repo.ts` +
scope.ts/code.ts/evaluate.ts): scope inference now fed a real **directory digest** +
**lexically-ranked candidate files** (asset-filtered) and told to use only real paths;
matching replaced crude substring `globStem` with **anchored `globToRegExp`/`matchGlobs`**
→ CodeSignals gained `resolvedPaths`/`unresolvedPaths` (hallucination check). Re-ran the
same &tag feature: blind→rung3/conf0.62 w/ hallucinated `pages/[andtag].tsx` + marketing
false-positives; grounded→**rung4/conf0.72, 8 real paths, 0 unresolved** (found
public-andee.ts, PublicProfileViewEvent/PublicLinks/ClaimTag* components, profile-links
api). Posted corrected 4/6 status update to the Linear project. Added `repo.test.ts`
(6 tests incl marketing-regression guard); 16 tests total green; typecheck clean.

**COMMITTED + CI-VALIDATED** (2026-07-07). Branch `feat/eng-maturity-framework`
(off main, pushed; commits 4d5d7647→596c61bf). Admin "Feature Maturity" page built
(`apps/admin/.../tools/feature-maturity`, reads live from Linear via own GraphQL).
Set GH secret `OPENROUTER_API_KEY` (from apps/api/.env.local) + repo var
`LINEAR_FEATURE_INITIATIVE=da313259...`. Miro skipped this pass (user).

**CI end-to-end (run 28901292300, workflow `engineering-maturity-eval.yml`):**
READ path ✅ validated live — source=linear read the Feature Catalog (1 project),
2500 repo files (grounding), real LLM (haiku) → **rung 4**, @parked excluded,
snapshot+summary+artifact. WRITE ❌ blocked: `projectUpdateCreate` passed validation
but failed permission — **`LINEAR_API_KEY` GH secret is READ-ONLY** ("Invalid scope:
`write` required"). Write mutation shape is correct (already also validated via MCP).
WRITE now ✅ too: added write-scoped GH secret `LINEAR_MATURITY_KEY` (workflow prefers
it, falls back to read-only `LINEAR_API_KEY`); run 28901708009 posted rung 4 + atRisk
health back to the project (verified via MCP get_status_updates). **Full loop live in
CI end-to-end.** (User's write key was pasted in chat — recommend rotating.)

**Only-on-change writes + Slack** (2026-07-07, decided w/ user): status updates are
**immutable append-only, written ONLY when rung changes** (or first eval) — read prior
rung from project's latest update (`latestRung`), skip write if effectiveRung===priorRung.
Kept status-update surface (not a separate doc). Slack alert to **#dev-team** via
`SLACK_WEBHOOK_DEV_TEAM` secret + `slackapi/slack-github-action@v2.1.1` (webhook-type
incoming-webhook, payload-file-path); posts only changed features (from→to, ↑/↓). Repo
already uses this webhook in mobile-deploy. FeatureInput/MaturityRecord gained `priorRung`.
Commit 3a0f2ac6. Jitter fix: `temperature: 0` on OpenRouter call (commit 07e4adbe) —
scores now deterministic/repeatable (stable≠correct; use override if wrong).

**SCENARIO-BASED + EVIDENCE-ONLY scoring** (2026-07-07, major model change): feature
Gherkin IS the full 6/6 spec, scenarios tagged by tranche — `@core`(+`@happy`)→rungs
1-4, `@observed`→5, `@administerable`→6, `@parked`=excluded. Rung is DERIVED per-scenario,
not a holistic LLM guess; unproven scenarios = the explicit GAP. **Evidence-only (user's
call): code-presence is NOT proof.** @core `verified` only via a passing test (cited +
we verify the file is in the test context; prod-telemetry-as-evidence is the pending 2nd
source); code-without-test = `unverified` (no credit); `not_done`=absent. @observed/@admin
are existence checks (verified if the surface exists). Consequence by design: untested
features score LOW (Claim a tag=6 well-tested, Phone auth=3, View public tag=1 no tests).
Gap labels "needs proof (test)" vs "needs implementation". Files: `assess.ts` (assess +
deriveRung + gap), `gherkin.classifyScenarios`, `code-context.ts` (test+code snippets),
`repo.rankTestFiles`, `format.ts`. **3 bugs found+fixed during CI:** (1) `pnpm -F` cwd/args
[fixed earlier]; (2) zod rejected `test:null` → coerce nullish; (3) LLM decorates citation
"path (implied by…)" → extract path token before includes-check. code-context must stay
SMALL (~10 files×2500ch) or the LLM request fails silently → all not_done → rung 1.

**DURABLE DETECTION: deterministic `@covers` verification** (2026-07-08): the LLM
scenario↔test matcher jittered a feature **6↔2** between runs (truncated test-context +
nondeterministic matching). Fixed by REMOVING the LLM from scoring entirely: scenarios
carry `@covers(<repo-path>[::<case>])` links; a scenario is `verified` iff every cited
path EXISTS in the repo (existence-only — leans on "tag cut from green suite = linked
test passes"; running tests for real pass/fail is the planned rigor upgrade). No `@covers`
or a broken link → `unverified`. New `src/verify.ts` (`verifyScenarios`); `assess.ts` now
only holds `deriveRung`/`computeGap`; deleted the LLM `assessScenarios` + `code-context`
reads from the scoring path (LLM survives only for scope→telemetry). `gherkin.ts` tag
tokenizer changed to `/@[\w-]+(?:\([^)]*\))?/g` so `@covers(path::case with spaces)` parses.
**Verified twice-run IDENTICAL: Claim 4, Phone auth 3, View public 3** (was jittering).
Authored `@covers` on the 3 Linear pilots' core scenarios linking real tests (e.g. Claim →
claim-and-photo-upload.feature, tag-search.service.test.ts, paid-invite-flow.feature).
31 unit tests green. **Lean on the CI merge gate for "green"** (2026-07-08, user's call): don't run tests
in the evaluator — a test on `main` passed the required suite to get there. Record
PROVENANCE per verified scenario (`AssessedScenario.verifiedBy`): `gate` = @covers points
at a unit/integration test (`.test.ts`/`.spec.ts`) the required CI suite runs → green on
main; `existence` = ungated file (e.g. `.feature`, since **e2e is `if:false`**) → weaker,
flagged `[e2e/existence]` in the rationale. Both count toward the rung (rung unchanged
4/3/3). This REPLACES the "actually run tests" follow-on. **CAVEAT:** the CI unit jobs
(unit-tests-api/db/mobile in staging-pr-validation) are PATH-FILTERED and apps/web may not
be gated — "gate-verified" slightly over-claims; tightening = map @covers→required-check +
guard against `.skip`/`.todo`. Claim's rung 4 = 2 gate + 2 existence(e2e) links.

**ADMIN FEATURE REGISTRY + DRILL-DOWN BUILT + COMMITTED** (2026-07-08, commit
a1ba8062 on `feat/eng-maturity-framework`): reframed the admin tool **"Feature
Maturity" → "Feature Registry"** — maturity is ONE dimension; features are
**bifurcated by app** (web/mobile/mcp/api; NOT browser/device/platform). Model =
**one Linear project per (feature, app)**. New shared `packages/maturity-eval/src/registry/app.ts`
`resolveApp({name,labels})→FeatureApp` (Linear project **label** first, then a
trailing `(web)`-style **name-suffix** fallback; MCP `save_project labels:[]`
does NOT create project labels, and there's no create-project-label tool, so the
**suffix is the working mechanism**). Admin: renamed data lib →
`feature-registry.ts` (+`app`, fetches `labels`), list page **groups rows into
per-app sections**, new **`[slug]` drill-down** page = scenarios by tranche with
✓/✗ + `[gate]`/`[e2e]` provenance + `@covers` links to GitHub blobs + tickets +
gap-to-6/6. Verification is computed **LIVE**: `feature-detail-live.ts`
(server-only) does a two-step Linear query (id/slug list → single project by UUID,
low complexity) + `github.ts` `repoFileTree()` (`git/trees/main?recursive=1`, needs
net-new **`GITHUB_TOKEN`**), then the PURE `feature-detail.ts` `assembleDetail`
reuses the evaluator's own `classifyScenarios`→`verifyScenarios`→`deriveRung` so the
drill-down ALWAYS agrees with the score. `assembleDetail` kept free of
`server-only`/`@/` so it's tsx-unit-testable (`apps/admin/__tests__/feature-detail.test.ts`,
10/10; admin has no vitest — tests run via tsx like test:auth). Verified: tsc -b
clean, pkg suite 36/36, **live path** vs real Linear+GitHub → View public = rung 3,
app web, happy gate-verified, gap+parked correct; both routes HTTP 200 no errors
(visual render is admin-auth-gated + browser ext not connected → left to user, dev
server was running on :3002). **Renamed the 3 pilots for truthful app assignment:**
Claim a tag→**Claim a tag (web)** (its @covers live in apps/web + packages/services/tags),
**Phone auth / login (mobile)** (user: no web auth, mobile-only), View public already
`(web)` → registry groups **Web (2) + Mobile (1)**. slugIds unchanged (drill-down
links stable). Icon nav `Gauge`→`Boxes`, route `/tools/feature-registry`. Added a provenance UI (2026-07-08):
detail page "How to read this" strip + list-page note make each region's origin explicit
(Linear = feature/scenarios/tickets/health; live GitHub = Proof/proving-test columns; rung
= derived; **detail rung is recomputed LIVE, list rung is the last tag-eval value from Linear**).
**`@na` tranche waivers** (2026-07-08, user-driven): the rubric said administration is
"default relevant unless argued N/A" but had NO way to argue it — deleting the
`@administerable` scenario just made the gap nag "author the control-surface criteria" and
pinned the feature below its true ceiling. Added `@na`: tag a scenario `@administerable @na`
(name = rationale) → `classifyScenarios` returns it as a `waiver` (not a scored spec);
`deriveRung(assessed, naTranches)` now returns a **`ceiling`** (admin N/A → 5, observed N/A
→ 4; ladder is cumulative so observed N/A also caps 6) and SKIPS the gap for waived rungs.
When `rung === ceiling` the drill-down shows a "Fully mature" badge + "at applicable ceiling
(N/6)"; the waived tranche renders an "N/A: <reason>" card. `MaturityRecord` gained
`ceiling` + `waivers`; write-back rationale appends an N/A note. User chose "cap at ceiling,
mark complete" (not "waive to 6"). Restored View-public's `@administerable @na` in Linear →
verified live rung 3 / **ceiling 5** / gap [4,5] (no gap-6). Also this session: scenarios are
now an **expandable accordion** (collapsed=status/name/proof, expanded=full Given/When/Then
steps [new `ScenarioSpec.steps`] + `@covers` links + evidence; no more horizontal scroll),
admin content widened max-w-4xl→**max-w-6xl** (global), and paginated the Linear catalog read
+ drill-down slug lookup (Greptile P1s). Docs: `@na` documented in feature-maturity-evaluator.md.

**Miro Yellow-Quadrant → Feature Catalog (2026-07-08):** cataloged the Miro board's
(`uXjVH-IYb0I`, table widget `3458764677593478307`) **Yellow quadrant** (10 medium-readiness
features) into the Feature Catalog. Decisions: **per-(feature,app)** split, **skip** the
existing `View public &tag page (web)` (No.7), **untested scenarios included as visible gaps**.
Created **13 projects** (save_project needs `addTeams:["Engineering"]` + `addInitiatives:
["Feature Catalog"]`; app via **name suffix**, project labels aren't MCP-creatable):
Connections/Contacts (mobile+mcp), Peer Questions (mobile+mcp), Signals review (mobile+mcp),
View My tag (mobile), View other tag (mobile), View Home Screen (mobile), Location tracking
(mobile+mcp), Push Notifications (mobile), Private+connected signal encryption (mobile).
Grounded via 3 Explore passes → real `@covers` to `apps/api/__tests__/routes/*` +
`packages/db/src/queries/__tests__/*` (all on origin/main). **Mobile has ZERO component
tests** → pure-UI features score low; **encryption shelved** → rung 1. Spot-verified live,
no broken @covers: Push(mobile) 4/6, Peer Q(mobile) 4/5, Connections(mcp) 4/5, Home 1/5,
Encryption 1/5. `@administerable @na` on andee-to-andee/no-operator features caps ceiling 5.
Also hardened the registry (Greptile P1s on #2016): paginated the **list** query (was
100-capped) + show "Maturity unavailable"/"not checked" instead of a misleading score when
the GitHub tree is degraded (no GITHUB_TOKEN).

**PROD RELEASE (2026-07-08): admin Feature Registry live on admin.and.com.** Promoted
staging→main (PR #2018, merge commit `5b7b3be1`) + cut annotated tag **`v1.42.21`** →
production-deploy-orchestrator succeeded (terraform-apply → deploy-admin → prod smoke →
verify all green). `admin.and.com/tools/feature-registry` serves (307 auth-gate). The 10
Miro yellow-quadrant rows link to it via a new **"Admin Feature Details URL"** (link-type)
column → `admin.and.com/tools/feature-registry/<slugId>`. **Admin runtime env wiring**
(PR #2017, `chore(infra)`): `admin-app` Cloud Run gets `LINEAR_API_KEY` (reuses the
existing **repo-level** read-only `LINEAR_API_KEY` secret), `GITHUB_TOKEN` (from **env-scoped**
`ADMIN_GITHUB_READ_TOKEN` in the staging+production GH environments — fine-grained PAT,
Contents+Metadata read on the one repo), `LINEAR_FEATURE_INITIATIVE` (TF default = catalog
id). Secrets are **conditional** (created/mounted only when the value is non-empty — GCP
rejects empty-payload versions; an unset value must never fail the terraform-apply gate).
`TF_VAR_*` added to every workflow that applies prod/staging state (prod orchestrator,
preview-deploy, staging orchestrator); staging-pr-validation uses placeholders (PR-controlled
code). **Gotcha:** the token must be set BEFORE terraform-apply runs — v1.42.21's apply
predated the secret, so a `workflow_dispatch --ref main -f force_terraform=true` redeploy is
required to mount GITHUB_TOKEN (var-value change isn't a file diff, so force_terraform is
mandatory). Preview env (`admin_app_preview` in production/main.tf) deferred — it data-sources
prod secrets cross-state.
**Shipped to staging: PR #2016** (base staging, head feat/eng-maturity-framework, commit f285d346→951b7c7a),
tracked by **ENG-1204** (cycle 23, the first ticket for the whole framework — it was ticketless).
Cycle-gate + the maturity `evaluate` workflow both PASS on the PR. PR body carries the pre-merge
checklist (remove temp workflow branch-trigger/write, rotate Linear key, add admin GITHUB_TOKEN).

**NEXT tasks:** (1) make @observed/@administerable test-proven ("5-6 testable"); (2)
optionally tighten gate-provenance (which tests the required checks actually run) +
skip-guard. Plan file: `.claude/plans/i-m-trying-to-come-inherited-naur.md`.
**PRE-MERGE TODO (carried):** remove temp workflow branch-trigger + branch write-enable;
the pnpm lockfile is now committed (a1ba8062) so CI can drop `--no-frozen-lockfile`;
rotate the pasted Linear key; add `GITHUB_TOKEN` to the admin runtime env for live
drill-down verification; refresh Notion + `docs/` naming to "Feature Registry (admin) /
maturity dimension".

**3-feature catalog validated + Notion doc** (2026-07-07): Feature Catalog now has 3
projects — View public &tag page (rung 3), **Phone auth / login** (id 1a40a6e3, rung 3),
**Claim a tag** (id 586f7cd7, rung 5). CI run 28902512269 read all 3, wrote back the 2
new (only-on-change skipped the unchanged one), Slack posted both to #dev-team. Architecture
documented in Notion: "Engineering Feature-Maturity Framework" (id 39651f45-5bba-8157-aca5-d3129c50a758,
under Engineering→Architecture e2051f45...). PRE-MERGE TODO still: remove temp workflow
branch-trigger + branch write-enable, commit pnpm lockfile (drop --no-frozen-lockfile),
rotate the pasted Linear key.

**CI gotchas learned:** (1) `pnpm -F <pkg> eval -- args` changes cwd to the pkg dir
AND drops args → run `pnpm exec tsx packages/maturity-eval/src/cli.ts` from repo root
w/ explicit `--repo-root $GITHUB_WORKSPACE`. (2) Linear rejects over-complex queries
w/ HTTP 400 — keep `first:` small (projects 50 × issues 25). (3) commitlint
subject-case=lower-case: ENTIRE subject lowercase (no "Linear"/"pnpm"). (4)
workflow_dispatch needs the workflow on the DEFAULT branch — used a TEMP
`branches: [feat/eng-maturity-framework]` push trigger + temp write-on-branch to
validate; **REMOVE both before merge**. (5) OPENROUTER/MIXPANEL_API_SECRET are NOT
GH secrets (only MIXPANEL_TOKEN, a client token); Mixpanel query needs a Service
Account (mixpanel.ts uses legacy secret auth — update for SA). Workflow now
auto-writes at real tag cut (ref_type==tag). pkg still not in pnpm-lock
(--no-frozen-lockfile).

**Offline core BUILT** (`packages/maturity-eval/`, P2): typechecks + runs in
dry-run (no key/network → heuristic caps at rung 4). Rubric+severity encoded as
data (`rubric.ts`); OpenRouter direct-fetch (`llm.ts`, mirrors apps/api); LLM
scope infer + adjudicate; deterministic fs code signals; telemetry = STUB
(TelemetryProvider, P3 seam); registry = local JSON fixtures (FeatureInput[]
contract, P4 swaps Linear adapter); writes `maturity/snapshots/<tag>.json`; NO
external writes. Not in pnpm-lock yet (ran via hoisted tsx/zod); default model =
env `MATURITY_EVAL_MODEL` (placeholder slug, point at repo standard).

**`Pn` severity** — DONE (`docs/pn-severity.md`, 2026-07-07). Deliberately
**functional-impact based, NOT blast-radius/user-count** (only a few beta testers,
so # users affected is meaningless). P0=core job impossible→caps rung 1/2 ·
P1=important secondary/edge broken, core works→caps rung 3 · P2=minor
edge/degradation→rung 4 ok · P3=cosmetic→rung 4 ok. Severity describes the bug;
the rubric rung describes the feature (worst open bug caps the rung). Tie→round up.

**Deferred next step:** **maturity transitions & the integrated environment** —
how features move between rungs, esp. down-transitions on a P0 regression (the
telemetry downgrade gate is a first instance). Next build step after this = Linear
feature-catalog convention + `packages/maturity-eval` offline core (P2). Links: [[feedback_brand_name_ampersign]] (product is "&", not
"Ampersand").
