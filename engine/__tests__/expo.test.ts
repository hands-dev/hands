import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBoard } from "../src/board.js";
import { prioritiesPath, readPriorities, writePriorities } from "../src/priorities.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "yes-chef-expo-"));
  env = { YES_CHEF_HOME: home };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("priorities", () => {
  it("is absent until set, then round-trips ranked items", () => {
    expect(readPriorities(env).exists).toBe(false);
    writePriorities(["fix greptile gate", "staging stability", "loops cadence"], env);
    const p = readPriorities(env);
    expect(p.exists).toBe(true);
    expect(p.items).toEqual(["fix greptile gate", "staging stability", "loops cadence"]);
  });

  it("strips list markers and skips headers/blanks when reading a hand-edited file", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      prioritiesPath(env),
      "# Today\n\n- first thing\n2. second thing\n\n* third thing\n",
    );
    expect(readPriorities(env).items).toEqual(["first thing", "second thing", "third thing"]);
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
