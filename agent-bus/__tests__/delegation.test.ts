import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBoard } from "../src/board.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-deleg-"));
  env = { AGENT_BUS_HOME: home };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("delegation lifecycle", () => {
  it("assigned → in_progress → returned → done, surfacing at each end via the board", () => {
    const store = new Store({ env });
    const id = store.createTask({
      createdBy: "foreman",
      assignee: "wt3",
      title: "Plan feature X",
      body: "end-to-end plan",
      priority: "P1",
      now: 1000,
    });
    expect(store.getTask(id)!.state).toBe("assigned");

    // worker sees the new assignment in its board delta
    expect(buildBoard(store, { agentId: "wt3", since: 500, advance: false, now: 1500 }).text).toContain(
      "Leo (foreman) delegated",
    );

    store.updateTaskState({ id, state: "in_progress", now: 2000 });
    expect(store.getTask(id)!.state).toBe("in_progress");

    store.updateTaskState({ id, state: "returned", result: "here is the plan", now: 3000 });
    const returned = store.getTask(id)!;
    expect(returned.state).toBe("returned");
    expect(returned.result).toBe("here is the plan");

    // foreman (creator) sees the return in its board delta
    expect(buildBoard(store, { agentId: "foreman", since: 2500, advance: false, now: 3500 }).text).toContain(
      "Sam (wt3) returned",
    );

    store.updateTaskState({ id, state: "done", now: 4000 });
    expect(store.getTask(id)!.state).toBe("done");
    store.close();
  });

  it("an unassigned task is 'open' and a worker claims it on start", () => {
    const store = new Store({ env });
    const id = store.createTask({ createdBy: "foreman", title: "any available WT", now: 1000 });
    const t = store.getTask(id)!;
    expect(t.state).toBe("open");
    expect(t.assignee).toBeNull();

    store.updateTaskState({ id, state: "in_progress", assignee: "wt5", now: 2000 });
    expect(store.getTask(id)!.assignee).toBe("wt5");
    store.close();
  });

  it("active/returned filters work", () => {
    const store = new Store({ env });
    store.createTask({ createdBy: "foreman", assignee: "wt1", title: "a", now: 1000 });
    const b = store.createTask({ createdBy: "foreman", assignee: "wt2", title: "b", now: 1000 });
    store.updateTaskState({ id: b, state: "returned", result: "r", now: 2000 });
    expect(store.listTasks({ active: true }).length).toBe(2);
    expect(store.listTasks({ state: "returned" }).map((t) => t.title)).toEqual(["b"]);
    store.close();
  });
});
