import { describe, expect, it } from "vitest";
import {
  type ClaudeSession,
  contestedIds,
  describeSession,
  identityConflicts,
  scanClaudeSessions,
  type SessionScan,
  sessionsIn,
} from "../src/sessions.js";

const scanOf = (sessions: ClaudeSession[]): SessionScan => ({ method: "proc", sessions });

const STATIONS = [
  { id: "station-1", dir: "/wt/station-1" },
  { id: "station-2", dir: "/wt/station-2" },
];

describe("scanClaudeSessions — platform support", () => {
  it("reports unsupported (not empty-and-fine) on a platform it can't inspect", () => {
    const scan = scanClaudeSessions("win32");
    expect(scan.method).toBe("unsupported");
    expect(scan.reason).toContain("win32");
  });

  it("uses /proc on linux", () => {
    // this suite runs on linux in CI; the method is what matters, not the count
    if (process.platform === "linux") {
      expect(scanClaudeSessions("linux").method).toBe("proc");
    }
  });

  it("reports unsupported on darwin — no lsof scan (hands#206: TCC privacy prompts)", () => {
    const scan = scanClaudeSessions("darwin");
    expect(scan.method).toBe("unsupported");
    expect(scan.sessions).toEqual([]);
    expect(scan.reason).toBeTruthy();
  });
});

describe("identityConflicts — hands#152", () => {
  it("catches a pane in station-2's worktree claiming HANDS_ID=station-1", () => {
    // the exact reported incident
    const scan = scanOf([{ pid: 24450, cwd: "/wt/station-2", handsId: "station-1" }]);
    const [conflict] = identityConflicts(STATIONS, scan);
    expect(conflict).toBeDefined();
    expect(conflict?.claimed).toBe("station-1");
    expect(conflict?.expected).toBe("station-2");
    expect(conflict?.pid).toBe(24450);
  });

  it("is silent when id and worktree agree", () => {
    const scan = scanOf([{ pid: 1, cwd: "/wt/station-1", handsId: "station-1" }]);
    expect(identityConflicts(STATIONS, scan)).toEqual([]);
  });

  it("does not treat an unreadable HANDS_ID as a conflict", () => {
    // absence of evidence is not evidence of a mismatch — a null id means we
    // couldn't read the env, not that the pane is lying
    const scan = scanOf([{ pid: 1, cwd: "/wt/station-1", handsId: null }]);
    expect(identityConflicts(STATIONS, scan)).toEqual([]);
  });

  it("ignores sessions outside any station worktree", () => {
    const scan = scanOf([{ pid: 1, cwd: "/somewhere/else", handsId: "station-1" }]);
    expect(identityConflicts(STATIONS, scan)).toEqual([]);
  });
});

describe("contestedIds — one id, several panes", () => {
  it("flags two live panes claiming the same station", () => {
    const scan = scanOf([
      { pid: 1, cwd: "/wt/station-1", handsId: "station-1" },
      { pid: 2, cwd: "/wt/station-2", handsId: "station-1" },
    ]);
    const contested = contestedIds(scan, ["station-1", "station-2"]);
    expect([...contested.keys()]).toEqual(["station-1"]);
    expect(contested.get("station-1")).toHaveLength(2);
  });

  it("does NOT flag several expo sessions — sharing the expo seat is by design", () => {
    // regression: the first live run flagged 3 expo panes in the main checkout,
    // which is the ordinary case (a second window) and is counted against the
    // expo seat deliberately (see tokens.ts)
    const scan = scanOf([
      { pid: 1, cwd: "/repo", handsId: "expo" },
      { pid: 2, cwd: "/repo", handsId: "expo" },
      { pid: 3, cwd: "/repo", handsId: "expo" },
    ]);
    expect(contestedIds(scan, ["station-1", "station-2"]).size).toBe(0);
  });

  it("ignores ids that aren't known stations", () => {
    const scan = scanOf([
      { pid: 1, cwd: "/x", handsId: "something-else" },
      { pid: 2, cwd: "/y", handsId: "something-else" },
    ]);
    expect(contestedIds(scan, ["station-1"]).size).toBe(0);
  });
});

describe("sessionsIn — hands#147", () => {
  it("finds two sessions sharing one station worktree", () => {
    const scan = scanOf([
      { pid: 27949, cwd: "/wt/station-2", handsId: "station-2" },
      { pid: 24450, cwd: "/wt/station-2", handsId: "station-1" },
      { pid: 111, cwd: "/wt/station-1", handsId: "station-1" },
    ]);
    expect(sessionsIn("/wt/station-2", scan)).toHaveLength(2);
    expect(sessionsIn("/wt/station-1", scan)).toHaveLength(1);
  });

  it("returns nothing for a worktree with no sessions", () => {
    expect(sessionsIn("/wt/station-9", scanOf([]))).toEqual([]);
  });
});

describe("describeSession", () => {
  it("names the pid, the claimed id, and where it sits", () => {
    const line = describeSession({ pid: 42, cwd: "/wt/station-3", handsId: "station-1" });
    expect(line).toContain("42");
    expect(line).toContain("station-1");
    expect(line).toContain("station-3");
  });
});
