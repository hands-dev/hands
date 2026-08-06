import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLastUsage, runPublish } from "../src/publish.js";
import { Store } from "../src/store.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hands-publish-"));
  env = { HANDS_HOME: root };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function assistantLine(usage: Record<string, number> | undefined): string {
  return `${JSON.stringify({ type: "assistant", message: usage ? { usage } : {} })}\n`;
}

function writeTranscript(body: string): string {
  const file = path.join(root, "transcript.jsonl");
  fs.writeFileSync(file, body);
  return file;
}

describe("readLastUsage", () => {
  it("returns the last assistant usage block", () => {
    const file = writeTranscript(
      assistantLine({ input_tokens: 100, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }) +
        `${JSON.stringify({ type: "user" })}\n` +
        assistantLine({ input_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
    );
    expect(readLastUsage(file)).toEqual({ input: 500, cacheRead: 200, cacheCreation: 30 });
  });

  it("skips assistant lines with no usage block and torn trailing lines", () => {
    const file = writeTranscript(
      assistantLine({ input_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) +
        assistantLine(undefined) +
        "{not valid json\n",
    );
    expect(readLastUsage(file)).toEqual({ input: 42, cacheRead: 0, cacheCreation: 0 });
  });

  it("returns null for a missing file", () => {
    expect(readLastUsage(path.join(root, "nope.jsonl"))).toBeNull();
  });

  it("returns null when no assistant usage exists at all", () => {
    const file = writeTranscript(`${JSON.stringify({ type: "user" })}\n`);
    expect(readLastUsage(file)).toBeNull();
  });
});

describe("runPublish — context sampling", () => {
  it("records a context sample when transcriptPath resolves to real usage", () => {
    const store = new Store({ env });
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hands-publish-repo-"));
    const transcript = writeTranscript(
      assistantLine({ input_tokens: 1000, cache_read_input_tokens: 300, cache_creation_input_tokens: 20 }),
    );
    runPublish(store, { agentId: "station-1", cwd: repo, env, transcriptPath: transcript, now: 1000 });
    expect(store.contextSamples("station-1")).toEqual([
      { inputTokens: 1000, cacheReadTokens: 300, cacheCreationTokens: 20, at: 1000 },
    ]);
    store.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("records nothing when no transcriptPath is given (non-hook invocation)", () => {
    const store = new Store({ env });
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hands-publish-repo-"));
    runPublish(store, { agentId: "station-1", cwd: repo, env, now: 1000 });
    expect(store.contextSamples("station-1")).toEqual([]);
    store.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
