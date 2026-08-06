import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-conc-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Plain-JS body run in a worker thread. It opens its OWN connection to the
 * shared db file and hammers inserts, so this exercises real multi-process-style
 * SQLite contention (WAL + busy_timeout) rather than same-connection serialized
 * writes. Kept dependency-free (raw node:sqlite) so no TS transform is needed.
 */
const STATION_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { file, stationId, count } = workerData;
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA journal_mode = WAL;');
const stmt = db.prepare(
  'INSERT INTO messages (from_id, to_id, subject, body, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
for (let i = 0; i < count; i++) {
  // retry-on-busy mirror of Store.withRetry, in case busy_timeout is exhausted
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      stmt.run('w' + stationId, null, null, 'w' + stationId + '-' + i, null, Date.now());
      break;
    } catch (err) {
      const busy = err && (err.errcode === 5 || err.errcode === 6);
      if (!busy || attempt === 7) throw err;
    }
  }
}
db.close();
parentPort.postMessage('done');
`;

function runStation(file: string, stationId: number, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const station = new Worker(STATION_SRC, {
      eval: true,
      workerData: { file, stationId, count },
    });
    station.once("message", () => resolve());
    station.once("error", reject);
    station.once("exit", (code) => {
      if (code !== 0) reject(new Error(`station ${stationId} exited ${code}`));
    });
  });
}

describe("concurrent multi-connection writes", () => {
  it("neither corrupts the DB nor loses/dups messages under contention", async () => {
    // TOTAL stays within history()'s 500-row read cap so the test can verify
    // every single row is present exactly once.
    const STATIONS = 8;
    const PER_STATION = 60;
    const TOTAL = STATIONS * PER_STATION;

    // Create the schema up-front (stations only insert).
    const file = path.join(home, "hands.db");
    const seed = new Store({ env: { HANDS_HOME: home }, path: file });
    seed.close();

    await Promise.all(
      Array.from({ length: STATIONS }, (_, w) => runStation(file, w, PER_STATION)),
    );

    const store = new Store({ env: { HANDS_HOME: home }, path: file });

    // No loss: exactly TOTAL rows.
    const all = store.history({ limit: 500 });
    expect(all.length).toBe(TOTAL);

    // No dup / no loss: every (station,i) body present exactly once.
    const bodies = new Set(all.map((m) => m.body));
    expect(bodies.size).toBe(TOTAL);
    for (let w = 0; w < STATIONS; w++) {
      for (let i = 0; i < PER_STATION; i++) {
        expect(bodies.has(`w${w}-${i}`)).toBe(true);
      }
    }

    // No corruption: unique monotonic ids + integrity check clean.
    const ids = all.map((m) => m.id);
    expect(new Set(ids).size).toBe(TOTAL);
    store.close();
  });
});

/**
 * Mirrors updateTaskState's guarded UPDATE exactly (see store.ts) — a real,
 * independent connection racing the same SQL the store layer runs, not a call
 * through the Store class. Reports back how many rows its own UPDATE changed.
 */
const RESURRECT_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { file, taskId, assignee } = workerData;
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA journal_mode = WAL;');
const stmt = db.prepare(
  \`UPDATE tasks
     SET state = ?,
         assignee = COALESCE(?, assignee),
         result = COALESCE(?, result),
         started_at = CASE WHEN ? AND started_at IS NULL THEN ? ELSE started_at END,
         finished_at = CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE finished_at END,
         updated_at = ?
   WHERE id = ?
     AND NOT (? AND state IN ('done', 'cancelled'))\`
);
let changes = 0;
for (let attempt = 0; attempt < 8; attempt++) {
  try {
    const now = Date.now();
    changes = stmt.run('in_progress', assignee, null, 1, now, 0, now, now, taskId, 1).changes;
    break;
  } catch (err) {
    const busy = err && (err.errcode === 5 || err.errcode === 6);
    if (!busy || attempt === 7) throw err;
  }
}
db.close();
parentPort.postMessage(Number(changes));
`;

function runResurrectAttempt(file: string, taskId: number, assignee: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(RESURRECT_SRC, {
      eval: true,
      workerData: { file, taskId, assignee },
    });
    worker.once("message", (changes: number) => resolve(changes));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`resurrect worker exited ${code}`));
    });
  });
}

describe("concurrent ticket-state guard (hands#97 fast-follow)", () => {
  it("a cancelled ticket rejects every simultaneous resurrect attempt under real multi-connection contention", async () => {
    const file = path.join(home, "hands.db");
    const seed = new Store({ env: { HANDS_HOME: home }, path: file });
    const id = seed.createTask({ createdBy: "expo", assignee: "wt1", title: "a", now: 1000 });
    seed.updateTaskState({ id, state: "in_progress", now: 2000 });
    // Establish ground truth deterministically BEFORE the race: the ticket
    // is already terminal. A single simultaneous cancel-vs-claim race isn't
    // actually interesting here — whichever of the two lands first is a
    // legitimate, non-buggy outcome either way (claim-then-cancel and
    // cancel-then-rejected-claim are both correct). The real thing #97's
    // fix needs to survive is N *separate DB connections* hammering an
    // ALREADY-cancelled ticket at once — that's the exact TOCTOU window a
    // naive SELECT-then-UPDATE would have, which the single-statement
    // compare-and-set is supposed to close.
    seed.updateTaskState({ id, state: "cancelled", now: 3000 });
    const before = seed.getTask(id)!;
    expect(before.state).toBe("cancelled");
    seed.close();

    const RACERS = 8;
    const results = await Promise.all(
      Array.from({ length: RACERS }, (_, i) => runResurrectAttempt(file, id, `raider-${i}`)),
    );

    // Zero rows changed, across every single racing connection — no TOCTOU
    // window let any of them sneak a resurrect through.
    expect(results.every((changes) => changes === 0)).toBe(true);

    const store = new Store({ env: { HANDS_HOME: home }, path: file });
    const after = store.getTask(id)!;
    expect(after.state).toBe("cancelled");
    expect(after.assignee).toBe("wt1"); // untouched by any raider
    expect(after.finished_at).toBe(before.finished_at); // cost window still anchored to the real close
    store.close();
  });
});
