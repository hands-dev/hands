import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config.js";
import {
  appendRawNote,
  applyImmediateCraftNote,
  applyPendingMiseNotes,
  composeChit,
  craftAgentPath,
  craftKnown,
  craftSkillPath,
  formatRosterContext,
  listCrafts,
  materializeCraftAgents,
  nearestCraftSlugs,
  parseCraftHeader,
  parseCraftNoteBlock,
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
    ).toEqual({ covers: "app.py, orders/", distilled: "2026-08-01" });
  });

  it("tolerates the pre-cutover 'last held' key (parse tolerance, not a compat shim)", () => {
    expect(parseCraftHeader("> covers: app.py · last held: 2026-08-01 by station-1\n")).toEqual({
      covers: "app.py",
      distilled: "2026-08-01",
    });
  });

  it("returns nulls for missing/absent content", () => {
    expect(parseCraftHeader(null)).toEqual({ covers: null, distilled: null });
    expect(parseCraftHeader("no header line here")).toEqual({ covers: null, distilled: null });
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
    expect(ctx).toContain("saucier [personal, brief-only] — sauces, stocks");
    expect(ctx.length).toBeLessThan(2000); // roster summary, not the 5000-char book itself
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
    expect(after).toContain("Dispatch rate (7d): 1 of 1 finished ticket(s) went through a craft.");
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
    expect(rate).toEqual({ ticketsFinished: 1, ticketsWithCraftBrief: 0 });
    store.close();
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

    const skillBody = fs.readFileSync(craftSkillPath(target, "saucier"), "utf8");
    expect(skillBody).toContain("name: craft-saucier");
    expect(skillBody).toContain("hands craft mise <briefId>");
    expect(skillBody).toContain("Always taste before plating.");
    expect(skillBody).toContain("```craft-note");
    // Points at the LIVE usageMode in its own chit/mise output, not a snapshotted value
    // (Skill/Agent discovery is fixed at session start — baking a mode in here would go stale).
    expect(agentBody).toContain("Usage mode: low");
    expect(skillBody).toContain("usageMode");
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
    expect(before).toContain("saucier [personal, brief-only]");

    materializeCraftAgents(cfg, target, env);
    const after = formatRosterContext(listCrafts(store, cfg, env), target);
    // the craft's own line drops the annotation once synced — the static help text below it
    // still mentions "craft-<slug>" generically, so assert the specific line, not "anywhere at all".
    expect(after).toMatch(/- saucier \[personal\] —/);
    expect(after).not.toContain("saucier [personal, brief-only]");

    store.close();
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

describe("applyImmediateCraftNote — write-on-harvest (hands#118)", () => {
  it("mise: upserts into mise.md and marks the note folded immediately", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    const id = store.insertCraftNote({
      craftSlug: "saucier",
      sourceAgent: "subagent:saucier",
      kind: "mise",
      body: "engine/src/foo.ts — exports bar()",
    });
    const note = store.getCraftNote(id)!;
    const applied = applyImmediateCraftNote(store, files, note, "harvest:test");
    expect(applied).toBe(true);
    expect(fs.readFileSync(files.mise, "utf8")).toContain("engine/src/foo.ts — exports bar()");
    expect(store.pendingCraftNotes("saucier")).toEqual([]);
    store.close();
  });

  it("book: appends to book.md's raw section, tagged, and stays pending", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    const id = store.insertCraftNote({
      craftSlug: "saucier",
      sourceAgent: "subagent:saucier",
      kind: "book",
      body: "beurre blanc breaks over 58C",
    });
    const note = store.getCraftNote(id)!;
    expect(applyImmediateCraftNote(store, files, note, "harvest:test")).toBe(true);
    const bookText = fs.readFileSync(files.book, "utf8");
    expect(bookText).toContain("## Raw notes (unfolded)");
    expect(bookText).toContain("- [book] beurre blanc breaks over 58C");
    expect(store.pendingCraftNotes("saucier").map((n) => n.id)).toEqual([id]); // still pending
    store.close();
  });

  it("skill: appends to skill.md's raw section untagged", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    const id = store.insertCraftNote({
      craftSlug: "saucier",
      sourceAgent: "subagent:saucier",
      kind: "skill",
      body: "taste before plating",
    });
    const note = store.getCraftNote(id)!;
    expect(applyImmediateCraftNote(store, files, note, "harvest:test")).toBe(true);
    const skillText = fs.readFileSync(files.skill, "utf8");
    expect(skillText).toContain("## Raw notes (unfolded)");
    expect(skillText).toContain("- taste before plating");
    expect(skillText).not.toContain("[skill]");
    store.close();
  });

  it("spillover: tags the source craft and stays pending", () => {
    const store = new Store({ env });
    const files = craftFiles("ordering-api", env);
    const id = store.insertCraftNote({
      craftSlug: "ordering-api",
      sourceAgent: "subagent:saucier",
      kind: "spillover",
      body: "menu validation lives in app.py",
      spilloverCraft: "saucier",
    });
    const note = store.getCraftNote(id)!;
    expect(applyImmediateCraftNote(store, files, note, "harvest:test")).toBe(true);
    const bookText = fs.readFileSync(files.book, "utf8");
    expect(bookText).toContain("- [spillover · from saucier] menu validation lives in app.py");
    store.close();
  });

  it("skips cleanly (returns false, note stays pending) when the lease is already held", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    expect(store.acquireCraftFoldLease("saucier", "someone-else", 60_000)).toBe(true); // book/skill lease
    const id = store.insertCraftNote({
      craftSlug: "saucier",
      sourceAgent: "subagent:saucier",
      kind: "book",
      body: "held-out learning",
    });
    const note = store.getCraftNote(id)!;
    expect(applyImmediateCraftNote(store, files, note, "harvest:test")).toBe(false);
    expect(store.pendingCraftNotes("saucier").map((n) => n.id)).toEqual([id]);
    expect(fs.existsSync(files.book)).toBe(false); // never written
    store.close();
  });

  it("a mise write is NOT blocked by a held book/skill fold lease — different files, different lease key", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    expect(store.acquireCraftFoldLease("saucier", "someone-else", 60_000)).toBe(true); // book/skill lease only
    const id = store.insertCraftNote({
      craftSlug: "saucier",
      sourceAgent: "subagent:saucier",
      kind: "mise",
      body: "engine/src/bar.ts — does Y",
    });
    const note = store.getCraftNote(id)!;
    expect(applyImmediateCraftNote(store, files, note, "harvest:test")).toBe(true);
    store.close();
  });
});

describe("applyPendingMiseNotes — catch-up sweep (hands#118)", () => {
  it("applies every still-pending mise note and leaves book/skill notes untouched", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "mise", body: "a/b.ts — does A" });
    store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "mise", body: "c/d.ts — does C" });
    const bookId = store.insertCraftNote({ craftSlug: "saucier", sourceAgent: "s", kind: "book", body: "a fact" });

    const applied = applyPendingMiseNotes(store, files, "fold-catchup:test");
    expect(applied).toBe(2);
    const miseText = fs.readFileSync(files.mise, "utf8");
    expect(miseText).toContain("a/b.ts — does A");
    expect(miseText).toContain("c/d.ts — does C");
    expect(store.pendingCraftNotes("saucier").map((n) => n.id)).toEqual([bookId]);
    store.close();
  });
});
