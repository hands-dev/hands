import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resetConfigCache } from "../src/config.js";
import { exportPendingCraftNotes } from "../src/crafts.js";
import { resetRepoInfoCache } from "../src/paths.js";
import { craftFiles } from "../src/remote.js";
import { buildServer } from "../src/server.js";
import { runSubagentStop } from "../src/subagent-stop.js";
import { Store } from "../src/store.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hands-subagent-"));
  env = { HANDS_HOME: root };
  resetConfigCache();
  resetRepoInfoCache();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetConfigCache();
  resetRepoInfoCache();
});

function assistantLine(id: string, out: number): string {
  return `${JSON.stringify({ type: "assistant", message: { id, usage: { output_tokens: out } } })}\n`;
}

function assistantTextLine(text: string): string {
  return `${JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text }] } })}\n`;
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

    expect(result).toEqual({ recorded: true, agentType: "Explore", outputTokens: 150, craftNote: null, cdcSignoff: null });
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

    expect(result).toEqual({ recorded: true, agentType: "general-purpose", outputTokens: 10, craftNote: null, cdcSignoff: null });
    store.close();
  });

  it("records nothing for a missing or unreadable transcript", () => {
    const store = new Store({ env });
    const result = runSubagentStop(store, {
      ownerAgentId: "station-1",
      agentTranscriptPath: path.join(root, "nope.jsonl"),
    });
    expect(result).toEqual({ recorded: false, agentType: null, outputTokens: null, craftNote: null, cdcSignoff: null });
    expect(store.subagentSamples("station-1")).toEqual([]);
    store.close();
  });
});

describe("runSubagentStop — craft-note harvest (hands#81/#96/#56)", () => {
  it("harvests a craft-note block into craft_notes and marks the brief noted, independent of token accounting", () => {
    const store = new Store({ env });
    const briefId = store.createCraftBrief({ craftSlug: "ordering-api", mode: "plan", openedBy: "expo" });
    const transcript = path.join(root, "agent-3.jsonl");
    const note = [
      "some reasoning first",
      "```craft-note",
      `brief: ${briefId}`,
      "craft: ordering-api",
      "nothing-new: false",
      "mise: engine/src/orders/validate.ts — moved here",
      "book: menu validation runs before auth",
      "```",
    ].join("\n");
    fs.writeFileSync(transcript, assistantTextLine(note));

    const result = runSubagentStop(store, {
      ownerAgentId: "station-1",
      agentTranscriptPath: transcript,
      now: 7000,
    });

    expect(result.craftNote).toEqual({ craftSlug: "ordering-api", briefId, entriesHarvested: 2 });
    // hands#114/#223: the hook no longer mirrors notes into the craft's git-committed file — that
    // per-dispatch, per-worktree write is exactly what produced divergent books. Both notes stay
    // pending in the DB (the sole source of truth) until exportPendingCraftNotes (crafts.ts) —
    // called from `hands craft fold`/`hands craft mise`, not from this hook — lands them on disk.
    const pending = store.pendingCraftNotes("ordering-api");
    expect(pending.map((n) => n.kind).sort()).toEqual(["book", "mise"]);
    const craftEnv = { ...env, HANDS_NO_REPO_CONFIG: "1" };
    const files = craftFiles("ordering-api", craftEnv, root);
    expect(fs.existsSync(files.mise)).toBe(false);
    expect(fs.existsSync(files.book)).toBe(false);
    expect(store.getCraftBrief(briefId)?.noted_at).toBe(7000);
    store.close();
  });

  it("exportPendingCraftNotes (the new sole write path) lands what this hook harvested", () => {
    const store = new Store({ env });
    const transcript = path.join(root, "agent-3b.jsonl");
    const note = [
      "```craft-note",
      "brief: 12",
      "craft: ordering-api",
      "nothing-new: false",
      "mise: engine/src/orders/validate.ts — moved here",
      "book: menu validation runs before auth",
      "```",
    ].join("\n");
    fs.writeFileSync(transcript, assistantTextLine(note));
    runSubagentStop(store, { ownerAgentId: "station-1", agentTranscriptPath: transcript, now: 7500 });

    const craftEnv = { ...env, HANDS_NO_REPO_CONFIG: "1" };
    const files = craftFiles("ordering-api", craftEnv, root);
    const applied = exportPendingCraftNotes(store, files, "test-export");

    expect(applied.touched).toBe(2);
    expect(fs.readFileSync(files.mise, "utf8")).toContain("engine/src/orders/validate.ts — moved here");
    expect(fs.readFileSync(files.book, "utf8")).toContain("[book] menu validation runs before auth");
    // mise is mechanical — fully applied means folded; book still awaits real distillation.
    expect(store.pendingCraftNotes("ordering-api").map((n) => n.kind)).toEqual(["book"]);
    store.close();
  });

  it("a spillover entry is filed under the TARGET craft's pending notes, provenance-tagged with the source craft", () => {
    const store = new Store({ env });
    const transcript = path.join(root, "agent-4.jsonl");
    const note = [
      "```craft-note",
      "brief: 99",
      "craft: ordering-api",
      "nothing-new: false",
      "spillover(db-caching): the read path hits a cache layer I don't own",
      "```",
    ].join("\n");
    fs.writeFileSync(transcript, assistantTextLine(note));

    runSubagentStop(store, {
      ownerAgentId: "station-1",
      agentTranscriptPath: transcript,
      now: 8000,
    });

    expect(store.pendingCraftNotes("ordering-api")).toHaveLength(0);
    const spilled = store.pendingCraftNotes("db-caching");
    expect(spilled).toHaveLength(1);
    expect(spilled[0]?.kind).toBe("spillover");
    expect(spilled[0]?.spillover_craft).toBe("ordering-api");
    store.close();
  });

  it("nothing-new: true harvests zero entries but still stamps the brief as noted", () => {
    const store = new Store({ env });
    const briefId = store.createCraftBrief({ craftSlug: "saucier", mode: "plan", openedBy: "expo" });
    const transcript = path.join(root, "agent-5.jsonl");
    fs.writeFileSync(transcript, assistantTextLine(`\`\`\`craft-note\nbrief: ${briefId}\ncraft: saucier\nnothing-new: true\n\`\`\``));

    const result = runSubagentStop(store, { ownerAgentId: "station-1", agentTranscriptPath: transcript, now: 9000 });

    expect(result.craftNote).toEqual({ craftSlug: "saucier", briefId, entriesHarvested: 0 });
    expect(store.getCraftBrief(briefId)?.noted_at).toBe(9000);
    store.close();
  });

  it("a transcript with no craft-note block at all harvests null, same as before this feature existed", () => {
    const store = new Store({ env });
    const transcript = path.join(root, "agent-6.jsonl");
    fs.writeFileSync(transcript, assistantTextLine("just ordinary output, no fenced block"));
    const result = runSubagentStop(store, { ownerAgentId: "station-1", agentTranscriptPath: transcript, now: 1000 });
    expect(result.craftNote).toBeNull();
    store.close();
  });
});

describe("runSubagentStop — CDC pre-return verdict harvest (hands#128)", () => {
  it("records a signoff mechanically from a cdc-verdict block — no hands_craft_signoff call needed", () => {
    const store = new Store({ env });
    const taskId = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 500 });
    const briefId = store.createCraftBrief({ craftSlug: "cdc", mode: "plan", openedBy: "station-1", ticketId: taskId, now: 600 });
    const transcript = path.join(root, "cdc-1.jsonl");
    const verdict = [
      "some reasoning about the board first",
      "```cdc-verdict",
      `brief: ${briefId}`,
      "checkpoint: pre-return",
      "verdict: approved",
      "note: checked against origin/main, no collisions",
      "originSha: abc123",
      "```",
    ].join("\n");
    fs.writeFileSync(transcript, assistantTextLine(verdict));

    const result = runSubagentStop(store, { ownerAgentId: "station-1", agentTranscriptPath: transcript, now: 1000 });

    expect(result.cdcSignoff).toEqual({ taskId, checkpoint: "pre-return", verdict: "approved", signoffId: expect.any(Number) });
    const signoff = store.latestSignoff(taskId, "pre-return");
    expect(signoff?.verdict).toBe("approved");
    expect(signoff?.by).toBe("station-1");
    expect(signoff?.origin_sha).toBe("abc123");
    store.close();
  });

  it("the harvested signoff actually satisfies the real hands_task_update pre-return gate end to end", async () => {
    const store = new Store({ env });
    store.registerAgent({ id: "station-1", cwd: "/", pid: 1 });
    const server = buildServer(store, "station-1", DEFAULT_CONFIG, { currentOriginSha: () => "HEAD" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const taskId = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 500 });
    const briefId = store.createCraftBrief({ craftSlug: "cdc", mode: "plan", openedBy: "station-1", ticketId: taskId, now: 600 });
    const transcript = path.join(root, "cdc-2.jsonl");
    fs.writeFileSync(
      transcript,
      assistantTextLine(`\`\`\`cdc-verdict\nbrief: ${briefId}\ncheckpoint: pre-return\nverdict: approved\noriginSha: HEAD\n\`\`\``),
    );
    runSubagentStop(store, { ownerAgentId: "station-1", agentTranscriptPath: transcript, now: 1000 });

    const res = await client.callTool({
      name: "hands_task_update",
      arguments: { id: taskId, state: "returned", result: "done" },
    });
    expect(res.isError).not.toBe(true);
    expect(store.getTask(taskId)?.state).toBe("returned");
    await client.close();
    await server.close();
    store.close();
  });

  it("does NOT record a signoff for a ticket the dispatching agent doesn't own — mirrors hands_craft_signoff's own ownership check", () => {
    const store = new Store({ env });
    const taskId = store.createTask({ createdBy: "expo", assignee: "station-2", title: "someone else's ticket", now: 500 });
    const briefId = store.createCraftBrief({ craftSlug: "cdc", mode: "plan", openedBy: "station-1", ticketId: taskId, now: 600 });
    const transcript = path.join(root, "cdc-3.jsonl");
    fs.writeFileSync(
      transcript,
      assistantTextLine(`\`\`\`cdc-verdict\nbrief: ${briefId}\ncheckpoint: pre-return\nverdict: approved\n\`\`\``),
    );

    const result = runSubagentStop(store, { ownerAgentId: "station-1", agentTranscriptPath: transcript, now: 1000 });

    expect(result.cdcSignoff).toBeNull();
    expect(store.latestSignoff(taskId, "pre-return")).toBeUndefined();
    store.close();
  });

  it("does NOT record a signoff when the brief has no ticket_id — nothing to attach it to", () => {
    const store = new Store({ env });
    const briefId = store.createCraftBrief({ craftSlug: "cdc", mode: "plan", openedBy: "station-1", now: 600 }); // no ticketId
    const transcript = path.join(root, "cdc-4.jsonl");
    fs.writeFileSync(
      transcript,
      assistantTextLine(`\`\`\`cdc-verdict\nbrief: ${briefId}\ncheckpoint: pre-return\nverdict: approved\n\`\`\``),
    );

    const result = runSubagentStop(store, { ownerAgentId: "station-1", agentTranscriptPath: transcript, now: 1000 });
    expect(result.cdcSignoff).toBeNull();
    store.close();
  });

  it("does NOT auto-record pre-fire or pre-ship verdicts — scoped to pre-return only, expo still calls hands_craft_signoff by hand for those", () => {
    const store = new Store({ env });
    const taskId = store.createTask({ createdBy: "expo", assignee: "station-1", title: "fix the thing", now: 500 });
    const briefId = store.createCraftBrief({ craftSlug: "cdc", mode: "plan", openedBy: "expo", ticketId: taskId, now: 600 });
    const transcript = path.join(root, "cdc-5.jsonl");
    fs.writeFileSync(
      transcript,
      assistantTextLine(`\`\`\`cdc-verdict\nbrief: ${briefId}\ncheckpoint: pre-ship\nverdict: approved\n\`\`\``),
    );

    const result = runSubagentStop(store, { ownerAgentId: "expo", agentTranscriptPath: transcript, now: 1000 });
    expect(result.cdcSignoff).toBeNull();
    expect(store.latestSignoff(taskId, "pre-ship")).toBeUndefined();
    store.close();
  });

  it("a transcript with no cdc-verdict block at all harvests null", () => {
    const store = new Store({ env });
    const transcript = path.join(root, "cdc-6.jsonl");
    fs.writeFileSync(transcript, assistantTextLine("just ordinary output, no fenced block"));
    const result = runSubagentStop(store, { ownerAgentId: "station-1", agentTranscriptPath: transcript, now: 1000 });
    expect(result.cdcSignoff).toBeNull();
    store.close();
  });
});
