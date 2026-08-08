import * as fs from "node:fs";
import { parseCraftNoteBlock } from "./crafts.js";
import type { Store } from "./store.js";

export interface SubagentStopResult {
  recorded: boolean;
  agentType: string | null;
  outputTokens: number | null;
  /** craft-note harvest (hands#81/#96) — null when the transcript carried no fenced block at all */
  craftNote: { craftSlug: string | null; briefId: number | null; entriesHarvested: number } | null;
}

interface SubagentMeta {
  agentType?: string;
  spawnDepth?: number;
}

/**
 * Total output tokens across a (bounded, one-shot) subagent transcript —
 * unlike the station's own growing session transcript, a subagent file is
 * self-contained per Agent-tool call, so a full read is cheap and a full sum
 * is the meaningful number (`tokens.ts`'s own "peaked at ~112k tokens" framing
 * for a single call, hands#103). Dedupes by message id first, same as
 * `tokens.ts`'s `TokenSampler` — usage lines re-emit per message id as
 * streaming progresses, so summing raw lines would overcount.
 */
function totalOutputTokens(transcriptPath: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const byMessage = new Map<string, number>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        uuid?: string;
        message?: { id?: string; usage?: { output_tokens?: number } };
      };
      if (entry.type !== "assistant") continue;
      const usage = entry.message?.usage;
      if (!usage) continue;
      const id = entry.message?.id ?? entry.uuid;
      if (!id) continue;
      byMessage.set(id, usage.output_tokens ?? 0); // last write wins — same dedup as tokens.ts
    } catch {
      continue; // torn/corrupt line — skip it, keep summing the rest
    }
  }
  if (byMessage.size === 0) return null;
  let total = 0;
  for (const tokens of byMessage.values()) total += tokens;
  return total;
}

/** `.meta.json` sidecar next to a subagent transcript — same file `tokens.ts`'s `callLabel` reads. */
function readMeta(transcriptPath: string): SubagentMeta {
  try {
    const raw = fs.readFileSync(transcriptPath.replace(/\.jsonl$/, ".meta.json"), "utf8");
    return JSON.parse(raw) as SubagentMeta;
  } catch {
    return {};
  }
}

/**
 * Every assistant text block across the transcript, concatenated — the
 * craft-note contract asks for the fenced block as the LAST thing in the
 * final message, but concatenating the whole transcript (rather than
 * guessing which JSONL line is "the final message") is simpler and
 * parseCraftNoteBlock already picks the LAST fence occurrence, so this is
 * equivalent and more robust to transcript-shape drift.
 */
function assistantText(transcriptPath: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }
  const chunks: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> | string };
      };
      if (entry.type !== "assistant") continue;
      const content = entry.message?.content;
      if (typeof content === "string") chunks.push(content);
      else if (Array.isArray(content)) {
        for (const block of content) if (block.type === "text" && block.text) chunks.push(block.text);
      }
    } catch {
      continue; // torn/corrupt line — skip, keep scanning the rest
    }
  }
  return chunks.join("\n");
}

/**
 * Harvest a ```craft-note``` block mechanically (hands#81/#96) — this is what
 * makes the note reach storage whether or not the orchestrator ever reads the
 * sub-agent's return, the direct fix for hands#56 ("prep notes not reliably
 * reaching the books"). Best-effort like the rest of this hook: an unreadable
 * or note-less transcript is not an error, just nothing to harvest.
 *
 * `insertCraftNote` into `craft_notes` (the coordination DB, one per kitchen) is the ONLY write
 * this does — durable and concurrency-safe the instant it lands. This used to ALSO immediately
 * mirror the note into the craft's git-committed file (hands#118), but `repoInfo` (paths.ts)
 * resolves the SAME physical `.hands/crafts/` path from every worktree of a repo by design
 * (`--git-common-dir` is shared) — so that mirror write was every station's dispatch racing every
 * other station's straight onto ONE shared, uncommitted file, with only a short-TTL try-once
 * lease between them. That's how hands#223 produced divergent books for one craft (different
 * worktrees later pulling whatever got committed at different moments, not separate local copies
 * drifting apart). hands#114 removed that mirror write entirely: the DB is the single source of
 * truth, and `exportPendingCraftNotes` (crafts.ts) is now the only path that ever touches the
 * file, called from `hands craft fold` (guaranteed) and opportunistically from `hands craft mise`
 * — a live dispatch never depends on this hook having written anything to disk.
 */
function harvestCraftNote(store: Store, transcriptPath: string, now: number): SubagentStopResult["craftNote"] {
  const parsed = parseCraftNoteBlock(assistantText(transcriptPath));
  if (!parsed) return null;
  let entriesHarvested = 0;
  if (parsed.craftSlug) {
    for (const entry of parsed.entries) {
      const targetSlug = entry.kind === "spillover" && entry.spilloverCraft ? entry.spilloverCraft : parsed.craftSlug;
      store.insertCraftNote({
        craftSlug: targetSlug,
        briefId: parsed.briefId,
        sourceAgent: `subagent:${parsed.craftSlug}`,
        kind: entry.kind,
        body: entry.body,
        spilloverCraft: entry.kind === "spillover" ? parsed.craftSlug : null,
        now,
      });
      entriesHarvested++;
    }
  }
  if (parsed.briefId !== null) {
    try {
      store.markCraftBriefNoted(parsed.briefId, now);
    } catch {
      // best-effort — a stale/unknown brief id must never fail the hook
    }
  }
  return { craftSlug: parsed.craftSlug, briefId: parsed.briefId, entriesHarvested };
}

/**
 * The SubagentStop-hook workhorse. Two independent jobs on every subagent
 * finish: (1) hands#103 — records one token-usage completion sample, the gap
 * that left subagent activity invisible to anything but the dashboard's
 * periodic transcript scan; (2) hands#81/#96 — harvests a craft-note block
 * if the transcript carried one, so a craft sub-agent's learnings reach
 * storage whether or not its orchestrator ever reads its return. Both are
 * best-effort: an unreadable transcript, or one with neither usage data nor
 * a note, records nothing rather than failing the hook.
 */
export function runSubagentStop(
  store: Store,
  opts: {
    ownerAgentId: string;
    agentTranscriptPath: string;
    agentType?: string | null;
    now?: number;
  },
): SubagentStopResult {
  const now = opts.now ?? Date.now();
  const outputTokens = totalOutputTokens(opts.agentTranscriptPath);
  const meta = readMeta(opts.agentTranscriptPath);
  const agentType = meta.agentType ?? opts.agentType ?? null;
  // Independent of token accounting below — a craft-note harvest must not depend on usage data
  // being present (hands#56's fix: the note reaches storage regardless of what else worked).
  let craftNote: SubagentStopResult["craftNote"] = null;
  try {
    craftNote = harvestCraftNote(store, opts.agentTranscriptPath, now);
  } catch {
    // best-effort — a harvest failure must never fail the hook
  }
  if (outputTokens === null) {
    return { recorded: false, agentType, outputTokens: null, craftNote };
  }
  try {
    store.recordSubagentSample({
      ownerAgentId: opts.ownerAgentId,
      agentType,
      spawnDepth: typeof meta.spawnDepth === "number" ? meta.spawnDepth : null,
      outputTokens,
      now,
    });
  } catch {
    // best-effort, same contract as the transcript read above — a transient
    // write failure drops one telemetry sample, not the hook itself
    return { recorded: false, agentType, outputTokens, craftNote };
  }
  return { recorded: true, agentType, outputTokens, craftNote };
}
