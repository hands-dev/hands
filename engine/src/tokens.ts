import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Per-instance token telemetry, read from Claude Code's own session
 * transcripts (`~/.claude/projects/<encoded-cwd>/<session>.jsonl`). Every
 * pane on the bus reports its cwd; each cwd has a transcript dir; every
 * `"type":"assistant"` line carries `message.usage` and a timestamp — real
 * numbers, not estimates. The MCP server itself burns nothing; the series
 * are the PANES (expo seat + stations). Sessions the principal runs in the
 * main checkout share the expo seat's dir and are counted there.
 *
 * Design constraints (verified against live transcripts):
 * - usage lines RE-EMIT per message id as streaming progresses (5× observed)
 *   → dedupe by keeping the last usage per id, never summing lines
 * - files reach tens of MB → incremental reads only: per-file byte offset,
 *   first encounter seeds at a tail cap, truncation resets
 * - everything best-effort: a missing dir or torn line never breaks sampling
 */

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export interface TokenBucket {
  /** bucket start, epoch ms */
  t: number;
  out: number;
  in: number;
  cacheRead: number;
}

export interface TokenTotals {
  out: number;
  in: number;
  cacheRead: number;
}

export interface TokenSeries {
  bucketMs: number;
  windowMs: number;
  /** dense buckets (zeros filled), oldest → newest, per agent id */
  perAgent: Record<string, TokenBucket[]>;
  totals24h: Record<string, TokenTotals>;
}

export const TOKEN_BUCKET_MS = 15 * 60_000;
export const TOKEN_WINDOW_MS = 24 * 60 * 60_000;
const TAIL_CAP = 4 * 1024 * 1024;
const MTIME_SLACK_MS = 60 * 60_000;

interface FileState {
  offset: number;
  partial: string;
}

interface MsgUsage {
  ts: number;
  out: number;
  inTok: number;
  cacheRead: number;
}

export class TokenSampler {
  private readonly projectsDir: string;
  private readonly now: () => number;
  private readonly files = new Map<string, FileState>();
  /** agentId → messageId → final usage (last write wins — the dedupe) */
  private readonly messages = new Map<string, Map<string, MsgUsage>>();

  constructor(opts?: { projectsDir?: string; now?: () => number }) {
    this.projectsDir = opts?.projectsDir ?? path.join(os.homedir(), ".claude", "projects");
    this.now = opts?.now ?? (() => Date.now());
  }

  sample(agents: ReadonlyArray<{ id: string; cwd: string | null }>): TokenSeries {
    const now = this.now();
    for (const agent of agents) {
      if (!agent.cwd) continue;
      const dir = path.join(this.projectsDir, encodeProjectDir(agent.cwd));
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue; // this pane never ran Claude Code here — fine
      }
      let byMsg = this.messages.get(agent.id);
      if (!byMsg) {
        byMsg = new Map();
        this.messages.set(agent.id, byMsg);
      }
      for (const name of names) {
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          if (now - stat.mtimeMs > TOKEN_WINDOW_MS + MTIME_SLACK_MS) continue; // dead session
          this.readAppended(file, stat.size, byMsg);
        } catch {
          // unreadable — skip, retry next tick
        }
      }
      for (const [id, m] of byMsg) {
        if (now - m.ts > TOKEN_WINDOW_MS + TOKEN_BUCKET_MS) byMsg.delete(id);
      }
    }
    return this.series(now, agents);
  }

  private readAppended(file: string, size: number, byMsg: Map<string, MsgUsage>): void {
    let state = this.files.get(file);
    let dropFirstLine = false;
    if (!state) {
      state = { offset: Math.max(0, size - TAIL_CAP), partial: "" };
      dropFirstLine = state.offset > 0; // seeded mid-file → first line is torn
      this.files.set(file, state);
    }
    if (size < state.offset) {
      // truncated/rotated — start over
      state.offset = 0;
      state.partial = "";
    }
    if (size <= state.offset) return;

    const length = size - state.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, state.offset);
    } finally {
      fs.closeSync(fd);
    }
    state.offset = size;

    let text = state.partial + buffer.toString("utf8");
    if (dropFirstLine) {
      const nl = text.indexOf("\n");
      if (nl === -1) {
        state.partial = ""; // one giant torn line — wait for more
        return;
      }
      text = text.slice(nl + 1);
    }
    const lines = text.split("\n");
    state.partial = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          timestamp?: string;
          uuid?: string;
          message?: {
            id?: string;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
            };
          };
        };
        if (entry.type !== "assistant") continue;
        const usage = entry.message?.usage;
        if (!usage) continue;
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        if (!Number.isFinite(ts)) continue;
        const id = entry.message?.id ?? entry.uuid ?? `${file}:${ts}`;
        byMsg.set(id, {
          ts,
          out: usage.output_tokens ?? 0,
          inTok: usage.input_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
        });
      } catch {
        // torn/corrupt line — lose one message, never the sample
      }
    }
  }

  private series(now: number, agents: ReadonlyArray<{ id: string }>): TokenSeries {
    const bucketCount = Math.floor(TOKEN_WINDOW_MS / TOKEN_BUCKET_MS);
    const lastBucket = Math.floor(now / TOKEN_BUCKET_MS) * TOKEN_BUCKET_MS;
    const firstBucket = lastBucket - (bucketCount - 1) * TOKEN_BUCKET_MS;
    const perAgent: Record<string, TokenBucket[]> = {};
    const totals24h: Record<string, TokenTotals> = {};
    for (const agent of agents) {
      const byMsg = this.messages.get(agent.id);
      const buckets: TokenBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
        t: firstBucket + i * TOKEN_BUCKET_MS,
        out: 0,
        in: 0,
        cacheRead: 0,
      }));
      const totals: TokenTotals = { out: 0, in: 0, cacheRead: 0 };
      if (byMsg) {
        for (const m of byMsg.values()) {
          const idx = Math.floor((m.ts - firstBucket) / TOKEN_BUCKET_MS);
          if (idx < 0 || idx >= bucketCount) continue;
          const b = buckets[idx]!;
          b.out += m.out;
          b.in += m.inTok;
          b.cacheRead += m.cacheRead;
          totals.out += m.out;
          totals.in += m.inTok;
          totals.cacheRead += m.cacheRead;
        }
      }
      perAgent[agent.id] = buckets;
      totals24h[agent.id] = totals;
    }
    return { bucketMs: TOKEN_BUCKET_MS, windowMs: TOKEN_WINDOW_MS, perAgent, totals24h };
  }
}
