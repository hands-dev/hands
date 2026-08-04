import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBoard } from "../src/board.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-deleg-"));
  env = { HANDS_HOME: home };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("delegation lifecycle", () => {
  it("assigned → in_progress → returned → done, surfacing at each end via the board", () => {
    const store = new Store({ env });
    const id = store.createTask({
      createdBy: "expo",
      assignee: "wt3",
      title: "Plan feature X",
      body: "end-to-end plan",
      priority: "P1",
      now: 1000,
    });
    expect(store.getTask(id)!.state).toBe("assigned");

    // station sees the new assignment in its board delta
    expect(buildBoard(store, { agentId: "wt3", since: 500, advance: false, now: 1500 }).text).toContain(
      "expo fired",
    );

    store.updateTaskState({ id, state: "in_progress", now: 2000 });
    expect(store.getTask(id)!.state).toBe("in_progress");
    expect(store.getTask(id)!.started_at).toBe(2000); // cost-interval start stamped once

    store.updateTaskState({ id, state: "returned", result: "here is the plan", now: 3000 });
    const returned = store.getTask(id)!;
    expect(returned.state).toBe("returned");
    expect(returned.result).toBe("here is the plan");
    expect(returned.started_at).toBe(2000); // first transition wins
    expect(returned.finished_at).toBe(3000); // cost-interval end stamped

    // expo (creator) sees the return in its board delta
    expect(buildBoard(store, { agentId: "expo", since: 2500, advance: false, now: 3500 }).text).toContain(
      "wt3 returned",
    );

    store.updateTaskState({ id, state: "done", now: 4000 });
    expect(store.getTask(id)!.state).toBe("done");
    store.close();
  });

  it("an unassigned task is 'open' and a station claims it on start", () => {
    const store = new Store({ env });
    const id = store.createTask({ createdBy: "expo", title: "any available WT", now: 1000 });
    const t = store.getTask(id)!;
    expect(t.state).toBe("open");
    expect(t.assignee).toBeNull();

    store.updateTaskState({ id, state: "in_progress", assignee: "wt5", now: 2000 });
    expect(store.getTask(id)!.assignee).toBe("wt5");
    store.close();
  });

  it("active/returned filters work", () => {
    const store = new Store({ env });
    store.createTask({ createdBy: "expo", assignee: "wt1", title: "a", now: 1000 });
    const b = store.createTask({ createdBy: "expo", assignee: "wt2", title: "b", now: 1000 });
    store.updateTaskState({ id: b, state: "returned", result: "r", now: 2000 });
    expect(store.listTasks({ active: true }).length).toBe(2);
    expect(store.listTasks({ state: "returned" }).map((t) => t.title)).toEqual(["b"]);
    store.close();
  });
});
