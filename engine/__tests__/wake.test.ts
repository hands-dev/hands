import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeStateHash } from "../src/board.js";
import { type HandsConfig, DEFAULT_CONFIG } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;
let stores: Store[];
let cleanups: Array<() => Promise<void>>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-wake-"));
  env = { HANDS_HOME: home };
  process.env.HANDS_HOME = home; // notify() reads process.env
  // currentUsageMode() (hands_board's usageMode field) also reads ambient process.env/cwd
  // directly, same as notify() above — isolate it from this checkout's own real
  // hands.config.json (HANDS_NO_REPO_CONFIG) and point its user-layer read at `home`.
  process.env.HANDS_TEST_HOME = home;
  process.env.HANDS_NO_REPO_CONFIG = "1";
  stores = [];
  cleanups = [];
  // hands#116 — hands_delegate now hard-requires an on-menu recipe. DEFAULT_CONFIG has no
  // remote.url, so recipesDir() falls back to <coordinationDir>/recipes = home/recipes here.
  fs.mkdirSync(path.join(home, "recipes"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "recipes", "test-recipe.md"),
    "# Test recipe\n> state: menu · rank: 1\n\n## Acceptance criteria\n- [ ] it works\n",
  );
});

afterEach(async () => {
  for (const c of cleanups) await c();
  for (const s of stores) s.close();
  delete process.env.HANDS_HOME;
  delete process.env.HANDS_TEST_HOME;
  delete process.env.HANDS_NO_REPO_CONFIG;
  fs.rmSync(home, { recursive: true, force: true });
});

async function connect(
  agentId: string,
  config?: HandsConfig,
  deps?: Parameters<typeof buildServer>[3],
): Promise<Client> {
  const store = new Store({ env });
  stores.push(store);
  store.registerAgent({ id: agentId, cwd: "/", pid: 1 });
  const server = buildServer(store, agentId, config ?? DEFAULT_CONFIG, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function notifyLines(agentId: string): string[] {
  try {
    return fs
      .readFileSync(path.join(home, `${agentId}.notify`), "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

describe("wake:false (non-waking FYI)", () => {
  it("stores the message and delivers on drain, but never touches .notify", async () => {
    const w1 = await connect("station-1");
    const res = await call(w1, "hands_send", {
      to: "expo",
      body: "parked X, moving on",
      wake: false,
    });
    expect(res.isError).toBe(false);
    expect(res.body.woken).toEqual([]);
    expect(notifyLines("expo")).toHaveLength(0);

    const expo = await connect("expo");
    const drained = await call(expo, "hands_receive", { wait_seconds: 0 });
    expect(drained.body.count).toBe(1);
    expect((drained.body.messages as Array<{ body: string }>)[0]!.body).toBe("parked X, moving on");
  });
});

describe("redundant-wake suppression", () => {
  it("a burst to an undrained recipient appends exactly ONE notify line; one drain returns all", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_send", { to: "station-1", body: "first" });
    await call(expo, "hands_send", { to: "station-1", body: "second" });
    const third = await call(expo, "hands_send", { to: "station-1", body: "third" });
    expect(third.body.woken).toEqual([]); // suppressed — wake already pending
    expect(notifyLines("station-1")).toHaveLength(1);

    const w1 = await connect("station-1");
    const drained = await call(w1, "hands_receive", { wait_seconds: 0 });
    expect(drained.body.count).toBe(3);
  });

  it("wakes again after the recipient drains", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_send", { to: "station-1", body: "first" });
    const w1 = await connect("station-1");
    await call(w1, "hands_receive", { wait_seconds: 0 }); // drains + advances cursor
    await call(expo, "hands_send", { to: "station-1", body: "second" });
    expect(notifyLines("station-1")).toHaveLength(2);
  });

  it("a broadcast only wakes peers who are fully drained", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    store.registerAgent({ id: "station-2", cwd: "/", pid: 3 });
    await call(expo, "hands_send", { to: "station-1", body: "just for you" });
    const bc = await call(expo, "hands_send", { to: "*", body: "all hands" });
    // station-1 is behind (undrained DM) → suppressed; station-2 gets the wake
    expect(bc.body.woken).toEqual(["station-2"]);
    expect(notifyLines("station-1")).toHaveLength(1);
    expect(notifyLines("station-2")).toHaveLength(1);
  });
});

/** A pid guaranteed dead: spawnSync blocks until the child exits, so by the time it returns the pid is reaped. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid!;
}

describe("silent-failure surfacing (hands#173, hands#183)", () => {
  it("distinguishes woken from coalesced in the response, instead of both reading as empty `woken`", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_send", { to: "station-1", body: "first" });
    const second = await call(expo, "hands_send", { to: "station-1", body: "second" });
    expect(second.body.woken).toEqual([]);
    expect(second.body.coalesced).toEqual(["station-1"]); // NOT a failure — legitimately behind
  });

  it("reports a real .notify write failure in notifyFailed, and does not permanently wedge the recipient", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    // A directory at the exact notify path forces the write to throw (EISDIR) —
    // deterministic reproduction of "the append attempt itself failed".
    fs.mkdirSync(path.join(home, "station-1.notify"));

    const first = await call(expo, "hands_send", { to: "station-1", body: "hello" });
    expect(first.isError).toBe(false); // the DB row still lands — only the nudge failed
    expect(first.body.woken).toEqual([]);
    expect(first.body.notifyFailed).toEqual(["station-1"]);

    // Unlike the old behavior (a swallowed failure still set wake_pending),
    // a failed write must not coalesce the next attempt — that would wedge
    // this recipient's wakes forever with no way to self-heal.
    fs.rmSync(path.join(home, "station-1.notify"), { recursive: true });
    const retry = await call(expo, "hands_send", { to: "station-1", body: "hello again" });
    expect(retry.body.woken).toEqual(["station-1"]);
    expect(retry.body.notifyFailed).toEqual([]);
  });

  it("warns on hands_send when the resolved recipient's pid is confirmed dead (hands#183)", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: deadPid() });
    const res = await call(expo, "hands_send", { to: "station-1", body: "hello" });
    expect(res.isError).toBe(false); // still delivered — reversible, not blocked
    expect(res.body.warning).toContain("station-1");
  });

  it("warns on hands_delegate when the assignee's pid is confirmed dead, but still creates the ticket", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: deadPid() });
    const res = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    expect(res.body.ok).toBe(true);
    expect(res.body.assignedTo).toBe("station-1");
    expect(res.body.warning).toContain("station-1");
  });

  it("a healthy assignee (real pid, monitor reported alive) gets no warning", async () => {
    // The dead-monitor real-process mechanism itself is watchers.test.ts's job (hands#105) — this
    // test's own subject is hands_delegate's warning-composition logic given a live monitor, so
    // the monitor's liveness is injected rather than proven with a spawned tail + process scan.
    const expo = await connect("expo", DEFAULT_CONFIG, { inboxMonitorAlive: () => true });
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: process.pid });
    const res = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    expect(res.body.warning).toBeUndefined();
  });

  it(
    "warns on hands_delegate when the process is alive but its inbox monitor is confirmed dead (hands#90)",
    async () => {
      const expo = await connect("expo");
      // process alive, but no tail on its notify file — the actual bug: a
      // live session that has gone deaf looks identical to a healthy one
      // everywhere except here.
      stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: process.pid });
      const res = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
      expect(res.body.ok).toBe(true); // NOT refused — the ticket is durably created regardless
      expect(res.body.assignedTo).toBe("station-1");
      expect(res.body.warning).toContain("station-1");
      expect(res.body.warning).toContain("monitor");
    },
  );

  it("hands_peers and hands_board surface `alive` distinctly from `online` for a dead-pid peer", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: deadPid() });

    const peers = await call(expo, "hands_peers", {});
    const p = (peers.body.peers as Array<{ id: string; online: boolean; alive: boolean }>).find(
      (x) => x.id === "station-1",
    );
    // Still within the 15-minute heartbeat window (just registered) — online
    // alone would say "fine". alive is what actually caught the dead process.
    expect(p).toMatchObject({ online: true, alive: false });

    const board = await call(expo, "hands_board", {});
    const b = (board.body.peers as Array<{ id: string; alive: boolean }>).find((x) => x.id === "station-1");
    expect(b?.alive).toBe(false);
  });
});

describe("assignment is expo-exclusive, no unassigned rail (hands#171/#87 phase a, hands#164)", () => {
  it("rejects a to-less delegation outright — no more silent queue", async () => {
    const expo = await connect("expo");
    const res = await call(expo, "hands_delegate", { title: "orphan ticket" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("requires `to`");
  });

  it("rejects a station trying to assign itself or another station, even naming itself", async () => {
    const w1 = await connect("station-1");
    stores[0]!.registerAgent({ id: "station-2", cwd: "/", pid: 2 });
    const toOther = await call(w1, "hands_delegate", { title: "task", to: "station-2" });
    expect(toOther.isError).toBe(true);
    expect(String(toOther.body.error)).toContain("Only the expo may assign");
    const toSelf = await call(w1, "hands_delegate", { title: "task", to: "station-1" });
    expect(toSelf.isError).toBe(true);
  });

  it("still lets the expo assign normally", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const res = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    expect(res.isError).toBe(false);
    expect(res.body.assignedTo).toBe("station-1");
  });
});

describe("cross-peer-id mention warning (hands#170)", () => {
  it("hands_delegate warns when a ticket body names another peer", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    stores[0]!.registerAgent({ id: "station-2", cwd: "/", pid: 3 });
    const res = await call(expo, "hands_delegate", {
      title: "fix the bug",
      body: "station-2 found this in their branch, go check it",
      to: "station-1",
      recipeSlug: "test-recipe",
    });
    expect(res.isError).toBe(false); // still lands — warning, not a block
    expect(String(res.body.warning)).toContain("station-2");
    expect(String(res.body.warning)).toContain("hands#170");
  });

  it("hands_delegate does NOT warn when the body only names the sender or the recipient", async () => {
    // A real, alive pid AND a monitor injected as alive — isolates this test to the leak-warning
    // path only, no interference from the unrelated hands#183 dead-pid or hands#90 dead-monitor
    // warnings. The monitor's liveness is injected (hands#105), not proven with a real spawned
    // tail — that real-process proof belongs to watchers.test.ts alone.
    const expo = await connect("expo", DEFAULT_CONFIG, { inboxMonitorAlive: () => true });
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: process.pid });
    const res = await call(expo, "hands_delegate", {
      title: "fix the bug",
      body: "station-1, confirm your diff to main.ts is limited to the digest line",
      to: "station-1",
      recipeSlug: "test-recipe",
    });
    expect(res.body.warning).toBeUndefined();
  });

  it("hands_send warns when a DM body names a third peer", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    stores[0]!.registerAgent({ id: "station-3", cwd: "/", pid: 3 });
    const res = await call(expo, "hands_send", {
      to: "station-1",
      body: "station-3 is behind on this — factor that in",
    });
    expect(String(res.body.warning)).toContain("station-3");
  });
});

describe("hands_obligations / hands_chase_mark (hands#164)", () => {
  it("surfaces an unclaimed ticket past the threshold, with lastChasedAt null until marked", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    // Backdated directly via the store (bypassing the MCP tool, which has no
    // `now` param) so the ticket reads as unclaimed past a 1-minute threshold.
    const id = store.createTask({ createdBy: "expo", assignee: "station-1", title: "plan X", now: Date.now() - 2 * 60_000 });

    const before = await call(expo, "hands_obligations", { unclaimedAfterMinutes: 1 });
    const obligations = before.body.obligations as Array<{ kind: string; id: number; lastChasedAt: number | null; neverChased: boolean }>;
    const mine = obligations.find((o) => o.kind === "task" && o.id === id);
    expect(mine).toBeDefined();
    expect(mine?.lastChasedAt).toBeNull();
    expect(mine?.neverChased).toBe(true);

    await call(expo, "hands_chase_mark", { kind: "task", id });
    const after = await call(expo, "hands_obligations", { unclaimedAfterMinutes: 1 });
    const mineAfter = (after.body.obligations as Array<{ id: number; neverChased: boolean }>).find((o) => o.id === id);
    expect(mineAfter?.neverChased).toBe(false);
  });

  it("does not surface a fresh ticket still inside the threshold", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    const res = await call(expo, "hands_obligations", { unclaimedAfterMinutes: 10 });
    expect(res.body.obligations).toEqual([]);
  });

  it("surfaces a long-unanswered escalation", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    const id = store.askQuestion({ asker: "station-1", question: "ship it?", now: Date.now() - 20 * 60_000 });
    store.escalateQuestion({ id, recommendation: "yes", now: Date.now() - 20 * 60_000 });

    const res = await call(expo, "hands_obligations", { unclaimedAfterMinutes: 10 });
    const obligations = res.body.obligations as Array<{ kind: string; id: number }>;
    expect(obligations.some((o) => o.kind === "question" && o.id === id)).toBe(true);
  });

  it("is expo-only — not registered for a station", async () => {
    const expo = await connect("expo");
    const w1 = await connect("station-1");
    const expoTools = (await expo.listTools()).tools.map((t) => t.name);
    const stationTools = (await w1.listTools()).tools.map((t) => t.name);
    expect(expoTools).toContain("hands_obligations");
    expect(expoTools).toContain("hands_chase_mark");
    expect(stationTools).not.toContain("hands_obligations");
    expect(stationTools).not.toContain("hands_chase_mark");
  });
});

describe("hands_escalate wakes sous when configured (hands#87/#171 phase b)", () => {
  it("does NOT wake sous when sous.enabled is false (default)", async () => {
    const expo = await connect("expo"); // DEFAULT_CONFIG — sous disabled
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const w1 = await connect("station-1");
    const ask = await call(w1, "hands_ask", { question: "ship it?" });
    const res = await call(expo, "hands_escalate", { id: ask.body.id as number, recommendation: "yes" });
    expect(res.body.wokeSous).toBe(false);
    expect(notifyLines("sous")).toHaveLength(0);
  });

  it("wakes sous when sous.enabled is true", async () => {
    const withSous = { ...DEFAULT_CONFIG, sous: { enabled: true } };
    const expo = await connect("expo", withSous);
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const w1 = await connect("station-1", withSous);
    const ask = await call(w1, "hands_ask", { question: "ship it?" });
    const res = await call(expo, "hands_escalate", { id: ask.body.id as number, recommendation: "yes" });
    expect(res.body.wokeSous).toBe(true);
    expect(notifyLines("sous")).toHaveLength(1);
  });

  it("warns when sous.enabled is true but no inbox monitor is tailing sous.notify (hands#93)", async () => {
    // The realistic default in any environment where nobody has run /loop /hands:sous —
    // exactly the bug #93 fixes: wokeSous used to report the config flag, not this.
    const withSous = { ...DEFAULT_CONFIG, sous: { enabled: true } };
    const expo = await connect("expo", withSous);
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const w1 = await connect("station-1", withSous);
    const ask = await call(w1, "hands_ask", { question: "ship it?" });
    const res = await call(expo, "hands_escalate", { id: ask.body.id as number, recommendation: "yes" });
    // The .notify write itself still succeeds — wokeSous stays true (hands#173's
    // distinction: did the write fail vs is anyone reading it are separate questions).
    expect(res.body.wokeSous).toBe(true);
    expect(String(res.body.warning)).toContain("no inbox monitor is tailing sous.notify");
  });

  it("hands_answer accepts by:'sous' and records provenance", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const w1 = await connect("station-1");
    const ask = await call(w1, "hands_ask", { question: "ship it?" });
    const res = await call(expo, "hands_answer", { id: ask.body.id as number, answer: "yes", by: "sous" });
    expect(res.isError).toBe(false);
    const q = stores[0]!.getQuestion(ask.body.id as number);
    expect(q?.resolved_by).toBe("sous");
  });
});

describe("hands_delegate recipe linkage (hands#116) — every ticket ladders up to an on-menu recipe", () => {
  it("rejects a delegation with no recipeSlug, listing today's menu", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const res = await call(expo, "hands_delegate", { title: "plan X", to: "station-1" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("requires recipeSlug");
    expect(String(res.body.error)).toContain("test-recipe");
    expect(stores[0]!.listTasks()).toHaveLength(0);
  });

  it("rejects a recipeSlug that exists but isn't on the menu (book-state)", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    fs.writeFileSync(
      path.join(home, "recipes", "book-recipe.md"),
      "# Book recipe\n> state: book\n\n## Acceptance criteria\n- [ ] not yet promoted\n",
    );
    const res = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "book-recipe" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("not on today's menu");
    expect(String(res.body.error)).toContain("hands recipe promote book-recipe");
  });

  it("rejects a recipeSlug that doesn't exist at all — same error shape as book-state", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const res = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "no-such-recipe" });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("not on today's menu");
  });

  it("succeeds and stores recipe_slug when the recipe is on the menu", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const res = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    expect(res.isError).toBe(false);
    expect(stores[0]!.getTask(res.body.id as number)?.recipe_slug).toBe("test-recipe");
  });

  it("a demoted recipe doesn't invalidate an existing ticket — it surfaces as offMenu drift instead", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const del = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    expect(del.isError).toBe(false);

    // demote the recipe out from under the already-created ticket
    fs.writeFileSync(
      path.join(home, "recipes", "test-recipe.md"),
      "# Test recipe\n> state: book\n\n## Acceptance criteria\n- [ ] it works\n",
    );

    const tasks = await call(expo, "hands_tasks", {});
    const t = (tasks.body.tasks as Array<{ id: number; recipeSlug?: string; offMenu?: boolean }>).find(
      (x) => x.id === (del.body.id as number),
    );
    expect(t?.recipeSlug).toBe("test-recipe"); // the ticket's own link is untouched
    expect(t?.offMenu).toBe(true); // but it's now visible drift, not silently fine

    // the station can still progress the ticket normally — demotion never blocks in-flight work
    const w1 = await connect("station-1", DEFAULT_CONFIG);
    const start = await call(w1, "hands_task_update", { id: del.body.id, state: "in_progress" });
    expect(start.isError).toBe(false);
  });
});

describe("hands_recipe_grade / hands_recipe_status (hands#116)", () => {
  it("grades a criterion, and hands_recipe_status surfaces it beside the checkbox — even when they disagree", async () => {
    const expo = await connect("expo");
    fs.writeFileSync(
      path.join(home, "recipes", "test-recipe.md"),
      "# Test recipe\n> state: menu · rank: 1\n\n## Acceptance criteria\n- [x] it works\n",
    );
    const status0 = await call(expo, "hands_recipe_status", { recipeSlug: "test-recipe" });
    const hash = (status0.body.criteria as Array<{ hash: string; text: string }>)[0]!.hash;
    expect((status0.body.criteria as Array<{ checkboxDone: boolean; grade: unknown }>)[0]).toMatchObject({
      checkboxDone: true,
      grade: null,
    });

    const grade = await call(expo, "hands_recipe_grade", {
      recipeSlug: "test-recipe",
      criterionHash: hash,
      verdict: "not_met",
      note: "regressed since the checkbox was ticked",
    });
    expect(grade.isError).toBe(false);

    const status1 = await call(expo, "hands_recipe_status", { recipeSlug: "test-recipe" });
    const c = (status1.body.criteria as Array<{ checkboxDone: boolean; grade: { verdict: string } | null }>)[0]!;
    // the disagreement is surfaced as-is, not resolved — checkbox still true, grade says not_met
    expect(c.checkboxDone).toBe(true);
    expect(c.grade?.verdict).toBe("not_met");
  });

  it("rejects grading a criterionHash that isn't among the recipe's current criteria", async () => {
    const expo = await connect("expo");
    const res = await call(expo, "hands_recipe_grade", {
      recipeSlug: "test-recipe",
      criterionHash: "not-a-real-hash",
      verdict: "met",
    });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("isn't among");
  });

  it("records an overall grade when criterionHash is omitted", async () => {
    const expo = await connect("expo");
    const res = await call(expo, "hands_recipe_grade", { recipeSlug: "test-recipe", verdict: "partial", note: "getting there" });
    expect(res.isError).toBe(false);
    const status = await call(expo, "hands_recipe_status", { recipeSlug: "test-recipe" });
    expect((status.body.overallGrade as { verdict: string })?.verdict).toBe("partial");
  });

  it("hands_recipe_status lists tickets currently laddering up to the recipe", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const del = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    const status = await call(expo, "hands_recipe_status", { recipeSlug: "test-recipe" });
    const tickets = status.body.tickets as Array<{ id: number; title: string }>;
    expect(tickets.map((t) => t.id)).toContain(del.body.id);
  });
});

describe("hands_craft_signoff (hands#139/#91/#95)", () => {
  it("records CDC's verdict for a ticket, and hands_tasks surfaces it back", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const del = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    const taskId = del.body.id as number;

    const res = await call(expo, "hands_craft_signoff", {
      taskId,
      checkpoint: "pre-fire",
      verdict: "approved",
      note: "board clean",
      originSha: "abc123",
    });
    expect(res.isError).toBe(false);

    const tasks = await call(expo, "hands_tasks", { assignee: "station-1" });
    const mine = (tasks.body.tasks as Array<{ id: number; signoff?: Record<string, unknown> }>).find(
      (t) => t.id === taskId,
    );
    expect(mine?.signoff).toMatchObject({
      checkpoint: "pre-fire",
      verdict: "approved",
      note: "board clean",
      originSha: "abc123",
      by: "expo",
    });
  });

  it("is expo-only — a station is rejected", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const w1 = await connect("station-1");
    const del = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });

    const res = await call(w1, "hands_craft_signoff", {
      taskId: del.body.id as number,
      checkpoint: "pre-ship",
      verdict: "approved",
    });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("Only the expo");
  });

  it("rejects an unknown task id rather than silently recording a phantom signoff", async () => {
    const expo = await connect("expo");
    const res = await call(expo, "hands_craft_signoff", {
      taskId: 999999,
      checkpoint: "pre-ship",
      verdict: "approved",
    });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("no such task");
  });

  it("hands_tasks reports no signoff field for a ticket that's never been judged", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    const tasks = await call(expo, "hands_tasks", { assignee: "station-1" });
    const mine = (tasks.body.tasks as Array<{ signoff?: unknown }>)[0];
    expect(mine?.signoff).toBeUndefined();
  });

  it("hands#112: a station MAY record 'pre-return' for a task it owns", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const del = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    const w1 = await connect("station-1");

    const res = await call(w1, "hands_craft_signoff", {
      taskId: del.body.id as number,
      checkpoint: "pre-return",
      verdict: "approved",
    });
    expect(res.isError).toBe(false);
  });

  it("hands#112: a station may NOT record 'pre-return' for someone ELSE's task — ownership, not role, is the boundary", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    stores[0]!.registerAgent({ id: "station-2", cwd: "/", pid: 3 });
    const del = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    const w2 = await connect("station-2");

    const res = await call(w2, "hands_craft_signoff", {
      taskId: del.body.id as number,
      checkpoint: "pre-return",
      verdict: "approved",
    });
    expect(res.isError).toBe(true);
    expect(String(res.body.error)).toContain("you own");
    expect(String(res.body.error)).toContain("station-1");
  });

  it("hands#112: a station still may NOT record 'pre-fire' or 'pre-ship' even for its own task — those stay expo-exclusive", async () => {
    const expo = await connect("expo");
    stores[0]!.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const del = await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    const w1 = await connect("station-1");

    for (const checkpoint of ["pre-fire", "pre-ship"] as const) {
      const res = await call(w1, "hands_craft_signoff", {
        taskId: del.body.id as number,
        checkpoint,
        verdict: "approved",
      });
      expect(res.isError).toBe(true);
      expect(String(res.body.error)).toContain("Only the expo");
    }
  });
});

describe("board stateHash + full bundle", () => {
  it("is stable when nothing changes and moves when assignments change", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    const a = await call(expo, "hands_board", {});
    const b = await call(expo, "hands_board", {});
    expect(a.body.stateHash).toBeTruthy();
    expect(a.body.stateHash).toBe(b.body.stateHash);
    await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    const c = await call(expo, "hands_board", {});
    expect(c.body.stateHash).not.toBe(a.body.stateHash);
  });

  it("full:true bundles tasks + questions + menu into one read", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    store.askQuestion({ asker: "station-1", question: "ship it?" });
    const res = await call(expo, "hands_board", { full: true });
    const tasks = res.body.activeTasks as Array<{ title: string; assignee: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.assignee).toBe("station-1");
    const questions = res.body.openQuestions as Array<{ question: string }>;
    expect(questions.map((q) => q.question)).toContain("ship it?");
    // hands#116 — beforeEach now seeds a promoted "test-recipe" (hands_delegate requires one), so
    // the menu is non-empty here; this assertion is just confirming the bundle carries it through.
    expect(res.body.menu).toMatchObject({ set: true });
    const plain = await call(expo, "hands_board", {});
    expect(plain.body.activeTasks).toBeUndefined();
  });

  it("carries the current usageMode, freshly read every call — not frozen at connect time", async () => {
    const expo = await connect("expo");
    expect((await call(expo, "hands_board", {})).body.usageMode).toBe("normal");

    // Flip it AFTER the server/connection already exists — this is the whole point of
    // currentUsageMode() being uncached: a long-lived MCP connection must still see it.
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "hands.config.json"), JSON.stringify({ usage: { mode: "low" } }));
    expect((await call(expo, "hands_board", {})).body.usageMode).toBe("low");
  });

  it("computeStateHash is directly stable for a fixed now", () => {
    const store = new Store({ env });
    stores.push(store);
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2, now: 1000 });
    const now = 5000;
    expect(computeStateHash(store, now)).toBe(computeStateHash(store, now));
  });
});

describe("wake accounting (wake_log)", () => {
  it("counts real wakes only — not wake:false, not suppressed bursts", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });

    // 2 FYIs → zero wakes recorded
    await call(expo, "hands_send", { to: "station-1", body: "fyi 1", wake: false });
    await call(expo, "hands_send", { to: "station-1", body: "fyi 2", wake: false });
    expect(store.wakeCounts().get("station-1")).toBeUndefined();

    // a 3-message burst → exactly 1 wake (suppression collapses the rest)
    await call(expo, "hands_send", { to: "station-1", body: "real 1" });
    await call(expo, "hands_send", { to: "station-1", body: "real 2" });
    await call(expo, "hands_send", { to: "station-1", body: "real 3" });
    expect(store.wakeCounts().get("station-1")).toMatchObject({ lastHour: 1, last24h: 1 });

    // drain, then another waking send → 2 total
    const w1 = await connect("station-1");
    await call(w1, "hands_receive", { wait_seconds: 0 });
    await call(expo, "hands_send", { to: "station-1", body: "again" });
    expect(store.wakeCounts().get("station-1")).toMatchObject({ lastHour: 2, last24h: 2 });
  });

  it("surfaces wakesLastHour on the board and counts delegation wakes", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_delegate", { title: "plan X", to: "station-1", recipeSlug: "test-recipe" });
    const board = await call(expo, "hands_board", {});
    const w1 = (board.body.peers as Array<{ id: string; wakesLastHour: number }>).find(
      (p) => p.id === "station-1",
    );
    expect(w1?.wakesLastHour).toBe(1);
  });

  it("prunes wake_log rows older than 24h", () => {
    const store = new Store({ env });
    stores.push(store);
    const now = Date.now();
    store.recordWakes(["station-1"], now - 25 * 60 * 60_000);
    store.recordWakes(["station-1"], now); // triggers the opportunistic prune
    expect(store.wakeCounts(now).get("station-1")).toMatchObject({ lastHour: 1, last24h: 1 });
  });
});

describe("message ack/turnaround (dashboard chat-bubble checkmark)", () => {
  it("a real hands_receive drain (mark_read: true, the default) acks every directed message in the batch", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_send", { to: "station-1", body: "pick up ENG-42" });

    const w1 = await connect("station-1");
    await call(w1, "hands_receive", { wait_seconds: 0 });

    const [msg] = store.history({ peer: "station-1", limit: 1 });
    expect(msg?.acked_at).not.toBeNull();
  });

  it("a peek (mark_read: false) never acks", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_send", { to: "station-1", body: "pick up ENG-42" });

    const w1 = await connect("station-1");
    await call(w1, "hands_receive", { wait_seconds: 0, mark_read: false });

    const [msg] = store.history({ peer: "station-1", limit: 1 });
    expect(msg?.acked_at).toBeNull();
  });

  it("a broadcast is never acked, even once every peer has drained it", async () => {
    const expo = await connect("expo");
    const store = stores[0]!;
    store.registerAgent({ id: "station-1", cwd: "/", pid: 2 });
    await call(expo, "hands_send", { to: "*", body: "stand down" });

    const w1 = await connect("station-1");
    await call(w1, "hands_receive", { wait_seconds: 0 });

    const [msg] = store.history({ limit: 1 });
    expect(msg?.to_id).toBeNull();
    expect(msg?.acked_at).toBeNull();
  });

  it("Store.ackMessages: first-drain wins, and a message to a different agent is never touched", () => {
    const store = new Store({ env });
    stores.push(store);
    const mine = store.insertMessage({ from: "expo", to: "station-1", body: "for station-1" });
    const theirs = store.insertMessage({ from: "expo", to: "station-2", body: "for station-2" });

    store.ackMessages("station-1", [mine, theirs], 1000);
    expect(store.history({ limit: 10 }).find((m) => m.id === mine)?.acked_at).toBe(1000);
    expect(store.history({ limit: 10 }).find((m) => m.id === theirs)?.acked_at).toBeNull();

    store.ackMessages("station-1", [mine], 2000); // a later "re-drain" must not push the time later
    expect(store.history({ limit: 10 }).find((m) => m.id === mine)?.acked_at).toBe(1000);
  });
});
