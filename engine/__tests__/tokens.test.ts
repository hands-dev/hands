import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectDir, TOKEN_BUCKET_MS, TokenSampler } from "../src/tokens.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hands-tokens-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-08-04T12:00:00Z");

function usageLine(opts: {
  id: string;
  ts: number;
  out: number;
  inTok?: number;
  cacheRead?: number;
}): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: new Date(opts.ts).toISOString(),
    uuid: `u-${opts.id}`,
    message: {
      id: opts.id,
      usage: {
        input_tokens: opts.inTok ?? 0,
        output_tokens: opts.out,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
  })}\n`;
}

function seedTranscript(cwd: string, session: string, body: string): string {
  const dir = path.join(root, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}

function sampler(): TokenSampler {
  return new TokenSampler({ projectsDir: root, now: () => NOW });
}

describe("encodeProjectDir", () => {
  it("maps every non-alphanumeric to a dash (verified against live dirs)", () => {
    expect(encodeProjectDir("/Users/michaelphillips/Development/hands")).toBe(
      "-Users-michaelphillips-Development-hands",
    );
    expect(encodeProjectDir("/Users/m/.hands/worktrees/repo-abc/station-1")).toBe(
      "-Users-m--hands-worktrees-repo-abc-station-1",
    );
  });
});

describe("TokenSampler", () => {
  it("dedupes streamed re-emits: last usage per message id wins", () => {
    const ts = NOW - 10 * 60_000;
    seedTranscript(
      "/w/expo",
      "s1",
      usageLine({ id: "m1", ts, out: 10 }) +
        usageLine({ id: "m1", ts, out: 200 }) +
        usageLine({ id: "m1", ts, out: 346 }) + // final
        usageLine({ id: "m2", ts, out: 50 }),
    );
    const series = sampler().sample([{ id: "expo", cwd: "/w/expo" }]);
    expect(series.totals24h.expo).toEqual({ out: 396, in: 0, cacheRead: 0 });
  });

  it("builds dense buckets, attributes usage to the right bucket per agent", () => {
    seedTranscript("/w/expo", "s1", usageLine({ id: "a", ts: NOW - 2 * TOKEN_BUCKET_MS, out: 100 }));
    seedTranscript("/w/s1", "s2", usageLine({ id: "b", ts: NOW - 60_000, out: 7, inTok: 3, cacheRead: 9 }));
    const series = sampler().sample([
      { id: "expo", cwd: "/w/expo" },
      { id: "station-1", cwd: "/w/s1" },
    ]);
    const expo = series.perAgent.expo!;
    const s1 = series.perAgent["station-1"]!;
    expect(expo).toHaveLength(96);
    expect(expo.reduce((n, b) => n + b.out, 0)).toBe(100);
    const ts = NOW - 60_000;
    const holding = s1.find((b) => b.t <= ts && ts < b.t + TOKEN_BUCKET_MS);
    expect(holding).toMatchObject({ out: 7, in: 3, cacheRead: 9 });
    // an agent with no transcripts still gets a dense zero series
    const ghost = sampler().sample([{ id: "station-9", cwd: "/w/none" }]);
    expect(ghost.perAgent["station-9"]!.every((b) => b.out === 0)).toBe(true);
  });

  it("reads incrementally: appended lines land without re-parsing history", () => {
    const file = seedTranscript("/w/expo", "s1", usageLine({ id: "m1", ts: NOW - 5 * 60_000, out: 11 }));
    const s = sampler();
    expect(s.sample([{ id: "expo", cwd: "/w/expo" }]).totals24h.expo!.out).toBe(11);
    fs.appendFileSync(file, usageLine({ id: "m2", ts: NOW - 4 * 60_000, out: 22 }));
    expect(s.sample([{ id: "expo", cwd: "/w/expo" }]).totals24h.expo!.out).toBe(33);
    // truncation resets cleanly
    fs.writeFileSync(file, usageLine({ id: "m3", ts: NOW - 3 * 60_000, out: 5 }));
    const after = s.sample([{ id: "expo", cwd: "/w/expo" }]).totals24h.expo!.out;
    expect(after).toBe(38); // m1+m2 already absorbed, m3 adds 5
  });

  it("seeds huge files at the tail cap without parsing full history", () => {
    const junk = `${"x".repeat(1024)}\n`.repeat(5 * 1024); // ~5MB of non-usage lines
    const tailLine = usageLine({ id: "recent", ts: NOW - 60_000, out: 42 });
    seedTranscript("/w/expo", "big", junk + tailLine);
    const series = sampler().sample([{ id: "expo", cwd: "/w/expo" }]);
    expect(series.totals24h.expo!.out).toBe(42);
  });

  it("ignores dead sessions (mtime beyond the window) and out-of-window usage", () => {
    const file = seedTranscript("/w/expo", "old", usageLine({ id: "m", ts: NOW - 60_000, out: 99 }));
    const old = new Date(NOW - 30 * 60 * 60_000);
    fs.utimesSync(file, old, old);
    const series = sampler().sample([{ id: "expo", cwd: "/w/expo" }]);
    expect(series.totals24h.expo!.out).toBe(0);

    seedTranscript("/w/s1", "s", usageLine({ id: "m", ts: NOW - 30 * 60 * 60_000, out: 77 }));
    const s2 = sampler().sample([{ id: "station-1", cwd: "/w/s1" }]);
    expect(s2.totals24h["station-1"]!.out).toBe(0); // in a live file but outside the 24h window
  });

  it("survives torn and non-assistant lines", () => {
    seedTranscript(
      "/w/expo",
      "s1",
      `{"type":"user","message":{}}\n{"type":"assistant","message":{"id":"x","usa\n` +
        usageLine({ id: "ok", ts: NOW - 60_000, out: 13 }),
    );
    expect(sampler().sample([{ id: "expo", cwd: "/w/expo" }]).totals24h.expo!.out).toBe(13);
  });
});
