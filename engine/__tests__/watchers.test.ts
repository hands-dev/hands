import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inboxMonitorAlive, quiesce, watchersFor } from "../src/watchers.js";

/**
 * These drive REAL processes rather than a fake process table. The bugs this
 * code shipped with were all about which real processes matched — a forked
 * shell inheriting its parent's command line, wrapper shells around a tail —
 * and none of them would have reproduced against a mock.
 */

const linuxOnly = process.platform === "linux" ? describe : describe.skip;

let dir: string;
let notify: string;
let spawned: ChildProcess[] = [];

function detach(command: string): ChildProcess {
  // setsid + its own cwd, so it is neither our child nor our lineage
  const child = spawn("setsid", ["bash", "-c", command], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  spawned.push(child);
  return child;
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hands-watch-")));
  notify = path.join(dir, "station-9.notify");
  fs.writeFileSync(notify, "");
  spawned = [];
});

afterEach(() => {
  // Kill the process GROUPS we started. Deliberately not `pkill -f "<dir>"`:
  // that pattern appears in pkill's own command line, so pkill matches itself,
  // kills itself, and exits non-zero — which failed all 8 tests here. Exactly
  // the self-matching class of bug this module was written to fix.
  for (const c of spawned) {
    try {
      if (c.pid) process.kill(-c.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 400));

linuxOnly("watchersFor", () => {
  it("reports a dead inbox as DEAD, not as quiet", () => {
    const report = watchersFor("station-9", { notifyPath: notify, worktree: dir });
    expect(report.inboxAlive).toBe(false);
    expect(report.watchers).toEqual([]);
  });

  it("finds the inbox tail and marks it as the wake signal", async () => {
    detach(`tail -F -n0 ${notify}`);
    await settle();
    const report = watchersFor("station-9", { notifyPath: notify, worktree: dir });
    expect(report.inboxAlive).toBe(true);
    expect(report.watchers?.filter((w) => w.isInbox)).toHaveLength(1);
  });

  it("does NOT count the wrapper shell that spawns the tail as a second watcher", async () => {
    detach(`tail -F -n0 ${notify}`);
    await settle();
    const inboxes = watchersFor("station-9", { notifyPath: notify, worktree: dir }).watchers?.filter(
      (w) => w.isInbox,
    );
    // regression: substring matching reported four inbox watchers for one tail
    expect(inboxes).toHaveLength(1);
  });

  it("finds a poll loop running inside the station's worktree", async () => {
    detach(`cd ${dir} && while true; do sleep 5; done`);
    await settle();
    const report = watchersFor("station-9", { notifyPath: notify, worktree: dir });
    expect(report.watchers?.some((w) => !w.isInbox)).toBe(true);
  });

  it("ignores a loop that merely MENTIONS the station, running elsewhere", async () => {
    // regression: a forked shell inherits its parent's whole command line, so
    // "mentions the notify path" matched the caller's own harness — and
    // --clear killed it
    detach(`cd / && while true; do sleep 5; done # ${notify} station-9`);
    await settle();
    const report = watchersFor("station-9", { notifyPath: notify, worktree: dir });
    expect(report.watchers?.filter((w) => !w.isInbox)).toEqual([]);
  });

  it("never reports the caller's own lineage", () => {
    const report = watchersFor("station-9", { notifyPath: notify, worktree: dir });
    expect(report.watchers?.some((w) => w.pid === process.pid)).toBe(false);
  });
});

linuxOnly("quiesce", () => {
  it("stops strays but KEEPS the wake signal by default", async () => {
    detach(`tail -F -n0 ${notify}`);
    detach(`cd ${dir} && while true; do sleep 5; done`);
    await settle();

    const res = quiesce("station-9", { notifyPath: notify, worktree: dir });
    expect(res.supported).toBe(true);
    expect(res.stopped.every((w) => !w.isInbox)).toBe(true);
    expect(res.kept.some((w) => w.isInbox)).toBe(true);

    await settle();
    expect(inboxMonitorAlive("station-9", notify)).toBe(true);
  });

  it("stops the inbox too when explicitly asked", async () => {
    detach(`tail -F -n0 ${notify}`);
    await settle();

    quiesce("station-9", { notifyPath: notify, worktree: dir, keepInbox: false });
    await settle();
    expect(inboxMonitorAlive("station-9", notify)).toBe(false);
  });
});

linuxOnly("inboxMonitorAlive — anchored to the resolved path, not a bare id substring (hands#202)", () => {
  it("the anchored positive: a real tail for THIS station registers", async () => {
    detach(`tail -F -n0 ${notify}`);
    await settle();
    expect(inboxMonitorAlive("station-9", notify)).toBe(true);
  });

  it(
    "the decoy negative: a real tail for a DIFFERENT station's notify path — same station id, " +
      "different resolved path, the exact shape of two same-numbered stations in two different " +
      "kitchens on one machine — must NOT register as this station's own",
    async () => {
      const otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hands-watch-other-")));
      const otherNotify = path.join(otherDir, "station-9.notify"); // SAME id, different path
      fs.writeFileSync(otherNotify, "");
      try {
        detach(`tail -F -n0 ${otherNotify}`); // armed for the OTHER kitchen's station-9 only
        await settle();
        // The bare substring "station-9.notify" is present in the decoy's command line too —
        // an unanchored check would find it and report alive. Anchored to `notify` (this
        // station's own path), it must not.
        expect(inboxMonitorAlive("station-9", notify)).toBe(false);
        expect(watchersFor("station-9", { notifyPath: notify, worktree: dir }).inboxAlive).toBe(false);
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    },
  );

  it("catches a freshly-spawned tail without the test's own settle() wait — the retry's actual job", async () => {
    // Deliberately no `await settle()` here, unlike every other test in this file — this is
    // exactly the fresh-process-registration window the bounded retry (hands#202) exists to
    // absorb. Best-effort: this exercises the real timing gap the retry targets, but a single
    // local run passing is not a guarantee against every possible CI-load scenario — see the
    // PR notes for why a fully deterministic reproduction of the transient scan-miss isn't
    // provided here.
    detach(`tail -F -n0 ${notify}`);
    expect(inboxMonitorAlive("station-9", notify)).toBe(true);
  });
});
