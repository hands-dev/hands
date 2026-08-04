import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSnapshot } from "../src/snapshot.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "yes-chef-test-"));
  env = { YES_CHEF_HOME: home };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function open(): Store {
  return new Store({ env });
}

describe("Store todos", () => {
  it("adds an open todo and lists it", () => {
    const store = open();
    const { id, isNew } = store.createTodo({ title: "Merge PR #2354", originRef: "2354" });
    expect(isNew).toBe(true);
    const rows = store.listTodos({ state: "open" });
    expect(rows.map((t) => t.title)).toEqual(["Merge PR #2354"]);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.source).toBe("expo"); // default
    store.close();
  });

  it("is idempotent while open when a dedupKey repeats", () => {
    const store = open();
    const first = store.createTodo({ title: "Decide INN-240", dedupKey: "q:7" });
    const second = store.createTodo({ title: "Decide INN-240 (again)", dedupKey: "q:7" });
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
    expect(store.listTodos().length).toBe(1); // no duplicate
    store.close();
  });

  it("lets a dedupKey re-open after the prior item is done", () => {
    const store = open();
    const first = store.createTodo({ title: "Weekly review", dedupKey: "weekly" });
    store.updateTodoState({ id: first.id, state: "done", doneSignal: "did it" });
    const second = store.createTodo({ title: "Weekly review", dedupKey: "weekly" });
    expect(second.isNew).toBe(true); // done row is exempt from the open-dedup index
    expect(second.id).not.toBe(first.id);
    expect(store.listTodos({ state: "open" }).length).toBe(1);
    store.close();
  });

  it("crosses off with a reversible done_signal and can re-open", () => {
    const store = open();
    const { id } = store.createTodo({ title: "Merge PR #2354" });
    store.updateTodoState({ id, state: "done", doneSignal: "PR #2354 merged" });
    let row = store.getTodo(id)!;
    expect(row.state).toBe("done");
    expect(row.done_signal).toBe("PR #2354 merged");

    store.updateTodoState({ id, state: "open" }); // undo
    row = store.getTodo(id)!;
    expect(row.state).toBe("open");
    expect(row.done_signal).toBe("PR #2354 merged"); // signal preserved for the audit trail
    store.close();
  });

  it("surfaces todos + openTodos count in the dashboard snapshot", () => {
    const store = open();
    store.createTodo({ title: "Decide INN-240", priority: "staging stability" });
    const done = store.createTodo({ title: "Merge PR #2354" });
    store.updateTodoState({ id: done.id, state: "done", doneSignal: "PR #2354 merged" });

    const snap = buildSnapshot(store);
    expect(snap.counts.openTodos).toBe(1);
    expect(snap.todos.map((t) => t.title).sort()).toEqual(["Decide INN-240", "Merge PR #2354"]);
    const openTodo = snap.todos.find((t) => t.title === "Decide INN-240")!;
    expect(openTodo.priority).toBe("staging stability");
    store.close();
  });
});
