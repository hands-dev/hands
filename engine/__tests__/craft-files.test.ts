import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config.js";
import {
  appendRawNote,
  booksDistilledRecently,
  buildFoldContext,
  capText,
  checkpointTicketProblem,
  composeChit,
  craftAgentPath,
  craftKnown,
  craftSkillPath,
  exportPendingCraftNotes,
  FOLD_READY_THRESHOLD,
  formatRawTaggedLine,
  formatRosterContext,
  isCdcCheckpoint,
  isRoleCraft,
  listCrafts,
  materializeCraftAgents,
  nearestCraftSlugs,
  parseCdcVerdictBlock,
  parseCraftHeader,
  parseCraftNoteBlock,
  readMiseMerged,
  readRawMerged,
  rebuildRawSection,
  roleCraftFoldNudges,
  stampCraftFocus,
  stampCraftReadiness,
  sweepHeldSeatHeader,
  upsertMiseLine,
} from "../src/crafts.js";
import { resetRepoInfoCache } from "../src/paths.js";
import { craftFiles } from "../src/remote.js";
import { craftRosterContext, pathsReport } from "../src/server.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-crafts-"));
  // This suite never creates its own fixture repo, so a real hands.config.json
  // in whatever repo the test process happens to run from (a worktree of this
  // very repo, when dogfooded) must not bleed in — see config.ts repoConfigPath.
  env = { HANDS_HOME: home, HANDS_TEST_HOME: path.join(home, "user"), HANDS_NO_REPO_CONFIG: "1" };
  resetConfigCache();
  resetRepoInfoCache();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  resetConfigCache();
  resetRepoInfoCache();
});

function writeUserConfig(config: object): void {
  const dir = path.join(home, "user", ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hands.config.json"), JSON.stringify(config));
  resetConfigCache();
}

describe("craftFiles", () => {
  it("slugs the craft name; books off → local crafts/ dir, personal scope", () => {
    const files = craftFiles("Ordering API", env);
    expect(files.scope).toBe("personal");
    expect(files.slug).toBe("ordering-api");
    expect(files.dir).toBe(path.join(home, "crafts"));
    expect(files.book).toBe(path.join(home, "crafts", "ordering-api.md"));
    expect(files.mise).toBe(path.join(home, "crafts", "ordering-api.mise.md"));
    expect(files.skill).toBe(path.join(home, "crafts", "ordering-api.skill.md"));
    // spelling variants converge on one craft
    expect(craftFiles("ordering api", env).book).toBe(files.book);
  });

  it("books on → inside the clone under the contributor's namespace, still personal scope", () => {
    writeUserConfig({ remote: { url: "git@example.com:x/books.git", handle: "michael", project: "proj" } });
    const files = craftFiles("saucier", env);
    expect(files.scope).toBe("personal");
    expect(files.dir).toBe(path.join(home, "remote", "journal", "proj", "michael", "crafts"));
    expect(files.book).toBe(path.join(files.dir, "saucier.md"));
  });

  it("resolves SHARED scope when a shared craft file already exists in the repo (shared wins)", () => {
    // realpath'd — repoInfo() resolves via fs.realpathSync (macOS symlinks /tmp -> /private/tmp),
    // so the expected path must go through the same resolution as craftFiles() itself does.
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, "repo-")));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const sharedDir = path.join(repo, ".hands", "crafts");
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, "ordering-api.md"), "> covers: app.py\n");
    const files = craftFiles("ordering api", env, repo);
    expect(files.scope).toBe("shared");
    expect(files.dir).toBe(sharedDir);
    expect(files.book).toBe(path.join(sharedDir, "ordering-api.md"));
  });

  it("a repo with no shared file for this slug still resolves personal, even inside a git repo", () => {
    const repo = fs.mkdtempSync(path.join(home, "repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const files = craftFiles("saucier", env, repo);
    expect(files.scope).toBe("personal");
  });

  it("accepts a `craft-`-prefixed name as an alias for a real bare slug (hands#165)", () => {
    const files = craftFiles("fleet-runtime", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.book, "> covers: hosts\n");

    const aliased = craftFiles("craft-fleet-runtime", env);
    expect(aliased.slug).toBe("fleet-runtime");
    expect(aliased.book).toBe(files.book);
  });

  it("does NOT strip the `craft-` prefix when nothing resolves either way — founding a new craft is unaffected", () => {
    const files = craftFiles("craft-mystery", env);
    expect(files.slug).toBe("craft-mystery");
  });

  it("does NOT strip the `craft-` prefix when a craft is genuinely founded under that literal name", () => {
    const prefixed = craftFiles("craft-fleet-runtime", env);
    fs.mkdirSync(prefixed.dir, { recursive: true });
    fs.writeFileSync(prefixed.book, "> covers: a craft literally named with the prefix\n");
    // the bare slug "fleet-runtime" does NOT exist here — only the prefixed one does
    expect(craftFiles("craft-fleet-runtime", env).slug).toBe("craft-fleet-runtime");
  });

  it("crafts.sharedDir config overrides the default .hands/crafts location", () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, "repo-")));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    fs.writeFileSync(
      path.join(repo, "hands.config.json"),
      JSON.stringify({ crafts: { sharedDir: "crafts-shared" } }),
    );
    const customDir = path.join(repo, "crafts-shared");
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, "saucier.md"), "> covers: sauces\n");
    const files = craftFiles("saucier", { ...env, HANDS_NO_REPO_CONFIG: undefined }, repo);
    expect(files.scope).toBe("shared");
    expect(files.dir).toBe(customDir);
  });
});

describe("craftKnown + nearestCraftSlugs — hands#165: `hands craft brief` must refuse an unknown slug loudly", () => {
  it("known:false and the full roster for a slug with no book file anywhere", () => {
    const store = new Store({ env });
    const founded = craftFiles("fleet-runtime", env);
    fs.mkdirSync(founded.dir, { recursive: true });
    fs.writeFileSync(founded.book, "> covers: hosts\n");

    const result = craftKnown("craft-fleet-runtime", loadConfig({ env }), env); // the raw injected-roster form, unresolved
    expect(result.known).toBe(false);
    expect(result.slugs).toEqual(["fleet-runtime"]);
    store.close();
  });

  it("known:true once resolved through craftFiles' alias (the real dispatch path)", () => {
    const store = new Store({ env });
    const founded = craftFiles("fleet-runtime", env);
    fs.mkdirSync(founded.dir, { recursive: true });
    fs.writeFileSync(founded.book, "> covers: hosts\n");

    const resolved = craftFiles("craft-fleet-runtime", env); // cli.ts resolves before calling craftKnown
    const result = craftKnown(resolved.slug, loadConfig({ env }), env);
    expect(result.known).toBe(true);
    store.close();
  });

  it("an empty roster reports known:false with an empty suggestion list, not a throw", () => {
    const store = new Store({ env });
    expect(craftKnown("anything", loadConfig({ env }), env)).toEqual({ known: false, slugs: [] });
    store.close();
  });

  it("nearestCraftSlugs ranks the closest typo fix first", () => {
    const known = ["fleet-runtime", "fleet-hosts", "fleet-api"];
    expect(nearestCraftSlugs("fleet-runtim", known, 1)).toEqual(["fleet-runtime"]);
    expect(nearestCraftSlugs("fleet-host", known, 1)).toEqual(["fleet-hosts"]);
  });

  it("nearestCraftSlugs respects the limit", () => {
    expect(nearestCraftSlugs("x", ["a", "b", "c", "d"], 2)).toHaveLength(2);
  });
});

describe("sweepHeldSeatHeader — hands#167: drop the retired per-station-ownership clause", () => {
  it("rewrites 'last held: DATE by AGENT' to 'distilled: DATE', keeping the timestamp", () => {
    const result = sweepHeldSeatHeader("> covers: app.py · last held: 2026-08-06 by station-2\nbody\n");
    expect(result.changed).toBe(true);
    expect(result.content).toBe("> covers: app.py · distilled: 2026-08-06\nbody\n");
    expect(result.content).not.toContain("station-2");
    expect(result.content).not.toContain("held");
  });

  it("rewrites 'last held: DATE' with no agent clause too", () => {
    const result = sweepHeldSeatHeader("> covers: app.py · last held: 2026-08-06\n");
    expect(result.content).toBe("> covers: app.py · distilled: 2026-08-06\n");
  });

  it("is a no-op on a book that already uses the current 'distilled:' header", () => {
    const input = "> covers: app.py · distilled: 2026-08-01 from 4 learnings\nbody\n";
    const result = sweepHeldSeatHeader(input);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(input);
  });

  it("is a no-op on a charter stub with no distilled/held clause at all", () => {
    const input = "> covers: app.py · founded: 2026-08-04\n";
    const result = sweepHeldSeatHeader(input);
    expect(result.changed).toBe(false);
  });

  it("leaves the rest of the book's body untouched, only the header clause", () => {
    const input = "> covers: app.py · last held: 2026-08-06 by station-2\n\n## A section\nstation-2 wrote this fact.\n";
    const result = sweepHeldSeatHeader(input);
    expect(result.content).toContain("station-2 wrote this fact."); // body prose is NOT swept
  });
});

describe("parseCraftHeader", () => {
  it("parses covers + distilled from the header line", () => {
    expect(
      parseCraftHeader("> covers: app.py, orders/ · distilled: 2026-08-01 from 4 learnings\nbody text"),
    ).toEqual({ covers: "app.py, orders/", distilled: "2026-08-01", ready: null, focus: null });
  });

  it("tolerates the pre-cutover 'last held' key (parse tolerance, not a compat shim)", () => {
    expect(parseCraftHeader("> covers: app.py · last held: 2026-08-01 by station-1\n")).toEqual({
      covers: "app.py",
      distilled: "2026-08-01",
      ready: null,
      focus: null,
    });
  });

  it("parses the ready clause (hands#92)", () => {
    expect(parseCraftHeader("> covers: app.py · distilled: 2026-08-01 · ready: 2026-08-07 by sous\n")).toEqual({
      covers: "app.py",
      distilled: "2026-08-01",
      ready: { at: "2026-08-07", by: "sous" },
      focus: null,
    });
  });

  it("parses the focus clause, genuinely separate from covers (hands#114)", () => {
    expect(parseCraftHeader("> covers: whole-board judgment · focus: quality of what ships\n")).toEqual({
      covers: "whole-board judgment",
      distilled: null,
      ready: null,
      focus: "quality of what ships",
    });
  });

  it("focus stops at the next clause, same non-greedy shape as covers", () => {
    expect(
      parseCraftHeader("> covers: app.py · focus: quality of what ships · distilled: 2026-08-01\n").focus,
    ).toBe("quality of what ships");
  });

  it("returns nulls for missing/absent content", () => {
    expect(parseCraftHeader(null)).toEqual({ covers: null, distilled: null, ready: null, focus: null });
    expect(parseCraftHeader("no header line here")).toEqual({ covers: null, distilled: null, ready: null, focus: null });
  });
});

describe("stampCraftReadiness — hands#92's sous-owned execute-mode gate", () => {
  it("adds a ready clause to a header with none", () => {
    const result = stampCraftReadiness("> covers: app.py\nbody", { at: "2026-08-07", by: "sous" });
    expect(result).toBe("> covers: app.py · ready: 2026-08-07 by sous\nbody");
    expect(parseCraftHeader(result).ready).toEqual({ at: "2026-08-07", by: "sous" });
  });

  it("adds after an existing distilled clause, not replacing it", () => {
    const result = stampCraftReadiness("> covers: app.py · distilled: 2026-08-01\n", { at: "2026-08-07", by: "sous" });
    expect(parseCraftHeader(result)).toEqual({
      covers: "app.py",
      distilled: "2026-08-01",
      ready: { at: "2026-08-07", by: "sous" },
      focus: null,
    });
  });

  it("replaces an existing ready clause rather than duplicating it", () => {
    const once = stampCraftReadiness("> covers: app.py\n", { at: "2026-08-06", by: "station-2" });
    const twice = stampCraftReadiness(once, { at: "2026-08-07", by: "sous" });
    expect(parseCraftHeader(twice).ready).toEqual({ at: "2026-08-07", by: "sous" });
    expect(twice.match(/ready:/g)).toHaveLength(1);
  });

  it("revokes (ready: null) drops the clause, reverting to plan-mode only", () => {
    const stamped = stampCraftReadiness("> covers: app.py\n", { at: "2026-08-07", by: "sous" });
    const revoked = stampCraftReadiness(stamped, null);
    expect(parseCraftHeader(revoked).ready).toBeNull();
    expect(revoked).not.toContain("ready:");
  });

  it("revoking a header with no ready clause is a harmless no-op", () => {
    const input = "> covers: app.py\nbody";
    expect(stampCraftReadiness(input, null)).toBe(input);
  });

  it("leaves body prose untouched, header line only", () => {
    const result = stampCraftReadiness("> covers: app.py\n\n## A section\nsome real content\n", {
      at: "2026-08-07",
      by: "sous",
    });
    expect(result).toContain("## A section\nsome real content");
  });

  it("prepends a header line rather than losing the stamp when there's no header at all", () => {
    const result = stampCraftReadiness("no header here", { at: "2026-08-07", by: "sous" });
    expect(result).toBe("> ready: 2026-08-07 by sous\nno header here");
  });
});

describe("stampCraftFocus — the lens a craft's ingest/lint checks against, separate from covers (hands#114)", () => {
  it("adds a focus clause to a header with none", () => {
    const result = stampCraftFocus("> covers: whole-board judgment\nbody", "quality of what ships");
    expect(result).toBe("> covers: whole-board judgment · focus: quality of what ships\nbody");
    expect(parseCraftHeader(result).focus).toBe("quality of what ships");
    expect(parseCraftHeader(result).covers).toBe("whole-board judgment"); // unaffected
  });

  it("coexists with distilled/ready clauses without corrupting either", () => {
    const withDistilled = stampCraftFocus("> covers: app.py · distilled: 2026-08-01\n", "shipped quality");
    expect(parseCraftHeader(withDistilled)).toEqual({
      covers: "app.py",
      distilled: "2026-08-01",
      ready: null,
      focus: "shipped quality",
    });
  });

  it("replaces an existing focus clause rather than duplicating it", () => {
    const once = stampCraftFocus("> covers: app.py\n", "first lens");
    const twice = stampCraftFocus(once, "second lens");
    expect(parseCraftHeader(twice).focus).toBe("second lens");
    expect(twice.match(/focus:/g)).toHaveLength(1);
  });

  it("clears (focus: null) drops the clause", () => {
    const stamped = stampCraftFocus("> covers: app.py\n", "a lens");
    const cleared = stampCraftFocus(stamped, null);
    expect(parseCraftHeader(cleared).focus).toBeNull();
    expect(cleared).not.toContain("focus:");
  });

  it("clearing a header with no focus clause is a harmless no-op", () => {
    const input = "> covers: app.py\nbody";
    expect(stampCraftFocus(input, null)).toBe(input);
  });

  it("leaves body prose untouched, header line only", () => {
    const result = stampCraftFocus("> covers: app.py\n\n## A section\nsome real content\n", "a lens");
    expect(result).toContain("## A section\nsome real content");
  });

  it("prepends a header line rather than losing the stamp when there's no header at all", () => {
    const result = stampCraftFocus("no header here", "a lens");
    expect(result).toBe("> focus: a lens\nno header here");
  });
});

describe("listCrafts", () => {
  it("enumerates both tiers, shared winning a slug collision", () => {
    const repo = fs.mkdtempSync(path.join(home, "repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const shared = path.join(repo, ".hands", "crafts");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "ordering-api.md"), "> covers: app.py · distilled: 2026-08-01 from 2 learnings\n");

    const personal = craftFiles("saucier", env, repo).dir;
    fs.mkdirSync(personal, { recursive: true });
    fs.writeFileSync(path.join(personal, "saucier.md"), "> covers: sauces\n");
    // a personal craft SHADOWED by a same-named shared one
    fs.writeFileSync(path.join(personal, "ordering-api.md"), "> covers: SHOULD NOT WIN\n");

    const store = new Store({ env });
    const roster = listCrafts(store, loadConfig({ cwd: repo, env }), env, repo);
    expect(roster.map((c) => c.slug)).toEqual(["ordering-api", "saucier"]);
    const orderingApi = roster.find((c) => c.slug === "ordering-api");
    expect(orderingApi?.scope).toBe("shared");
    expect(orderingApi?.covers).toBe("app.py");
    store.close();
  });

  it("excludes role crafts from the browsable roster (hands#139/#91/#95)", () => {
    const repo = fs.mkdtempSync(path.join(home, "repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const shared = path.join(repo, ".hands", "crafts");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "cdc.md"), "> covers: whole-board judgment\n");
    fs.writeFileSync(path.join(shared, "saucier.md"), "> covers: sauces\n");

    const store = new Store({ env });
    const roster = listCrafts(store, loadConfig({ cwd: repo, env }), env, repo);
    expect(roster.map((c) => c.slug)).toEqual(["saucier"]); // cdc never appears
    store.close();
  });
});

describe("role crafts — dispatch still works even though the roster hides them (hands#139/#91/#95)", () => {
  it("isRoleCraft classifies cdc and nothing else", () => {
    expect(isRoleCraft("cdc")).toBe(true);
    expect(isRoleCraft("saucier")).toBe(false);
    expect(isRoleCraft("issue-triage")).toBe(false);
  });

  it("craftKnown still resolves a role craft by EXACT slug — hands craft brief cdc keeps working", () => {
    const repo = fs.mkdtempSync(path.join(home, "repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const shared = path.join(repo, ".hands", "crafts");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "cdc.md"), "> covers: whole-board judgment\n");

    const { known } = craftKnown("cdc", loadConfig({ cwd: repo, env }), env, repo);
    expect(known).toBe(true); // a direct, correctly-spelled dispatch always resolves
    const store = new Store({ env });
    const roster = listCrafts(store, loadConfig({ cwd: repo, env }), env, repo);
    expect(roster.map((c) => c.slug)).not.toContain("cdc");
    store.close();
  });

  it("craftKnown does NOT suggest a role craft for a typo — a near-miss must not surface it (hands#204)", () => {
    const repo = fs.mkdtempSync(path.join(home, "repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const shared = path.join(repo, ".hands", "crafts");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "cdc.md"), "> covers: whole-board judgment\n");
    fs.writeFileSync(path.join(shared, "cdo.md"), "> covers: something else\n"); // a close-by real craft

    // "cdd" is a typo close to both "cdc" (role craft) and "cdo" (an ordinary, suggestable craft).
    const { known, slugs } = craftKnown("cdd", loadConfig({ cwd: repo, env }), env, repo);
    expect(known).toBe(false);
    expect(slugs).not.toContain("cdc"); // role crafts aren't a typo-suggestion destination
    expect(slugs).toContain("cdo"); // ordinary crafts still are
    expect(nearestCraftSlugs("cdd", slugs, 1)).toEqual(["cdo"]);
  });
});

describe("roleCraftFoldNudges — the expo-only fold-readiness signal for role crafts (hands#103 follow-up)", () => {
  it("is empty when no role craft is founded", () => {
    const store = new Store({ env });
    expect(roleCraftFoldNudges(store, loadConfig({ env }), env)).toBe("");
    store.close();
  });

  it("stays silent below FOLD_READY_THRESHOLD", () => {
    const repo = fs.mkdtempSync(path.join(home, "repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const shared = path.join(repo, ".hands", "crafts");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "cdc.md"), "> covers: whole-board judgment\n");

    const store = new Store({ env });
    for (let i = 0; i < FOLD_READY_THRESHOLD - 1; i++) {
      store.insertCraftNote({ craftSlug: "cdc", sourceAgent: "expo", kind: "book", body: `n${i}` });
    }
    expect(roleCraftFoldNudges(store, loadConfig({ cwd: repo, env }), env, repo)).toBe("");
    store.close();
  });

  it("names the role craft once its pending notes reach FOLD_READY_THRESHOLD — the gap hands#103 closes", () => {
    const repo = fs.mkdtempSync(path.join(home, "repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const shared = path.join(repo, ".hands", "crafts");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "cdc.md"), "> covers: whole-board judgment\n");
    fs.writeFileSync(path.join(shared, "saucier.md"), "> covers: sauces\n"); // ordinary craft, own pile of notes

    const store = new Store({ env });
    for (let i = 0; i < FOLD_READY_THRESHOLD; i++) {
      store.insertCraftNote({ craftSlug: "cdc", sourceAgent: "expo", kind: "book", body: `n${i}` });
      store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-1", kind: "book", body: `n${i}` });
    }
    const nudge = roleCraftFoldNudges(store, loadConfig({ cwd: repo, env }), env, repo);
    expect(nudge).toContain("cdc has 3 pending note(s) — ready to fold (hands craft fold cdc).");
    // an ordinary craft's fold-readiness already rides the roster list — this surface is role-craft-only
    expect(nudge).not.toContain("saucier");
    store.close();
  });
});

describe("craftRosterContext (roster injection, not full content — hands#81/#96)", () => {
  it("says so plainly when nothing is founded yet", () => {
    const store = new Store({ env });
    expect(craftRosterContext(loadConfig({ env }), store, env)).toContain("No crafts founded yet");
    store.close();
  });

  it("lists founded crafts with covers/scope/staleness, and stays small regardless of book length", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(
      files.book,
      `> covers: sauces, stocks · distilled: 2026-08-01 from 3 learnings\n${"x".repeat(5000)}`,
    );
    const ctx = craftRosterContext(loadConfig({ env }), store, env);
    expect(ctx).toContain("saucier [personal, brief-only, plan-only] — sauces, stocks");
    expect(ctx.length).toBeLessThan(2500); // roster summary, not the 5000-char book itself
    store.close();
  });

  it("flags a craft that's never been distilled", () => {
    const store = new Store({ env });
    const files = craftFiles("poissonnier", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.book, "> covers: fish\nsome content");
    expect(craftRosterContext(loadConfig({ env }), store, env)).toContain("(never distilled)");
    store.close();
  });

  it("surfaces the dispatch rate (hands#168) once tickets have finished, silent when none have", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.book, "> covers: sauces\n");

    const before = craftRosterContext(loadConfig({ env }), store, env, undefined, 10_000);
    expect(before).not.toContain("Dispatch rate");

    const id = store.createTask({ createdBy: "expo", title: "t", now: 1000 });
    store.updateTaskState({ id, state: "returned", result: "r", now: 2000 });
    store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-1", ticketId: id, now: 2000 });

    const after = craftRosterContext(loadConfig({ env }), store, env, undefined, 10_000);
    expect(after).toContain("Dispatch rate (7d): 1 of 1 finished ticket(s) went through a craft (0 execute, 1 plan).");
    store.close();
  });

  it("never surfaces a role craft, even once its notes reach fold-ready (hands#103 follow-up)", () => {
    const repo = fs.mkdtempSync(path.join(home, "repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const shared = path.join(repo, ".hands", "crafts");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "cdc.md"), "> covers: whole-board judgment\n");

    const store = new Store({ env });
    for (let i = 0; i < FOLD_READY_THRESHOLD; i++) {
      store.insertCraftNote({ craftSlug: "cdc", sourceAgent: "expo", kind: "book", body: `n${i}` });
    }
    const ctx = craftRosterContext(loadConfig({ cwd: repo, env }), store, env, repo);
    expect(ctx).toContain("No crafts founded yet"); // cdc is the only craft on disk, still excluded
    expect(ctx).not.toContain("cdc");
    store.close();
  });
});

describe("composeChit + parseCraftNoteBlock (the dispatch/return round trip)", () => {
  it("the chit embeds the brief id, craft, mode, and the exact return-contract shape", () => {
    const chit = composeChit(
      {
        id: 4711,
        craft_slug: "ordering-api",
        mode: "plan",
        cwd: null,
        opened_by: "expo",
        task: null,
        ticket_id: null,
        picked_up_at: null,
        noted_at: null,
        created_at: Date.now(),
        expires_at: Date.now() + 1000,
      },
      "app.py order routes",
      "normal",
    );
    expect(chit).toContain('brief #4711, mode: plan');
    expect(chit).toContain("Covers: app.py order routes");
    expect(chit).toContain("hands craft mise 4711");
    expect(chit).toContain("```craft-note");
    expect(chit).toContain("PLAN MODE: read, reason, propose");
    expect(chit).toContain("refactor:"); // hands#92 — the principal's "what could have made this easier" ask
    expect(chit).not.toContain("Usage mode:"); // "normal" is silent — no line at all
  });

  it("usageMode 'low' adds a terse-instruction line; 'normal' stays silent", () => {
    const brief = {
      id: 1,
      craft_slug: "ordering-api",
      mode: "plan" as const,
      cwd: null,
      opened_by: "expo",
      task: null,
      ticket_id: null,
      picked_up_at: null,
      noted_at: null,
      created_at: Date.now(),
      expires_at: Date.now() + 1000,
    };
    const low = composeChit(brief, null, "low");
    expect(low).toContain("Usage mode: low");
    expect(low).toContain("keep this terse");
    const normal = composeChit(brief, null, "normal");
    expect(normal).not.toContain("Usage mode:");
  });

  it("round-trips a real craft-note block: typed entries, spillover, nothing-new", () => {
    const text = [
      "some preamble the sub-agent wrote",
      "```craft-note",
      "brief: 4711",
      "craft: ordering-api",
      "nothing-new: false",
      "mise: engine/src/orders/validate.ts — moved here from routes.ts",
      "book: menu validation runs before auth middleware",
      "spillover(db-caching): the read path hits a cache layer I don't own",
      "```",
      "trailing text",
    ].join("\n");
    const parsed = parseCraftNoteBlock(text);
    expect(parsed?.briefId).toBe(4711);
    expect(parsed?.craftSlug).toBe("ordering-api");
    expect(parsed?.nothingNew).toBe(false);
    expect(parsed?.entries).toEqual([
      { kind: "mise", body: "engine/src/orders/validate.ts — moved here from routes.ts" },
      { kind: "book", body: "menu validation runs before auth middleware" },
      { kind: "spillover", body: "the read path hits a cache layer I don't own", spilloverCraft: "db-caching" },
    ]);
  });

  it("parses a refactor entry, distinct from friction (hands#92)", () => {
    const text = [
      "```craft-note",
      "brief: 1",
      "craft: saucier",
      "nothing-new: false",
      "refactor: the sauce-reduction step is duplicated in three call sites, worth extracting",
      "friction: my own skill's step 2 pointed at a path that no longer exists",
      "```",
    ].join("\n");
    const parsed = parseCraftNoteBlock(text);
    expect(parsed?.entries).toEqual([
      { kind: "refactor", body: "the sauce-reduction step is duplicated in three call sites, worth extracting" },
      { kind: "friction", body: "my own skill's step 2 pointed at a path that no longer exists" },
    ]);
  });

  it("a nothing-new note parses with zero entries", () => {
    const text = "```craft-note\nbrief: 1\ncraft: saucier\nnothing-new: true\n```";
    const parsed = parseCraftNoteBlock(text);
    expect(parsed?.nothingNew).toBe(true);
    expect(parsed?.entries).toEqual([]);
  });

  it("returns null when no block is present", () => {
    expect(parseCraftNoteBlock("just some ordinary transcript text, no fenced block")).toBeNull();
  });

  it("picks the LAST block when a transcript contains more than one", () => {
    const text =
      "```craft-note\nbrief: 1\ncraft: first\nnothing-new: true\n```\nmore text\n```craft-note\nbrief: 2\ncraft: second\nnothing-new: true\n```";
    expect(parseCraftNoteBlock(text)?.craftSlug).toBe("second");
  });
});

describe("checkpointTicketProblem / isCdcCheckpoint — hands#128: pre-return can't exist without a ticket id", () => {
  it("isCdcCheckpoint accepts exactly the three real checkpoints", () => {
    expect(isCdcCheckpoint("pre-fire")).toBe(true);
    expect(isCdcCheckpoint("pre-return")).toBe(true);
    expect(isCdcCheckpoint("pre-ship")).toBe(true);
    expect(isCdcCheckpoint("pre-launch")).toBe(false);
    expect(isCdcCheckpoint("")).toBe(false);
  });

  it("pre-return with no ticket id is a problem, named plainly", () => {
    const problem = checkpointTicketProblem("pre-return", null);
    expect(problem).toContain("--checkpoint pre-return requires --ticket");
  });

  it("pre-return WITH a ticket id is fine", () => {
    expect(checkpointTicketProblem("pre-return", 128)).toBeNull();
  });

  it("pre-fire and pre-ship never require a ticket id — pre-fire genuinely precedes one existing, pre-ship's dish-spanning linkage is a deliberately separate, unfixed gap", () => {
    expect(checkpointTicketProblem("pre-fire", null)).toBeNull();
    expect(checkpointTicketProblem("pre-ship", null)).toBeNull();
  });
});

describe("parseCdcVerdictBlock — hands#128, the mechanical-harvest read side for CDC pre-return verdicts", () => {
  it("parses a full verdict block", () => {
    const text = [
      "some reasoning first",
      "```cdc-verdict",
      "brief: 42",
      "checkpoint: pre-return",
      "verdict: approved",
      "note: checked against origin/main, no collisions",
      "originSha: abc123",
      "```",
    ].join("\n");
    expect(parseCdcVerdictBlock(text)).toEqual({
      briefId: 42,
      checkpoint: "pre-return",
      verdict: "approved",
      note: "checked against origin/main, no collisions",
      originSha: "abc123",
    });
  });

  it("note and originSha are optional — a bare approval still parses", () => {
    const text = "```cdc-verdict\nbrief: 1\ncheckpoint: pre-return\nverdict: approved\n```";
    expect(parseCdcVerdictBlock(text)).toEqual({
      briefId: 1,
      checkpoint: "pre-return",
      verdict: "approved",
      note: null,
      originSha: null,
    });
  });

  it("returns null when no block is present", () => {
    expect(parseCdcVerdictBlock("just an ordinary transcript, no fenced block")).toBeNull();
  });

  it("picks the LAST block when a transcript contains more than one", () => {
    const text =
      "```cdc-verdict\nbrief: 1\ncheckpoint: pre-return\nverdict: rejected\n```\nmore text\n```cdc-verdict\nbrief: 2\ncheckpoint: pre-return\nverdict: approved\n```";
    expect(parseCdcVerdictBlock(text)?.briefId).toBe(2);
    expect(parseCdcVerdictBlock(text)?.verdict).toBe("approved");
  });

  it("a craft-note block does not get mistaken for a cdc-verdict block", () => {
    const text = "```craft-note\nbrief: 1\ncraft: saucier\nnothing-new: true\n```";
    expect(parseCdcVerdictBlock(text)).toBeNull();
  });
});

describe("Store: craft notes + fold lease + execute lease", () => {
  it("pendingCraftSlugs finds a craft with a backlog even before it has a book file (hands doctor's check)", () => {
    const store = new Store({ env });
    expect(store.pendingCraftSlugs()).toEqual([]);
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-1", kind: "book", body: "x" });
    store.insertCraftNote({ craftSlug: "poissonnier", sourceAgent: "station-2", kind: "mise", body: "y" });
    expect(store.pendingCraftSlugs().sort()).toEqual(["poissonnier", "saucier"]);
    store.close();
  });

  it("notes append as pending, and a fold marks them folded through a given id", () => {
    const store = new Store({ env });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-1", kind: "book", body: "learned X" });
    const id2 = store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-2", kind: "mise", body: "path Y" });
    expect(store.pendingCraftNotes("saucier")).toHaveLength(2);
    store.markCraftNotesFolded("saucier", id2);
    expect(store.pendingCraftNotes("saucier")).toHaveLength(0);
    store.close();
  });

  it("a note for a different craft is unaffected by folding another craft's notes", () => {
    const store = new Store({ env });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-1", kind: "book", body: "x" });
    const otherId = store.insertCraftNote({ craftSlug: "poissonnier", sourceAgent: "station-2", kind: "book", body: "y" });
    store.markCraftNotesFolded("saucier", otherId); // wrong craft's id — no-op for poissonnier
    expect(store.pendingCraftNotes("poissonnier")).toHaveLength(1);
    store.close();
  });

  it("fold lease: refused while held, renewable by the same holder, free again once expired", () => {
    const store = new Store({ env });
    const now = Date.now();
    expect(store.acquireCraftFoldLease("saucier", "expo", 10_000, now)).toBe(true);
    expect(store.acquireCraftFoldLease("saucier", "station-1", 10_000, now + 1000)).toBe(false);
    expect(store.acquireCraftFoldLease("saucier", "expo", 10_000, now + 2000)).toBe(true);
    expect(store.acquireCraftFoldLease("saucier", "station-1", 10_000, now + 20_000)).toBe(true);
    store.close();
  });

  it("releaseCraftFoldLease frees it for another holder immediately", () => {
    const store = new Store({ env });
    expect(store.acquireCraftFoldLease("saucier", "expo")).toBe(true);
    store.releaseCraftFoldLease("saucier", "expo");
    expect(store.acquireCraftFoldLease("saucier", "station-1")).toBe(true);
    store.close();
  });

  it("openExecuteBrief sees a live execute brief for a craft+cwd, not a noted or different-cwd one", () => {
    const store = new Store({ env });
    const id = store.createCraftBrief({ craftSlug: "saucier", mode: "execute", cwd: "/repo", openedBy: "station-1" });
    expect(store.openExecuteBrief("saucier", "/repo")?.id).toBe(id);
    expect(store.openExecuteBrief("saucier", "/other")).toBeUndefined();
    store.markCraftBriefNoted(id);
    expect(store.openExecuteBrief("saucier", "/repo")).toBeUndefined();
    store.close();
  });

  it("a plan-mode brief never counts as an open execute lease", () => {
    const store = new Store({ env });
    store.createCraftBrief({ craftSlug: "saucier", mode: "plan", cwd: "/repo", openedBy: "station-1" });
    expect(store.openExecuteBrief("saucier", "/repo")).toBeUndefined();
    store.close();
  });

  it("createCraftBrief round-trips an optional ticketId (dashboard 'for what ticket' stat)", () => {
    const store = new Store({ env });
    const withTicket = store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-1", ticketId: 47 });
    expect(store.getCraftBrief(withTicket)?.ticket_id).toBe(47);
    const withoutTicket = store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-1" });
    expect(store.getCraftBrief(withoutTicket)?.ticket_id).toBeNull();
    store.close();
  });
});

describe("Store.craftNoteHistory — full timeline, newest first (hands#136-dashboard)", () => {
  it("includes both pending and folded notes, newest first", () => {
    const store = new Store({ env });
    const id1 = store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-1", kind: "book", body: "first" });
    const id2 = store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-1", kind: "mise", body: "second" });
    store.markCraftNoteFolded(id1);
    const history = store.craftNoteHistory("saucier");
    expect(history.map((n) => n.id)).toEqual([id2, id1]);
    expect(history.find((n) => n.id === id1)?.folded_at).not.toBeNull();
    store.close();
  });

  it("respects the limit", () => {
    const store = new Store({ env });
    for (let i = 0; i < 5; i++) {
      store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-1", kind: "book", body: `n${i}` });
    }
    expect(store.craftNoteHistory("saucier", 2)).toHaveLength(2);
    store.close();
  });

  it("is empty for a craft with no notes at all", () => {
    const store = new Store({ env });
    expect(store.craftNoteHistory("nobody-home")).toEqual([]);
    store.close();
  });
});

describe("Store.craftUsageStats — dispatch aggregation (hands#136-dashboard)", () => {
  it("counts dispatches, tracks last-dispatched and distinct stations, and averages duration only over completed dispatches", () => {
    const store = new Store({ env });
    const a = store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-1", now: 1000 });
    const b = store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-2", now: 2000 });
    store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-1", now: 3000 }); // never completes
    store.markCraftBriefNoted(a, 1500); // 500ms
    store.markCraftBriefNoted(b, 2600); // 600ms

    const stats = store.craftUsageStats().get("saucier");
    expect(stats?.dispatchCount).toBe(3);
    expect(stats?.lastDispatchedAt).toBe(3000);
    expect(stats?.stations.sort()).toEqual(["station-1", "station-2"]);
    expect(stats?.completedCount).toBe(2);
    expect(stats?.avgDurationMs).toBe(550);
    store.close();
  });

  it("a craft with zero completed dispatches reports null duration, not zero", () => {
    const store = new Store({ env });
    store.createCraftBrief({ craftSlug: "poissonnier", mode: "plan", openedBy: "station-1" });
    const stats = store.craftUsageStats().get("poissonnier");
    expect(stats?.dispatchCount).toBe(1);
    expect(stats?.completedCount).toBe(0);
    expect(stats?.avgDurationMs).toBeNull();
    store.close();
  });

  it("a craft with zero dispatches at all is simply absent from the map", () => {
    const store = new Store({ env });
    expect(store.craftUsageStats().has("nobody-home")).toBe(false);
    store.close();
  });
});

describe("Store.orphanCraftBriefSlugs — phantom dispatches from an unknown slug (hands#165/#168)", () => {
  it("flags a slug with recorded briefs that isn't on the known roster, and counts it", () => {
    const store = new Store({ env });
    store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-1" });
    store.createCraftBrief({ craftSlug: "craft-fleet-runtime", mode: "plan", openedBy: "station-2" }); // phantom
    store.createCraftBrief({ craftSlug: "craft-fleet-runtime", mode: "plan", openedBy: "station-2" }); // phantom
    expect(store.orphanCraftBriefSlugs(["saucier"])).toEqual([{ slug: "craft-fleet-runtime", count: 2 }]);
    store.close();
  });

  it("is empty when every recorded brief matches the known roster", () => {
    const store = new Store({ env });
    store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-1" });
    expect(store.orphanCraftBriefSlugs(["saucier", "poissonnier"])).toEqual([]);
    store.close();
  });

  it("is empty with no craft_briefs rows at all", () => {
    const store = new Store({ env });
    expect(store.orphanCraftBriefSlugs(["saucier"])).toEqual([]);
    store.close();
  });
});

describe("Store.craftDispatchRate — visibility for underuse (hands#168)", () => {
  it("counts finished tickets in the window, and how many carried a KNOWN craft's brief", () => {
    const store = new Store({ env });
    const a = store.createTask({ createdBy: "expo", title: "a", now: 1000 });
    const b = store.createTask({ createdBy: "expo", title: "b", now: 1000 });
    const c = store.createTask({ createdBy: "expo", title: "c", now: 1000 }); // no craft brief at all
    store.updateTaskState({ id: a, state: "returned", result: "r", now: 2000 });
    store.updateTaskState({ id: b, state: "returned", result: "r", now: 2000 });
    store.updateTaskState({ id: c, state: "returned", result: "r", now: 2000 });
    store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-1", ticketId: a });
    store.createCraftBrief({ craftSlug: "craft-fleet-runtime", mode: "plan", openedBy: "station-2", ticketId: b }); // phantom slug

    const rate = store.craftDispatchRate(0, ["saucier"]); // "craft-fleet-runtime" is NOT known
    expect(rate.ticketsFinished).toBe(3);
    expect(rate.ticketsWithCraftBrief).toBe(1); // only ticket a's brief matches a known slug
    store.close();
  });

  it("excludes tickets that finished before the window", () => {
    const store = new Store({ env });
    const old = store.createTask({ createdBy: "expo", title: "old", now: 1000 });
    store.updateTaskState({ id: old, state: "done", now: 2000 });
    const recent = store.createTask({ createdBy: "expo", title: "recent", now: 5000 });
    store.updateTaskState({ id: recent, state: "done", now: 6000 });

    const rate = store.craftDispatchRate(5000, ["saucier"]);
    expect(rate.ticketsFinished).toBe(1);
    store.close();
  });

  it("an empty known-slug list reports 0 dispatched, never joins against nothing", () => {
    const store = new Store({ env });
    const a = store.createTask({ createdBy: "expo", title: "a", now: 1000 });
    store.updateTaskState({ id: a, state: "returned", result: "r", now: 2000 });
    const rate = store.craftDispatchRate(0, []);
    expect(rate).toEqual({ ticketsFinished: 1, ticketsWithCraftBrief: 0, executeDispatches: 0, planDispatches: 0 });
    store.close();
  });

  it("splits execute vs plan dispatches (hands#92) — a 100% plan-mode rate is now visible, not hidden inside a healthy-looking count", () => {
    const store = new Store({ env });
    store.createCraftBrief({ craftSlug: "saucier", mode: "execute", openedBy: "station-1", now: 1000 });
    store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-1", now: 1000 });
    store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-2", now: 1000 });
    store.createCraftBrief({ craftSlug: "craft-fleet-runtime", mode: "execute", openedBy: "station-1", now: 1000 }); // phantom, excluded

    const rate = store.craftDispatchRate(0, ["saucier"]);
    expect(rate.executeDispatches).toBe(1);
    expect(rate.planDispatches).toBe(2);
    store.close();
  });
});

describe("booksDistilledRecently — visible compounding, not just activity (hands#92)", () => {
  const entry = (slug: string, distilled: string | null) => ({
    slug,
    scope: "personal" as const,
    covers: null,
    distilled,
    ready: null,
    pendingNotes: 0,
  });

  it("counts crafts distilled within the window", () => {
    const now = Date.parse("2026-08-07T00:00:00Z");
    const entries = [
      entry("saucier", "2026-08-06"), // 1 day ago — in window
      entry("poissonnier", "2026-08-01"), // 6 days ago — in window
      entry("ordering-api", "2026-07-20"), // ~18 days ago — outside window
      entry("never-distilled", null),
    ];
    expect(booksDistilledRecently(entries, now)).toBe(2);
  });

  it("is 0 when nothing has ever been distilled — the honest signal for an unproven loop", () => {
    const now = Date.parse("2026-08-07T00:00:00Z");
    expect(booksDistilledRecently([entry("saucier", null)], now)).toBe(0);
  });

  it("ignores an unparseable distilled value rather than throwing", () => {
    const now = Date.parse("2026-08-07T00:00:00Z");
    expect(booksDistilledRecently([entry("saucier", "not-a-date")], now)).toBe(0);
  });
});

describe("Store.craftTokenUsage — subagent_samples aggregation (hands#136-dashboard)", () => {
  it("sums output tokens per craft, keyed by slug (agent_type prefix stripped)", () => {
    const store = new Store({ env });
    store.recordSubagentSample({ ownerAgentId: "station-1", agentType: "craft-saucier", spawnDepth: 1, outputTokens: 100 });
    store.recordSubagentSample({ ownerAgentId: "station-1", agentType: "craft-saucier", spawnDepth: 1, outputTokens: 50 });
    store.recordSubagentSample({ ownerAgentId: "station-1", agentType: "craft-poissonnier", spawnDepth: 1, outputTokens: 30 });
    // the unsynced fallback path — deliberately NOT attributed to any craft (a real undercount,
    // by design, not a bug — see the caveat on Store.craftTokenUsage's own doc comment).
    store.recordSubagentSample({ ownerAgentId: "station-1", agentType: "general-purpose", spawnDepth: 1, outputTokens: 999 });

    const usage = store.craftTokenUsage();
    expect(usage.get("saucier")).toEqual({ totalOutputTokens: 150, calls: 2 });
    expect(usage.get("poissonnier")).toEqual({ totalOutputTokens: 30, calls: 1 });
    expect(usage.has("general-purpose")).toBe(false);
    store.close();
  });

  it("is an empty map when no craft samples exist", () => {
    const store = new Store({ env });
    expect(store.craftTokenUsage().size).toBe(0);
    store.close();
  });
});

describe("Store.listCraftBriefsByTicket / listCraftBriefsWithTicket — a chit's 'crafts used' (hands: Chits)", () => {
  it("listCraftBriefsByTicket returns only briefs for that ticket, oldest first", () => {
    const store = new Store({ env });
    store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-1", ticketId: 47, now: 2000 });
    store.createCraftBrief({ craftSlug: "poissonnier", mode: "plan", openedBy: "station-2", ticketId: 47, now: 1000 });
    store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-1", ticketId: 99, now: 1500 });

    const briefs = store.listCraftBriefsByTicket(47);
    expect(briefs.map((b) => b.craft_slug)).toEqual(["poissonnier", "saucier"]); // oldest (1000) first
    store.close();
  });

  it("listCraftBriefsByTicket is empty for a ticket with no craft dispatches", () => {
    const store = new Store({ env });
    expect(store.listCraftBriefsByTicket(1)).toEqual([]);
    store.close();
  });

  it("listCraftBriefsWithTicket returns every ticket-tied brief, excluding ones with no ticket", () => {
    const store = new Store({ env });
    store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "station-1", ticketId: 47 });
    store.createCraftBrief({ craftSlug: "poissonnier", mode: "plan", openedBy: "station-2" }); // no ticket
    expect(store.listCraftBriefsWithTicket().map((b) => b.craft_slug)).toEqual(["saucier"]);
    store.close();
  });
});

describe("pathsReport — no held-craft fields, plain lane label + both craft dirs", () => {
  it("reports focus as a plain label, plus personal and shared craft dirs", () => {
    const cfg = loadConfig({ env });
    const report = pathsReport("station-1", cfg, "auth migration") as {
      focus: string | null;
      craftsDir: string;
      sharedCraftsDir: string | null;
    };
    expect(report.focus).toBe("auth migration");
    // pathsReport reflects the real process env/cwd (no test-injected override in its own
    // signature — same convention the pre-existing hot-swap test relied on), so assert the
    // relative shape rather than an exact path against this test's isolated `home`.
    expect(report.craftsDir).toContain(path.join("coordination"));
    expect(report.craftsDir.endsWith(path.join("crafts"))).toBe(true);
    expect(report).not.toHaveProperty("craft");
    expect(report).not.toHaveProperty("craftSlug");
    expect(report).not.toHaveProperty("book");
    expect(report).not.toHaveProperty("skillFile");
  });
});

describe("materializeCraftAgents — real, session-discoverable Agent types + Skills (hands#81/#96)", () => {
  it("generates an Agent type + Skill per craft, discoverable at the expected paths", () => {
    const files = craftFiles("saucier", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.book, "> covers: sauces, stocks\nBeurre blanc breaks over 58C.");
    fs.writeFileSync(files.skill, "Always taste before plating.");

    const target = fs.mkdtempSync(path.join(home, "target-"));
    const res = materializeCraftAgents(loadConfig({ env }), target, env);
    expect(res.written).toEqual(["saucier"]);

    const agentBody = fs.readFileSync(craftAgentPath(target, "saucier"), "utf8");
    expect(agentBody).toContain("name: craft-saucier");
    expect(agentBody).toContain("hands craft brief saucier");
    expect(agentBody).toContain('Skill({ skill: "craft-saucier" })');
    // hands#92: no readiness stamp on this book → plan-mode only, no exceptions.
    expect(agentBody).toContain("PLAN MODE ONLY");
    expect(agentBody).not.toContain("--mode execute");

    const skillBody = fs.readFileSync(craftSkillPath(target, "saucier"), "utf8");
    expect(skillBody).toContain("name: craft-saucier");
    expect(skillBody).toContain("hands craft mise <briefId>");
    expect(skillBody).toContain("Always taste before plating.");
    expect(skillBody).toContain("```craft-note");
    expect(skillBody).toContain("refactor:"); // hands#92 — distinct from friction
    // Points at the LIVE usageMode in its own chit/mise output, not a snapshotted value
    // (Skill/Agent discovery is fixed at session start — baking a mode in here would go stale).
    expect(agentBody).toContain("Usage mode: low");
    expect(skillBody).toContain("usageMode");
  });

  it("hands#92: a craft marked ready generates an execute-mode dispatch template", () => {
    const files = craftFiles("saucier", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.book, "> covers: sauces · ready: 2026-08-07 by sous\n");
    const target = fs.mkdtempSync(path.join(home, "target-"));
    materializeCraftAgents(loadConfig({ env }), target, env);

    const agentBody = fs.readFileSync(craftAgentPath(target, "saucier"), "utf8");
    expect(agentBody).toContain("Cleared for EXECUTE mode");
    expect(agentBody).toContain("2026-08-07 by sous");
    expect(agentBody).toContain("--mode execute");
    expect(agentBody).not.toContain("PLAN MODE ONLY");
  });

  it("a craft with no skill.md yet still generates, with a founding-message placeholder", () => {
    const files = craftFiles("poissonnier", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.book, "> covers: fish\n");
    const target = fs.mkdtempSync(path.join(home, "target-"));
    materializeCraftAgents(loadConfig({ env }), target, env);
    expect(fs.readFileSync(craftSkillPath(target, "poissonnier"), "utf8")).toContain("founding this craft");
  });

  it("is idempotent, and removes generated files for a craft no longer on the roster", () => {
    const target = fs.mkdtempSync(path.join(home, "target-"));
    const cfg = loadConfig({ env });

    const a = craftFiles("saucier", env);
    fs.mkdirSync(a.dir, { recursive: true });
    fs.writeFileSync(a.book, "> covers: sauces\n");
    const first = materializeCraftAgents(cfg, target, env);
    expect(first.written).toEqual(["saucier"]);
    const second = materializeCraftAgents(cfg, target, env);
    expect(second.written).toEqual(["saucier"]); // idempotent — same craft regenerates cleanly

    // "remove" saucier from the roster (as `hands craft localize`'s inverse would if a shared
    // craft's file disappeared) and confirm a resync cleans up its generated files.
    fs.rmSync(a.book);
    const third = materializeCraftAgents(cfg, target, env);
    expect(third.written).toEqual([]);
    expect(third.removed).toEqual(["saucier"]);
    expect(fs.existsSync(craftAgentPath(target, "saucier"))).toBe(false);
    expect(fs.existsSync(path.dirname(craftSkillPath(target, "saucier")))).toBe(false);
  });

  it("the roster context's synced/brief-only flag tracks whether THAT target dir has been materialized", () => {
    const files = craftFiles("saucier", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.book, "> covers: sauces\n");
    const store = new Store({ env });
    const cfg = loadConfig({ env });
    // An isolated target dir — never the real process.cwd() — so this test can never leave
    // generated files behind in the actual checkout running the suite.
    const target = fs.mkdtempSync(path.join(home, "target-"));

    const before = formatRosterContext(listCrafts(store, cfg, env), target);
    expect(before).toContain("saucier [personal, brief-only, plan-only]");

    materializeCraftAgents(cfg, target, env);
    const after = formatRosterContext(listCrafts(store, cfg, env), target);
    // the craft's own line drops the "brief-only" annotation once synced (still plan-only — no
    // readiness was ever stamped) — the static help text below it still mentions "craft-<slug>"
    // generically, so assert the specific line, not "anywhere at all".
    expect(after).toMatch(/- saucier \[personal, plan-only\] —/);
    expect(after).not.toContain("saucier [personal, brief-only, plan-only]");

    store.close();
  });

  it("never materializes a role craft, even self-cleaning any pre-existing generated files (hands#139/#91/#95)", () => {
    const files = craftFiles("cdc", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.book, "> covers: whole-board judgment\n");
    const target = fs.mkdtempSync(path.join(home, "target-"));
    const cfg = loadConfig({ env });

    const res = materializeCraftAgents(cfg, target, env);
    expect(res.written).toEqual([]);
    expect(fs.existsSync(craftAgentPath(target, "cdc"))).toBe(false);
    expect(fs.existsSync(craftSkillPath(target, "cdc"))).toBe(false);
  });
});

describe("upsertMiseLine — mechanical, key-based upsert into mise.md (hands#118)", () => {
  it("appends a new key to an empty/null file", () => {
    const result = upsertMiseLine(null, "engine/src/foo.ts — exports bar()");
    expect(result).toBe("- engine/src/foo.ts — exports bar()\n");
  });

  it("replaces an existing bullet with the same key rather than duplicating it", () => {
    const before = "- engine/src/foo.ts — exports bar()\n- engine/src/other.ts — does X\n";
    const after = upsertMiseLine(before, "engine/src/foo.ts — actually exports baz(), not bar()");
    expect(after).toContain("- engine/src/foo.ts — actually exports baz(), not bar()");
    expect(after).not.toContain("exports bar()");
    expect(after).toContain("- engine/src/other.ts — does X");
    expect(after.match(/engine\/src\/foo\.ts/g)?.length).toBe(1);
  });

  it("appends rather than replacing when the key differs", () => {
    const before = "- engine/src/foo.ts — exports bar()\n";
    const after = upsertMiseLine(before, "engine/src/other.ts — does X");
    expect(after).toContain("- engine/src/foo.ts — exports bar()");
    expect(after).toContain("- engine/src/other.ts — does X");
  });

  it("a body with no recognizable delimiter still appends safely (never throws, never drops it)", () => {
    const result = upsertMiseLine("- some existing line\n", "just a plain sentence with no dash");
    expect(result).toContain("- just a plain sentence with no dash");
    expect(result).toContain("- some existing line");
  });
});

describe("appendRawNote — durable, immediate append into book.md/skill.md's raw section (hands#118)", () => {
  it("creates the heading on a null/empty file", () => {
    const result = appendRawNote(null, "[book] beurre blanc breaks over 58C");
    expect(result).toBe("## Raw notes (unfolded)\n- [book] beurre blanc breaks over 58C\n");
  });

  it("creates the heading below existing curated content, blank-line separated", () => {
    const result = appendRawNote("> covers: sauces\nExisting curated prose.", "[book] a new learning");
    expect(result).toBe(
      "> covers: sauces\nExisting curated prose.\n\n## Raw notes (unfolded)\n- [book] a new learning\n",
    );
  });

  it("accumulates under an existing heading rather than creating a second one", () => {
    const once = appendRawNote(null, "[book] first learning");
    const twice = appendRawNote(once, "[friction] second learning");
    expect(twice.match(/## Raw notes \(unfolded\)/g)?.length).toBe(1);
    expect(twice).toContain("- [book] first learning");
    expect(twice).toContain("- [friction] second learning");
  });
});

describe("Store.markCraftNoteFolded — single-row fold-mark (hands#118)", () => {
  it("marks exactly one note folded, leaving an older pending sibling untouched", () => {
    const store = new Store({ env });
    const olderId = store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-1", kind: "book", body: "older" });
    const newerId = store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-1", kind: "mise", body: "newer" });
    store.markCraftNoteFolded(newerId);
    const pending = store.pendingCraftNotes("saucier");
    expect(pending.map((n) => n.id)).toEqual([olderId]);
    store.close();
  });
});

describe("exportPendingCraftNotes — write-on-export (hands#114/#223, superseding hands#118's per-note apply)", () => {
  it("mise: rebuilds mise.md wholesale and marks every applied note folded", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    const id = store.insertCraftNote({
      craftSlug: "saucier",
      sourceAgent: "subagent:saucier",
      kind: "mise",
      body: "engine/src/foo.ts — exports bar()",
    });
    const applied = exportPendingCraftNotes(store, files, "export:test");
    expect(applied.touched).toBe(1);
    expect(applied.refused).toEqual([]);
    expect(fs.readFileSync(files.mise, "utf8")).toContain("engine/src/foo.ts — exports bar()");
    expect(store.getCraftNote(id)?.folded_at).not.toBeNull();
    expect(store.pendingCraftNotes("saucier")).toEqual([]);
    store.close();
  });

  it("book: rebuilds book.md's raw section, tagged, and stays pending", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    const id = store.insertCraftNote({
      craftSlug: "saucier",
      sourceAgent: "subagent:saucier",
      kind: "book",
      body: "beurre blanc breaks over 58C",
    });
    expect(exportPendingCraftNotes(store, files, "export:test").touched).toBe(1);
    const bookText = fs.readFileSync(files.book, "utf8");
    expect(bookText).toContain("## Raw notes (unfolded)");
    expect(bookText).toContain("- [book] beurre blanc breaks over 58C");
    expect(store.pendingCraftNotes("saucier").map((n) => n.id)).toEqual([id]); // still pending
    store.close();
  });

  it("refactor: routes to book.md (like book/friction), tagged [refactor] (hands#92)", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    store.insertCraftNote({
      craftSlug: "saucier",
      sourceAgent: "subagent:saucier",
      kind: "refactor",
      body: "the reduction step is duplicated in three call sites",
    });
    exportPendingCraftNotes(store, files, "export:test");
    const bookText = fs.readFileSync(files.book, "utf8");
    expect(bookText).toContain("- [refactor] the reduction step is duplicated in three call sites");
    store.close();
  });

  it("skill: rebuilds skill.md's raw section untagged", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    store.insertCraftNote({
      craftSlug: "saucier",
      sourceAgent: "subagent:saucier",
      kind: "skill",
      body: "taste before plating",
    });
    exportPendingCraftNotes(store, files, "export:test");
    const skillText = fs.readFileSync(files.skill, "utf8");
    expect(skillText).toContain("## Raw notes (unfolded)");
    expect(skillText).toContain("- taste before plating");
    expect(skillText).not.toContain("[skill]");
    store.close();
  });

  it("spillover: tags the source craft and stays pending", () => {
    const store = new Store({ env });
    const files = craftFiles("ordering-api", env);
    store.insertCraftNote({
      craftSlug: "ordering-api",
      sourceAgent: "subagent:saucier",
      kind: "spillover",
      body: "menu validation lives in app.py",
      spilloverCraft: "saucier",
    });
    exportPendingCraftNotes(store, files, "export:test");
    const bookText = fs.readFileSync(files.book, "utf8");
    expect(bookText).toContain("- [spillover · from saucier] menu validation lives in app.py");
    store.close();
  });

  it("skips cleanly (returns 0, notes stay pending) when the book/skill lease is already held by someone else", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    expect(store.acquireCraftFoldLease("saucier", "someone-else", 60_000)).toBe(true); // book/skill lease
    const id = store.insertCraftNote({
      craftSlug: "saucier",
      sourceAgent: "subagent:saucier",
      kind: "book",
      body: "held-out learning",
    });
    expect(exportPendingCraftNotes(store, files, "export:test").touched).toBe(0);
    expect(store.pendingCraftNotes("saucier").map((n) => n.id)).toEqual([id]);
    expect(fs.existsSync(files.book)).toBe(false); // never written
    store.close();
  });

  it("a mise export is NOT blocked by a held book/skill fold lease — different files, different lease key", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    expect(store.acquireCraftFoldLease("saucier", "someone-else", 60_000)).toBe(true); // book/skill lease only
    store.insertCraftNote({
      craftSlug: "saucier",
      sourceAgent: "subagent:saucier",
      kind: "mise",
      body: "engine/src/bar.ts — does Y",
    });
    expect(exportPendingCraftNotes(store, files, "export:test").touched).toBe(1);
    store.close();
  });

  it("is idempotent for mise — a second sweep with nothing new applies zero", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "mise", body: "a/b.ts — does A" });
    exportPendingCraftNotes(store, files, "export:test");
    expect(exportPendingCraftNotes(store, files, "export:test").touched).toBe(0);
    store.close();
  });
});

describe("exportPendingCraftNotes — the sole write path (hands#114/#223 storage fix)", () => {
  it("applies every pending note of every kind — mise mechanically folded, book/skill raw-appended and left pending", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "mise", body: "a/b.ts — does A" });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "mise", body: "c/d.ts — does C" });
    const bookId = store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "book", body: "a fact" });

    const applied = exportPendingCraftNotes(store, files, "export:test");
    expect(applied.touched).toBe(3); // unlike the old mise-only sweep, this lands book/skill too
    const miseText = fs.readFileSync(files.mise, "utf8");
    expect(miseText).toContain("a/b.ts — does A");
    expect(miseText).toContain("c/d.ts — does C");
    expect(fs.readFileSync(files.book, "utf8")).toContain("[book] a fact");
    // mise is mechanical (fully applied = folded); book still awaits real distillation via fold.
    expect(store.pendingCraftNotes("saucier").map((n) => n.id)).toEqual([bookId]);
    store.close();
  });

  it("is idempotent — a second sweep with nothing new pending applies zero", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "mise", body: "a/b.ts — does A" });
    exportPendingCraftNotes(store, files, "export:test");
    expect(exportPendingCraftNotes(store, files, "export:test").touched).toBe(0);
    store.close();
  });
});

describe("exportPendingCraftNotes — floor check refuses a drastic silent shrink (hands#114/#223 hardening, the cdc.md clobber)", () => {
  function initSharedCraftRepo(bookBody: string): { repo: string; files: ReturnType<typeof craftFiles> } {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, "repo-")));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    const sharedDir = path.join(repo, ".hands", "crafts");
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, "cdc.md"), bookBody);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
    const files = craftFiles("cdc", env, repo);
    return { repo, files };
  }

  it("refuses a rebuild that would land drastically below the file's last git-committed size, leaving on-disk content untouched", () => {
    const healthyBody = `> covers: whole board\n\n${"curated prose ".repeat(40)}\n`;
    const { files } = initSharedCraftRepo(healthyBody);
    // simulate the clobber: something external overwrote the tracked file down to a bare header
    fs.writeFileSync(files.book, "> covers: whole board\n");

    const store = new Store({ env });
    const journalCalls: Array<{ type: string; data: Record<string, unknown> }> = [];
    store.setJournal((type, data) => journalCalls.push({ type, data }));
    store.insertCraftNote({ craftSlug: "cdc", sourceAgent: "s", kind: "book", body: "a new learning" });

    const result = exportPendingCraftNotes(store, files, "export:test");

    expect(result.touched).toBe(0);
    expect(result.refused).toEqual([{ target: "book", reason: expect.any(String) }]);
    // the write was refused outright — the already-clobbered on-disk content is left exactly as is
    expect(fs.readFileSync(files.book, "utf8")).toBe("> covers: whole board\n");
    expect(store.pendingCraftNotes("cdc")).toHaveLength(1); // note stays pending, nothing silently dropped
    expect(journalCalls.some((c) => c.type === "craft.rebuild_refused" && c.data.target === "book")).toBe(true);
    store.close();
  });

  it("allows a normal rebuild that stays within the floor ratio of the committed version", () => {
    const healthyBody = `> covers: whole board\n\n${"curated prose ".repeat(40)}\n`;
    const { files } = initSharedCraftRepo(healthyBody);

    const store = new Store({ env });
    store.insertCraftNote({ craftSlug: "cdc", sourceAgent: "s", kind: "book", body: "a new learning" });
    const result = exportPendingCraftNotes(store, files, "export:test");

    expect(result.refused).toEqual([]);
    expect(result.touched).toBe(1);
    expect(fs.readFileSync(files.book, "utf8")).toContain("a new learning");
    store.close();
  });

  it("does not refuse when the committed baseline is itself below the floor — a young/short book may still shrink", () => {
    const { files } = initSharedCraftRepo("> covers: x\n"); // well under SHRINK_REFUSAL_FLOOR_BYTES

    const store = new Store({ env });
    store.insertCraftNote({ craftSlug: "cdc", sourceAgent: "s", kind: "book", body: "first note" });
    const result = exportPendingCraftNotes(store, files, "export:test");

    expect(result.refused).toEqual([]);
    expect(result.touched).toBe(1);
    store.close();
  });

  it("does not refuse when the file has no git history at all (gitCommittedContent returns null)", () => {
    const files = craftFiles("saucier", env); // personal scope — not inside any git repo
    fs.mkdirSync(files.dir, { recursive: true });
    const staleRawSection = Array.from({ length: 20 }, (_, i) => `- [book] stale note ${i}`).join("\n");
    fs.writeFileSync(files.book, `> covers: sauces\n\nprefix\n\n## Raw notes (unfolded)\n${staleRawSection}\n`);

    const store = new Store({ env });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "book", body: "one new note" });
    const result = exportPendingCraftNotes(store, files, "export:test");

    expect(result.refused).toEqual([]);
    expect(result.touched).toBe(1);
    const after = fs.readFileSync(files.book, "utf8");
    expect(after).toContain("one new note");
    expect(after).not.toContain("stale note 5"); // a genuine shrink, uncontested — no git baseline to check against
    store.close();
  });

  it("buildFoldContext surfaces the refusal via exportRefused, and the refused note stays in pendingNotes", () => {
    const healthyBody = `> covers: whole board\n\n${"curated prose ".repeat(40)}\n`;
    const { files, repo } = initSharedCraftRepo(healthyBody);
    fs.writeFileSync(files.book, "> covers: whole board\n"); // clobbered

    const store = new Store({ env });
    store.insertCraftNote({ craftSlug: "cdc", sourceAgent: "s", kind: "book", body: "a new learning" });
    const holder = "fold-holder";
    expect(store.acquireCraftFoldLease("cdc", holder)).toBe(true);
    const ctx = buildFoldContext(store, "cdc", holder, env, repo);

    expect(ctx.exportRefused).toEqual([{ target: "book", reason: expect.any(String) }]);
    expect(ctx.pendingNotes.map((n) => n.body)).toContain("a new learning");
    store.close();
  });
});

describe("readMiseMerged / readRawMerged — always-convergent derived reads (hands#114/#223)", () => {
  it("readMiseMerged is purely DB-derived — sees a note even when no file has ever been written", () => {
    const store = new Store({ env });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "mise", body: "c/d.ts — never exported" });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "book", body: "irrelevant to mise" });

    const merged = readMiseMerged(store, "saucier");
    expect(merged).toContain("c/d.ts — never exported");
    expect(merged).not.toContain("irrelevant to mise");
    store.close();
  });

  it("readMiseMerged reflects notes already folded by a PRIOR export too — not just still-pending ones", () => {
    // This is the exact gap the original (per-note, file-based) design had: a mise note is marked
    // folded the instant any export applies it, so a merge that only looked at pendingCraftNotes
    // would silently drop it for every OTHER reader from that point on.
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "mise", body: "a.ts — already folded" });
    exportPendingCraftNotes(store, files, "export:test"); // folds it
    expect(store.pendingCraftNotes("saucier")).toEqual([]); // confirm it's no longer pending

    expect(readMiseMerged(store, "saucier")).toContain("a.ts — already folded");
    store.close();
  });

  it("readRawMerged rebuilds book.md's raw section from pending notes on top of the file's stable prefix, skipping mise/skill", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.book, "> covers: sauces\n\ncurated prose stays\n");
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "book", body: "not yet exported" });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "mise", body: "irrelevant to book" });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "skill", body: "irrelevant to book too" });

    const merged = readRawMerged(files.book, store.pendingCraftNotes("saucier"), "book");
    expect(merged).toContain("curated prose stays");
    expect(merged).toContain("[book] not yet exported");
    expect(merged).not.toContain("irrelevant to book");
    store.close();
  });

  it("readRawMerged targets skill.md for kind skill, separately from book", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "skill", body: "step 1: whisk" });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "book", body: "not a skill note" });

    const pending = store.pendingCraftNotes("saucier");
    const skillMerged = readRawMerged(files.skill, pending, "skill");
    expect(skillMerged).toContain("step 1: whisk");
    expect(skillMerged).not.toContain("not a skill note");
    store.close();
  });

  it("capText truncates at the code-point cap and leaves short text untouched", () => {
    expect(capText(null)).toBeNull();
    expect(capText("short")).toBe("short");
    const long = "x".repeat(20);
    expect(capText(long, 10)).toBe(`${"x".repeat(10)}\n…(truncated — trim this file)`);
  });
});

describe("rebuildRawSection — pure function of (prefix, pending), the convergence mechanism itself", () => {
  it("keeps the curated prefix and rebuilds the raw section fresh from pending", () => {
    const rebuilt = rebuildRawSection("> covers: sauces\n\nsome curated prose", [
      { id: 1, craft_slug: "x", brief_id: null, source_agent: "s", kind: "book", body: "fact one", spillover_craft: null, created_at: 0, folded_at: null },
    ]);
    expect(rebuilt).toContain("some curated prose");
    expect(rebuilt).toContain("## Raw notes (unfolded)");
    expect(rebuilt).toContain("[book] fact one");
  });

  it("returns just the prefix, no raw-notes heading at all, when nothing is pending", () => {
    const rebuilt = rebuildRawSection("> covers: sauces\n\nsome curated prose\n\n## Raw notes (unfolded)\n- [book] stale", []);
    expect(rebuilt).toContain("some curated prose");
    expect(rebuilt).not.toContain("## Raw notes");
    expect(rebuilt).not.toContain("stale"); // an existing raw section is stripped, not preserved, when nothing's pending
  });

  it("is a pure function — two calls with the same inputs produce byte-identical output", () => {
    const pending = [
      { id: 1, craft_slug: "x", brief_id: null, source_agent: "a", kind: "book" as const, body: "from station A", spillover_craft: null, created_at: 0, folded_at: null },
      { id: 2, craft_slug: "x", brief_id: null, source_agent: "b", kind: "book" as const, body: "from station B", spillover_craft: null, created_at: 0, folded_at: null },
    ];
    const prefix = "> covers: sauces\n\nprose";
    expect(rebuildRawSection(prefix, pending)).toBe(rebuildRawSection(prefix, pending));
    // order doesn't matter to WHAT'S included, only to display order — same inputs, same set → same convergent result
    expect(rebuildRawSection(prefix, pending)).toBe(rebuildRawSection(prefix, [...pending]));
  });
});

describe("the storage fix under real concurrency — two racing dispatches, one shared DB (hands#114/#223)", () => {
  it("neither caller's live read ever loses a note, even though whichever one exports first only lands ITS OWN note on disk, and a mise note gets folded by whichever export lands first", () => {
    // One shared Store (the coordination DB — genuinely one per kitchen). Two SEPARATE on-disk
    // directories stand in for two concurrent callers each computing an export at a different
    // moment — the actual hands#223 shape, verified directly against paths.ts's repoInfo: every
    // worktree of a repo resolves `.hands/crafts/` to the SAME physical main-checkout path
    // (`--git-common-dir` is shared by design), so in reality this is ONE file multiple dispatches
    // race to write, not several independent per-worktree copies. Two directories here model that
    // race cleanly — "does the derived read stay correct no matter which write landed when" —
    // without needing an actual git-common-dir setup to prove it.
    const store = new Store({ env });
    const callerA = fs.mkdtempSync(path.join(home, "caller-a-"));
    const callerB = fs.mkdtempSync(path.join(home, "caller-b-"));
    const filesA = { ...craftFiles("saucier", env), dir: callerA, book: path.join(callerA, "saucier.md"), mise: path.join(callerA, "saucier.mise.md"), skill: path.join(callerA, "saucier.skill.md") };
    const filesB = { ...craftFiles("saucier", env), dir: callerB, book: path.join(callerB, "saucier.md"), mise: path.join(callerB, "saucier.mise.md"), skill: path.join(callerB, "saucier.skill.md") };

    // A dispatch from caller A harvests a note (DB write only, per hands#114 — no file write here).
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-a", kind: "mise", body: "a.ts — from station A" });
    // Caller A's own `hands craft mise` runs an opportunistic export — lands ONLY in A's file,
    // and marks the note folded GLOBALLY (mise is mechanical — this is correct, not a bug).
    exportPendingCraftNotes(store, filesA, "mise-read:A");
    expect(store.pendingCraftNotes("saucier")).toEqual([]); // already folded, by A's export

    // A SECOND dispatch, from caller B, harvests its own note — B's export never saw A's note land.
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "station-b", kind: "mise", body: "b.ts — from station B" });
    expect(fs.existsSync(filesB.mise)).toBe(false); // B's own export target is still unaware of A's note

    // B's own `hands craft mise` call: opportunistic export, then a merged read — must see BOTH
    // notes even though B's note is the only one that was ever pending by the time B looked, and
    // A's note is already folded (not in pendingCraftNotes at all anymore).
    exportPendingCraftNotes(store, filesB, "mise-read:B");
    const bMerged = readMiseMerged(store, "saucier");
    expect(bMerged).toContain("from station A"); // came from allMiseCraftNotes, not B's own export or the pending queue
    expect(bMerged).toContain("from station B");

    // And A, reading again later, still sees both too — even though A's export ran FIRST,
    // before B's note even existed, and nothing ever copied B's write into A's export target.
    const aMerged = readMiseMerged(store, "saucier");
    expect(aMerged).toContain("from station A");
    expect(aMerged).toContain("from station B");

    // The two export targets do genuinely differ — that's the part the fix doesn't (and needn't)
    // prevent; only the DERIVED READ has to be complete, never the on-disk snapshot at any instant.
    expect(fs.readFileSync(filesA.mise, "utf8")).not.toContain("from station B");

    fs.rmSync(callerA, { recursive: true, force: true });
    fs.rmSync(callerB, { recursive: true, force: true });
    store.close();
  });
});

describe("buildFoldContext — holder-aware export before reading (hands#114/#223)", () => {
  it("exports pending book/skill notes (not just mise) before returning content, using the SAME holder as the caller's lease", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.book, "> covers: sauces\n");
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "book", body: "a fresh fact" });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "mise", body: "a/b.ts — does A" });

    const holder = "expo";
    expect(store.acquireCraftFoldLease("saucier", holder)).toBe(true);
    const ctx = buildFoldContext(store, "saucier", holder, env);

    // The file on disk was actually updated (not just the in-memory return value) — proves the
    // export ran under the SAME lease the caller already held, not a mismatched holder that would
    // have silently looked like contention and skipped.
    expect(fs.readFileSync(files.book, "utf8")).toContain("[book] a fresh fact");
    expect(ctx.book).toContain("[book] a fresh fact");
    // mise was mechanically applied+folded by the same export sweep, so pendingNotes excludes it —
    // exactly what FOLD_INSTRUCTIONS assumes ("mise.md maintains itself automatically").
    expect(ctx.pendingNotes.map((n) => n.kind)).toEqual(["book"]);
    store.close();
  });
});

describe("formatRawTaggedLine — exported for the merge functions above", () => {
  it("tags each kind the same way the real write path does", () => {
    const note = (kind: string, body: string, spilloverCraft: string | null = null) =>
      ({ id: 1, craft_slug: "x", brief_id: null, source_agent: "s", kind, body, spillover_craft: spilloverCraft, created_at: 0, folded_at: null }) as Parameters<typeof formatRawTaggedLine>[0];
    expect(formatRawTaggedLine(note("book", "a fact"))).toBe("[book] a fact");
    expect(formatRawTaggedLine(note("friction", "this was annoying"))).toBe("[friction] this was annoying");
    expect(formatRawTaggedLine(note("refactor", "should extract this"))).toBe("[refactor] should extract this");
    expect(formatRawTaggedLine(note("spillover", "not mine", "other-craft"))).toBe("[spillover · from other-craft] not mine");
    expect(formatRawTaggedLine(note("skill", "step 1"))).toBe("step 1"); // untagged
  });
});
