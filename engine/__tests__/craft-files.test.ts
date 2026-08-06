import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { composeChit, listCrafts, parseCraftHeader, parseCraftNoteBlock } from "../src/crafts.js";
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
    expect(ctx).toContain("craft-saucier [personal] — sauces, stocks");
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
        picked_up_at: null,
        noted_at: null,
        created_at: Date.now(),
        expires_at: Date.now() + 1000,
      },
      "app.py order routes",
    );
    expect(chit).toContain('brief #4711, mode: plan');
    expect(chit).toContain("Covers: app.py order routes");
    expect(chit).toContain("hands_mise({ briefId: 4711 })");
    expect(chit).toContain("```craft-note");
    expect(chit).toContain("PLAN MODE: read, reason, propose");
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
