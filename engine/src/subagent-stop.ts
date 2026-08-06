import * as fs from "node:fs";
import type { Store } from "./store.js";

export interface SubagentStopResult {
  recorded: boolean;
  agentType: string | null;
  outputTokens: number | null;
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
 * The SubagentStop-hook workhorse (hands#103) — records one completion
 * sample per subagent finish, the gap that left subagent activity invisible
 * to anything but the dashboard's periodic transcript scan. Best-effort:
 * an unreadable transcript records nothing rather than failing the hook.
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
  const outputTokens = totalOutputTokens(opts.agentTranscriptPath);
  const meta = readMeta(opts.agentTranscriptPath);
  const agentType = meta.agentType ?? opts.agentType ?? null;
  if (outputTokens === null) {
    return { recorded: false, agentType, outputTokens: null };
  }
  try {
    store.recordSubagentSample({
      ownerAgentId: opts.ownerAgentId,
      agentType,
      spawnDepth: typeof meta.spawnDepth === "number" ? meta.spawnDepth : null,
      outputTokens,
      now: opts.now,
    });
  } catch {
    // best-effort, same contract as the transcript read above — a transient
    // write failure drops one telemetry sample, not the hook itself
    return { recorded: false, agentType, outputTokens };
  }
  return { recorded: true, agentType, outputTokens };
}
