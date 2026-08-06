import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { readHookPayload } from "../src/server.js";

const originalStdin = process.stdin;

afterEach(() => {
  Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
});

function fakeStdin(): PassThrough & { isTTY: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean };
  stream.isTTY = false;
  return stream;
}

function setStdin(value: unknown): void {
  Object.defineProperty(process, "stdin", { value, configurable: true });
}

/**
 * readHookPayload's own doc comment claims a hook-shaped invocation whose
 * stdin never closes "can't hang the process past the hook's own 30s
 * timeout budget" — that claim rode on code inspection alone (the function
 * was module-private) until this file. Each test here drives the REAL
 * function against a REAL stream, not a reimplementation of its logic.
 */
describe("readHookPayload", () => {
  it("returns null immediately for an interactive TTY, without touching the stream", async () => {
    setStdin({ isTTY: true });
    await expect(readHookPayload(2000)).resolves.toBeNull();
  });

  it("parses a JSON payload piped on stdin before it closes", async () => {
    const stream = fakeStdin();
    setStdin(stream);
    const pending = readHookPayload(2000);
    stream.end(JSON.stringify({ transcript_path: "/tmp/t.jsonl", agent_type: "Explore" }));
    await expect(pending).resolves.toEqual({ transcript_path: "/tmp/t.jsonl", agent_type: "Explore" });
  });

  it("returns null on malformed JSON rather than throwing", async () => {
    const stream = fakeStdin();
    setStdin(stream);
    const pending = readHookPayload(2000);
    stream.end("not json{{{");
    await expect(pending).resolves.toBeNull();
  });

  it("returns null on an empty stream close (plain CLI invocation, no piped payload)", async () => {
    const stream = fakeStdin();
    setStdin(stream);
    const pending = readHookPayload(2000);
    stream.end();
    await expect(pending).resolves.toBeNull();
  });

  it("races the timeout and resolves null instead of hanging when stdin never closes", async () => {
    // Simulates the exact risk the doc comment describes: a hook-shaped
    // invocation whose stdin stream is opened but never ended.
    const stream = fakeStdin();
    setStdin(stream);
    const timeoutMs = 50; // short so the test stays fast; the mechanism is timeout-relative, not value-specific
    const start = Date.now();
    const result = await readHookPayload(timeoutMs);
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // Generous upper bound (not timeoutMs+epsilon) — this asserts "raced the
    // timeout" vs. "hung indefinitely," not a tight latency SLA.
    expect(elapsed).toBeLessThan(timeoutMs + 450);
    // Let the still-open async iteration settle quietly (EOF, not a stream
    // error) now that the test no longer needs it — otherwise it's a
    // dangling promise for the rest of the test file's lifetime.
    stream.end();
  });
});
