import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBoard } from "../src/board.js";
import { loadConfig } from "../src/config.js";
import {
  currentMenu,
  listRecipes,
  menuOnDay,
  newRecipeStub,
  parseRecipe,
  recipeFiles,
  stampRecipeState,
} from "../src/recipes.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-expo-"));
  env = { HANDS_HOME: home };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("recipes (hands#96/#137 — replaces priorities.md/hands_priorities)", () => {
  it("is absent until drafted, then round-trips through promote/demote", () => {
    const cfg = loadConfig({ env });
    expect(listRecipes(cfg, env)).toEqual([]);

    const files = recipeFiles("fix greptile gate", cfg, env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.path, newRecipeStub("Fix the greptile gate"));
    expect(listRecipes(cfg, env)).toHaveLength(1);
    expect(currentMenu(listRecipes(cfg, env))).toEqual([]); // fresh recipe starts in the book, not the menu

    const promoted = stampRecipeState(fs.readFileSync(files.path, "utf8"), "menu", 1);
    fs.writeFileSync(files.path, promoted);
    const onMenu = currentMenu(listRecipes(cfg, env));
    expect(onMenu.map((r) => r.slug)).toEqual(["fix-greptile-gate"]);
    expect(onMenu[0]?.rank).toBe(1);

    const demoted = stampRecipeState(fs.readFileSync(files.path, "utf8"), "book", null);
    fs.writeFileSync(files.path, demoted);
    expect(currentMenu(listRecipes(cfg, env))).toEqual([]);
  });

  it("parses acceptance criteria as GFM checkboxes, counting done vs total", () => {
    const content = [
      "# Fix DELETE 404s",
      "> state: menu · rank: 2",
      "",
      "Fix the 404 semantics.",
      "",
      "## Acceptance criteria",
      "- [x] Given a deleted order, when DELETE runs again, then it 404s.",
      "- [ ] Given a valid order, when DELETE succeeds, then it's gone from GET.",
    ].join("\n");
    const r = parseRecipe("ordering-api-404-fix", content);
    expect(r.state).toBe("menu");
    expect(r.rank).toBe(2);
    expect(r.title).toBe("Fix DELETE 404s");
    expect(r.criteriaTotal).toBe(2);
    expect(r.criteriaDone).toBe(1);
  });
});

describe("menuOnDay — durable menu history from the journal, not new storage (hands#96)", () => {
  const day = (s: string) => Date.parse(`${s}T12:00:00Z`);

  it("a recipe promoted then never demoted stays on the menu for every later day", () => {
    const events = [
      { v: 1, ts: day("2026-08-01"), type: "recipe.promoted", data: { slug: "a", rank: 1 } },
    ];
    expect(menuOnDay(events, "2026-08-01")).toEqual(["a"]);
    expect(menuOnDay(events, "2026-08-05")).toEqual(["a"]); // still on, no demotion ever happened
  });

  it("a demotion after promotion removes it from later days but not earlier ones", () => {
    const events = [
      { v: 1, ts: day("2026-08-01"), type: "recipe.promoted", data: { slug: "a", rank: 1 } },
      { v: 1, ts: day("2026-08-03"), type: "recipe.demoted", data: { slug: "a" } },
    ];
    expect(menuOnDay(events, "2026-08-02")).toEqual(["a"]); // between promote and demote
    expect(menuOnDay(events, "2026-08-04")).toEqual([]); // after demote
  });

  it("only counts events up to and including the target day — future promotions don't leak backward", () => {
    const events = [
      { v: 1, ts: day("2026-08-10"), type: "recipe.promoted", data: { slug: "future-recipe", rank: 1 } },
    ];
    expect(menuOnDay(events, "2026-08-05")).toEqual([]);
  });

  it("tracks multiple recipes independently", () => {
    const events = [
      { v: 1, ts: day("2026-08-01"), type: "recipe.promoted", data: { slug: "a", rank: 1 } },
      { v: 1, ts: day("2026-08-01"), type: "recipe.promoted", data: { slug: "b", rank: 2 } },
      { v: 1, ts: day("2026-08-02"), type: "recipe.demoted", data: { slug: "a" } },
    ];
    expect(menuOnDay(events, "2026-08-03").sort()).toEqual(["b"]);
  });

  it("ignores unrelated journal event types", () => {
    const events = [
      { v: 1, ts: day("2026-08-01"), type: "recipe.promoted", data: { slug: "a", rank: 1 } },
      { v: 1, ts: day("2026-08-01"), type: "task.create", data: { id: 1 } },
    ];
    expect(menuOnDay(events, "2026-08-01")).toEqual(["a"]);
  });
});

describe("questions lifecycle", () => {
  it("ask → open → auto-answered, and shows up for the asker", () => {
    const store = new Store({ env });
    const id = store.askQuestion({ asker: "wt3", question: "ship INN-240?", context: "ctx", now: 1000 });
    expect(store.listQuestions({ state: "open" }).map((q) => q.asker)).toEqual(["wt3"]);

    store.answerQuestion({ id, answer: "ship it", resolvedBy: "expo", priorityRef: "staging", now: 2000 });
    const q = store.getQuestion(id)!;
    expect(q.state).toBe("answered");
    expect(q.answer).toBe("ship it");
    expect(q.resolved_by).toBe("expo");
    expect(q.priority_ref).toBe("staging");
    expect(store.listQuestions({ state: "open" })).toHaveLength(0);
    expect(store.answeredForAsker("wt3", 1500).map((r) => r.id)).toEqual([id]);
    store.close();
  });

  it("escalate → needs_human with recommendation", () => {
    const store = new Store({ env });
    const id = store.askQuestion({ asker: "wt2", question: "merge to main now?", now: 1000 });
    store.escalateQuestion({ id, recommendation: "wait for canary", priorityRef: "stability", now: 1500 });
    const q = store.getQuestion(id)!;
    expect(q.state).toBe("needs_human");
    expect(q.recommendation).toBe("wait for canary");
    expect(store.listQuestions({ state: "needs_human" })).toHaveLength(1);
    store.close();
  });

  it("structured options round-trip through ask and escalate (hands#84)", () => {
    const store = new Store({ env });
    const options = [
      { label: "ship", description: "cuts over now", recommended: true },
      { label: "wait", description: "hold for canary" },
    ];
    const id = store.askQuestion({
      asker: "wt3",
      question: "ship or wait?",
      options,
      multiSelect: false,
      now: 1000,
    });
    let q = store.getQuestion(id)!;
    expect(JSON.parse(q.options!)).toEqual(options);
    expect(q.multi_select).toBe(0);

    // Escalating WITHOUT options preserves what ask-time already attached (COALESCE, not overwrite).
    store.escalateQuestion({ id, recommendation: "ship", now: 1500 });
    q = store.getQuestion(id)!;
    expect(JSON.parse(q.options!)).toEqual(options);

    // Escalating WITH options overrides — the expo converting a prose recommendation into choices.
    const revised = [{ label: "ship now", description: "no more waiting" }, { label: "hold", description: "still risky" }];
    store.escalateQuestion({ id, recommendation: "ship now", options: revised, multiSelect: true, now: 1600 });
    q = store.getQuestion(id)!;
    expect(JSON.parse(q.options!)).toEqual(revised);
    expect(q.multi_select).toBe(1);
    store.close();
  });

  it("a free-text (option-less) question stores NULL options, unaffected by the feature", () => {
    const store = new Store({ env });
    const id = store.askQuestion({ asker: "wt3", question: "how should we phase this?", now: 1000 });
    const q = store.getQuestion(id)!;
    expect(q.options).toBeNull();
    expect(q.multi_select).toBeFalsy();
    store.close();
  });

  it("answering twice: the second call loses cleanly instead of overwriting the first (hands#84 concurrency fix)", () => {
    const store = new Store({ env });
    const id = store.askQuestion({ asker: "wt3", question: "ship it?", now: 1000 });
    store.escalateQuestion({ id, now: 1200 });

    const first = store.answerQuestion({
      id,
      answer: "ship",
      resolvedBy: "human",
      answeredVia: "dashboard",
      answerOptions: { chosenLabels: ["ship"] },
      now: 2000,
    });
    expect(first).toEqual({ ok: true });

    // A second, later answer — the TUI racing the dashboard for the same escalated question.
    const second = store.answerQuestion({
      id,
      answer: "wait",
      resolvedBy: "human",
      answeredVia: "tui",
      now: 2100,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("already-answered");
      // The loser learns WHO won, WHAT they answered, and VIA which surface — not just that it lost.
      expect(second.existing.answer).toBe("ship");
      expect(second.existing.resolved_by).toBe("human");
      expect(second.existing.answered_via).toBe("dashboard");
    }

    // The row itself reflects only the winner — never silently clobbered by the later call.
    const q = store.getQuestion(id)!;
    expect(q.answer).toBe("ship");
    expect(q.answered_via).toBe("dashboard");
    expect(JSON.parse(q.answer_options!)).toEqual({ chosenLabels: ["ship"] });
    store.close();
  });

  it("an expo auto-resolve stamps answered_via='expo' by default", () => {
    const store = new Store({ env });
    const id = store.askQuestion({ asker: "wt3", question: "bump the cache TTL?", now: 1000 });
    store.answerQuestion({ id, answer: "yes", resolvedBy: "expo", answeredVia: "expo", now: 1500 });
    expect(store.getQuestion(id)!.answered_via).toBe("expo");
    store.close();
  });
});

describe("board routing", () => {
  it("surfaces an answer to the asker as a delta", () => {
    const store = new Store({ env });
    const id = store.askQuestion({ asker: "wt3", question: "which venue lens?", now: 1000 });
    store.answerQuestion({ id, answer: "use the skill pick", resolvedBy: "expo", now: 2000 });
    const res = buildBoard(store, { agentId: "wt3", since: 1500, advance: false, now: 2500 });
    expect(res.text).toContain("expo answered");
    expect(res.text).toContain("use the skill pick");
    store.close();
  });

  it("surfaces new open questions to the expo as a delta", () => {
    const store = new Store({ env });
    store.askQuestion({ asker: "wt5", question: "bump the cache TTL?", now: 3000 });
    const res = buildBoard(store, { agentId: "expo", since: 2500, advance: false, now: 3500 });
    expect(res.text).toContain("wt5 asks");
    expect(res.text).toContain("bump the cache TTL?");
    store.close();
  });
});

describe("passive message awareness (backgrounded by default)", () => {
  it("shows a direct message in the board window without repeating (and never touches the receive cursor)", () => {
    const store = new Store({ env });
    store.insertMessage({ from: "wt2", to: "wt3", body: "rebase before you push", now: 5500 });

    const first = buildBoard(store, { agentId: "wt3", since: 5000, advance: true, now: 6000 });
    expect(first.text).toContain("✉ wt2 → you: rebase before you push");
    // board_since advanced to 6000 → next board (uses the watermark) is quiet
    const second = buildBoard(store, { agentId: "wt3", advance: true, now: 7000 });
    expect(second.text).toBe("");
    // showing it did NOT consume the receive cursor — a station can still handle it
    expect(store.getCursor("wt3")).toBe(0);
    expect(store.messagesSince("wt3", 0).map((m) => m.body)).toEqual(["rebase before you push"]);
    store.close();
  });

  it("shows broadcasts to everyone but the sender", () => {
    const store = new Store({ env });
    store.insertMessage({ from: "wt2", to: null, body: "all hands", now: 1000 });
    expect(buildBoard(store, { agentId: "wt4", since: 500, advance: false, now: 5000 }).text).toContain(
      "✉ wt2 → all: all hands",
    );
    expect(buildBoard(store, { agentId: "wt2", since: 500, advance: false, now: 5000 }).text).toBe("");
    store.close();
  });
});
