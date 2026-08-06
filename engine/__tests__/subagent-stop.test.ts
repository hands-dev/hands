import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSubagentStop } from "../src/subagent-stop.js";
import { Store } from "../src/store.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hands-subagent-"));
  env = { HANDS_HOME: root };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function assistantLine(id: string, out: number): string {
  return `${JSON.stringify({ type: "assistant", message: { id, usage: { output_tokens: out } } })}\n`;
}

describe("runSubagentStop", () => {
  it("sums deduped output tokens and records craft + spawn depth from the .meta.json sidecar", () => {
    const store = new Store({ env });
    const transcript = path.join(root, "agent-1.jsonl");
    // Same message id re-emitted mid-stream (last write wins), plus a second, distinct message.
    fs.writeFileSync(
      transcript,
      assistantLine("m1", 50) + assistantLine("m1", 120) + assistantLine("m2", 30),
    );
    fs.writeFileSync(
      path.join(root, "agent-1.meta.json"),
      JSON.stringify({ agentType: "Explore", spawnDepth: 1 }),
    );

    const result = runSubagentStop(store, { ownerAgentId: "station-1", agentTranscriptPath: transcript, now: 5000 });

    expect(result).toEqual({ recorded: true, agentType: "Explore", outputTokens: 150 });
    expect(store.subagentSamples("station-1")).toEqual([
      { agentType: "Explore", spawnDepth: 1, outputTokens: 150, at: 5000 },
    ]);
    store.close();
  });

  it("falls back to the hook payload's agent_type when no sidecar exists", () => {
    const store = new Store({ env });
    const transcript = path.join(root, "agent-2.jsonl");
    fs.writeFileSync(transcript, assistantLine("m1", 10));

    const result = runSubagentStop(store, {
      ownerAgentId: "station-1",
      agentTranscriptPath: transcript,
      agentType: "general-purpose",
      now: 6000,
    });

    expect(result).toEqual({ recorded: true, agentType: "general-purpose", outputTokens: 10 });
    store.close();
  });

  it("records nothing for a missing or unreadable transcript", () => {
    const store = new Store({ env });
    const result = runSubagentStop(store, {
      ownerAgentId: "station-1",
      agentTranscriptPath: path.join(root, "nope.jsonl"),
    });
    expect(result).toEqual({ recorded: false, agentType: null, outputTokens: null });
    expect(store.subagentSamples("station-1")).toEqual([]);
    store.close();
  });
});
