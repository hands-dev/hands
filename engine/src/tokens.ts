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

export interface SubagentCall {
  /** "agentType: description" from the sibling meta.json (or the file stem) */
  label: string;
  out: number;
  /** last message timestamp in the call */
  ts: number;
}

export interface TokenSeries {
  bucketMs: number;
  windowMs: number;
  /** dense buckets (zeros filled), oldest → newest, per agent id */
  perAgent: Record<string, TokenBucket[]>;
  totals24h: Record<string, TokenTotals>;
  /** recent sub-agent calls per pane (each subagents/*.jsonl file = one call) */
  subagents: Record<string, SubagentCall[]>;
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
  /** set when the message came from a subagents/*.jsonl file (one call per file) */
  callFile?: string;
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
      // Sub-agent transcripts live per SESSION under <session>/subagents/ —
      // one file per Agent-tool call. Their spend is real pane spend (fold
      // into the same buckets), tagged per file for the per-call view.
      let sessionDirs: string[] = [];
      try {
        sessionDirs = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(dir, e.name, "subagents"));
      } catch {
        sessionDirs = [];
      }
      for (const subDir of sessionDirs) {
        let subNames: string[] = [];
        try {
          subNames = fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
        } catch {
          continue;
        }
        for (const name of subNames) {
          const file = path.join(subDir, name);
          try {
            const stat = fs.statSync(file);
            if (now - stat.mtimeMs > TOKEN_WINDOW_MS + MTIME_SLACK_MS) continue;
            this.readAppended(file, stat.size, byMsg, file);
          } catch {
            // unreadable — skip
          }
        }
      }
      for (const [id, m] of byMsg) {
        if (now - m.ts > TOKEN_WINDOW_MS + TOKEN_BUCKET_MS) byMsg.delete(id);
      }
    }
    return this.series(now, agents);
  }

  private readAppended(
    file: string,
    size: number,
    byMsg: Map<string, MsgUsage>,
    callFile?: string,
  ): void {
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
          ...(callFile ? { callFile } : {}),
        });
      } catch {
        // torn/corrupt line — lose one message, never the sample
      }
    }
  }

  /**
   * A pane's summed usage over [from, to] — the per-ticket cost primitive
   * (main-session AND sub-agent messages: work spawned for a ticket is that
   * ticket's spend). An approximation by construction: whatever else the pane
   * did in the interval rides along.
   */
  usageBetween(agentId: string, from: number, to: number): TokenTotals {
    const totals: TokenTotals = { out: 0, in: 0, cacheRead: 0 };
    const byMsg = this.messages.get(agentId);
    if (!byMsg) return totals;
    for (const m of byMsg.values()) {
      if (m.ts < from || m.ts > to) continue;
      totals.out += m.out;
      totals.in += m.inTok;
      totals.cacheRead += m.cacheRead;
    }
    return totals;
  }

  private readonly metaLabels = new Map<string, string>();

  private callLabel(callFile: string): string {
    const cached = this.metaLabels.get(callFile);
    if (cached) return cached;
    let label = path.basename(callFile, ".jsonl");
    try {
      const meta = JSON.parse(
        fs.readFileSync(callFile.replace(/\.jsonl$/, ".meta.json"), "utf8"),
      ) as { agentType?: string; description?: string };
      if (meta.description) label = meta.agentType ? `${meta.agentType}: ${meta.description}` : meta.description;
      else if (meta.agentType) label = meta.agentType;
    } catch {
      // no meta — the file stem will do
    }
    this.metaLabels.set(callFile, label);
    return label;
  }

  private series(now: number, agents: ReadonlyArray<{ id: string }>): TokenSeries {
    const bucketCount = Math.floor(TOKEN_WINDOW_MS / TOKEN_BUCKET_MS);
    const lastBucket = Math.floor(now / TOKEN_BUCKET_MS) * TOKEN_BUCKET_MS;
    const firstBucket = lastBucket - (bucketCount - 1) * TOKEN_BUCKET_MS;
    const perAgent: Record<string, TokenBucket[]> = {};
    const totals24h: Record<string, TokenTotals> = {};
    const subagents: Record<string, SubagentCall[]> = {};
    for (const agent of agents) {
      const byMsg = this.messages.get(agent.id);
      const buckets: TokenBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
        t: firstBucket + i * TOKEN_BUCKET_MS,
        out: 0,
        in: 0,
        cacheRead: 0,
      }));
      const totals: TokenTotals = { out: 0, in: 0, cacheRead: 0 };
      const byCall = new Map<string, SubagentCall>();
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
          if (m.callFile) {
            const call = byCall.get(m.callFile) ?? {
              label: this.callLabel(m.callFile),
              out: 0,
              ts: 0,
            };
            call.out += m.out;
            call.ts = Math.max(call.ts, m.ts);
            byCall.set(m.callFile, call);
          }
        }
      }
      perAgent[agent.id] = buckets;
      totals24h[agent.id] = totals;
      subagents[agent.id] = [...byCall.values()].sort((a, b) => b.ts - a.ts).slice(0, 8);
    }
    return { bucketMs: TOKEN_BUCKET_MS, windowMs: TOKEN_WINDOW_MS, perAgent, totals24h, subagents };
  }
}
