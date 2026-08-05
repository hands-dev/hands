import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectDir } from "../src/tokens.js";
import { idleMs, latestTranscript, recentActivity, transcriptDir } from "../src/station-logs.js";

let home: string;
const cwd = "/home/x/.hands/worktrees/demo/station-1";

function writeTranscript(name: string, lines: unknown[], mtime?: Date): string {
  const dir = transcriptDir(cwd, home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

const assistant = (ts: string, content: unknown[]) => ({
  type: "assistant",
  timestamp: ts,
  message: { content },
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-logs-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("transcript location", () => {
  it("agrees with tokens.ts about where a pane's transcripts live", () => {
    expect(transcriptDir(cwd, home)).toBe(
      path.join(home, ".claude", "projects", encodeProjectDir(cwd)),
    );
  });

  it("returns null when the pane has never taken a turn", () => {
    expect(latestTranscript(cwd, home)).toBeNull();
    expect(recentActivity(cwd, { home }).events).toEqual([]);
  });

  it("picks the most recently modified session, not the first on disk", () => {
    writeTranscript("old.jsonl", [assistant("2026-08-05T10:00:00Z", [])], new Date(1_000_000));
    const newer = writeTranscript("new.jsonl", [assistant("2026-08-05T11:00:00Z", [])], new Date(9_000_000));
    expect(latestTranscript(cwd, home)).toBe(newer);
  });
});

describe("activity extraction", () => {
  it("surfaces tool calls, text, and results", () => {
    writeTranscript("s.jsonl", [
      assistant("2026-08-05T10:00:00Z", [{ type: "text", text: "starting the plan" }]),
      assistant("2026-08-05T10:00:05Z", [{ type: "tool_use", name: "Read", input: { file: "a.ts" } }]),
      { type: "user", timestamp: "2026-08-05T10:00:06Z", message: { content: [{ type: "tool_result", content: "ok" }] } },
    ]);
    const kinds = recentActivity(cwd, { home }).events.map((e) => e.kind);
    expect(kinds).toEqual(["text", "tool", "result"]);
  });

  it("names the tool so you can see what it's doing", () => {
    writeTranscript("s.jsonl", [
      assistant("2026-08-05T10:00:00Z", [{ type: "tool_use", name: "Bash", input: { command: "ls" } }]),
    ]);
    expect(recentActivity(cwd, { home }).events[0]?.label).toBe("Bash");
  });

  it("flags tool errors distinctly from ordinary results", () => {
    writeTranscript("s.jsonl", [
      { type: "user", timestamp: "2026-08-05T10:00:00Z", message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] } },
    ]);
    const [event] = recentActivity(cwd, { home }).events;
    expect(event?.kind).toBe("error");
    expect(event?.detail).toContain("boom");
  });

  it("drops thinking blocks — they're most of the bytes and answer nothing", () => {
    writeTranscript("s.jsonl", [
      assistant("2026-08-05T10:00:00Z", [{ type: "thinking", thinking: "a very long ponder" }]),
      assistant("2026-08-05T10:00:01Z", [{ type: "tool_use", name: "Grep", input: {} }]),
    ]);
    const events = recentActivity(cwd, { home }).events;
    expect(events).toHaveLength(1);
    expect(events[0]?.label).toBe("Grep");
  });

  it("survives torn and non-JSON lines rather than throwing", () => {
    const dir = transcriptDir(cwd, home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "s.jsonl"),
      `{"broken\n${JSON.stringify(assistant("2026-08-05T10:00:00Z", [{ type: "tool_use", name: "Read", input: {} }]))}\nnot json\n`,
    );
    expect(recentActivity(cwd, { home }).events.map((e) => e.label)).toEqual(["Read"]);
  });

  it("honours the limit, keeping the most recent events", () => {
    writeTranscript(
      "s.jsonl",
      Array.from({ length: 10 }, (_, i) =>
        assistant(`2026-08-05T10:00:0${i}Z`, [{ type: "tool_use", name: `Tool${i}`, input: {} }]),
      ),
    );
    const events = recentActivity(cwd, { home, limit: 3 }).events;
    expect(events.map((e) => e.label)).toEqual(["Tool7", "Tool8", "Tool9"]);
  });
});

describe("idleMs — the 'is it actually moving?' signal", () => {
  it("measures from the last recorded activity", () => {
    writeTranscript("s.jsonl", [
      assistant("2026-08-05T10:00:00Z", [{ type: "tool_use", name: "Read", input: {} }]),
    ]);
    const now = Date.parse("2026-08-05T10:05:00Z");
    expect(idleMs(cwd, now, home)).toBe(5 * 60_000);
  });

  it("is null when there's no transcript at all", () => {
    expect(idleMs(cwd, Date.now(), home)).toBeNull();
  });
});
