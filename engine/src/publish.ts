import * as fs from "node:fs";
import { changedFiles, currentBranch, headSha, newCommits, ticketFromBranch } from "./git.js";
import { scanMemory } from "./memory.js";
import type { Store } from "./store.js";

const MAX_FILES = 50;
/** Enough to cover a handful of recent assistant turns without reading a whole (possibly tens-of-MB) session transcript. */
const USAGE_TAIL_CAP = 256 * 1024;

/**
 * The most recent assistant turn's token usage from a Claude Code transcript
 * — context length at Stop-hook time (hands#103). Reads only the file's tail
 * (the transcript keeps growing all session; the station's own reads would
 * get more expensive every turn otherwise), then scans backward for the last
 * `"type":"assistant"` line with a usage block. Best-effort: a torn line at
 * the tail boundary just falls through to the next one back.
 */
export function readLastUsage(
  transcriptPath: string,
): { input: number; cacheRead: number; cacheCreation: number } | null {
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - USAGE_TAIL_CAP);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(transcriptPath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          message?: {
            usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
        };
        if (entry.type !== "assistant") continue;
        const usage = entry.message?.usage;
        if (!usage) continue;
        return {
          input: usage.input_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheCreation: usage.cache_creation_input_tokens ?? 0,
        };
      } catch {
        continue; // torn/corrupt line at the tail boundary — try the one before it
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface PublishResult {
  agentId: string;
  branch: string | null;
  fileCount: number;
  commitsJournaled: number;
  memoriesJournaled: number;
}

/**
 * The Stop-hook workhorse. Derives status from git, heartbeats presence +
 * last_active, and journals new commits and memory writes. Best-effort and
 * fast — never throws on a git/memory hiccup.
 */
export function runPublish(
  store: Store,
  opts: {
    agentId: string;
    cwd: string;
    pid?: number;
    env?: NodeJS.ProcessEnv;
    now?: number;
    /** the Stop hook's own `transcript_path`, when invoked as a hook (hands#103) */
    transcriptPath?: string;
  },
): PublishResult {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const branch = currentBranch(opts.cwd);
  const files = changedFiles(opts.cwd).slice(0, MAX_FILES);
  const ticket = ticketFromBranch(branch);

  if (opts.transcriptPath) {
    const usage = readLastUsage(opts.transcriptPath);
    if (usage) {
      store.recordContextSample({
        agentId: opts.agentId,
        inputTokens: usage.input,
        cacheReadTokens: usage.cacheRead,
        cacheCreationTokens: usage.cacheCreation,
        now,
      });
    }
  }

  store.setStatus({
    id: opts.agentId,
    cwd: opts.cwd,
    pid: opts.pid ?? process.pid,
    branch,
    files,
    ticket,
    now,
  });

  // --- commit harvest (per-agent watermark; baseline on first run) ---
  let commitsJournaled = 0;
  const wmKey = "last_commit_sha";
  const prevSha = store.getWatermark(opts.agentId, wmKey);
  const head = headSha(opts.cwd);
  if (prevSha === null) {
    if (head) store.setWatermark(opts.agentId, wmKey, head); // baseline, no backfill
  } else {
    for (const c of newCommits(opts.cwd, prevSha)) {
      if (c.sha && !store.journalHasRef("commit", c.sha)) {
        store.journalAdd({ agentId: opts.agentId, kind: "commit", ref: c.sha, text: c.subject, now });
        commitsJournaled++;
      }
    }
    if (head) store.setWatermark(opts.agentId, wmKey, head);
  }

  // --- memory harvest (global watermark; baseline on first run; dedup across panes) ---
  let memoriesJournaled = 0;
  for (const entry of scanMemory(env)) {
    const key = `mem:${entry.name}`;
    const prevHash = store.getWatermark("*", key);
    if (prevHash === null) {
      store.setWatermark("*", key, entry.hash); // baseline, no backfill
      continue;
    }
    if (prevHash !== entry.hash) {
      store.journalAdd({
        agentId: opts.agentId,
        kind: "memory",
        ref: entry.name,
        text: entry.description || entry.name,
        now,
      });
      store.setWatermark("*", key, entry.hash);
      memoriesJournaled++;
    }
  }

  return { agentId: opts.agentId, branch, fileCount: files.length, commitsJournaled, memoriesJournaled };
}
