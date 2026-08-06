import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encodeProjectDir } from "./tokens.js";

/**
 * A station's own activity, read from Claude Code's session transcripts.
 *
 * The bus only shows what a station CHOSE to say — a message, a returned
 * ticket. That's the wrong instrument for "is it actually moving?": a station
 * parked on a permission prompt, thrashing on one file, or wedged mid-tool
 * looks identical over MCP to one that is simply thinking. This reads the
 * pane's real trace instead (issue #60).
 *
 * Same source `tokens.ts` samples for token burn, and it reuses that module's
 * `encodeProjectDir` so the two can never disagree about where a pane's
 * transcripts live.
 *
 * Best-effort throughout: a missing dir, a torn line, or a transcript being
 * appended to mid-read yields less output, never an exception. This is a
 * diagnostic — it must work when things are already broken.
 */

export type ActivityKind = "text" | "tool" | "result" | "error";

export interface ActivityEvent {
  /** epoch ms; 0 when the line carried no parseable timestamp */
  at: number;
  kind: ActivityKind;
  /** short label — tool name, or the leading words of a message */
  label: string;
  /** longer body when there is one, already truncated for display */
  detail?: string;
}

export function transcriptDir(cwd: string, home: string = os.homedir()): string {
  return path.join(home, ".claude", "projects", encodeProjectDir(cwd));
}

/**
 * Newest transcript for a pane, or null. A station restarted mid-ticket has
 * several sessions in the same dir; the most recently modified is the live one.
 */
export function latestTranscript(cwd: string, home: string = os.homedir()): string | null {
  const dir = transcriptDir(cwd, home);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let newest: { file: string; mtime: number } | null = null;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const { mtimeMs } = fs.statSync(file);
      if (!newest || mtimeMs > newest.mtime) newest = { file, mtime: mtimeMs };
    } catch {
      // raced with a delete — skip it
    }
  }
  return newest?.file ?? null;
}

/**
 * The session id `claude --resume` expects for a pane's most recent
 * transcript, or null if it's never taken a turn — a resumable id is just
 * the transcript's own filename (Claude Code names each `<session-id>.jsonl`).
 */
export function latestSessionId(cwd: string, home: string = os.homedir()): string | null {
  const file = latestTranscript(cwd, home);
  return file ? path.basename(file, ".jsonl") : null;
}

function clip(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Parse one transcript line into at most one event.
 *
 * `thinking` blocks are deliberately dropped: they're the bulk of the bytes and
 * they don't answer "is it moving" — a tool call or a message does.
 */
function eventsFromLine(raw: string): ActivityEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const line = parsed as Record<string, unknown>;
  const at = Date.parse(String(line.timestamp ?? "")) || 0;
  const message = line.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];

  const events: ActivityEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      events.push({ at, kind: "text", label: clip(b.text, 100), detail: clip(b.text, 400) });
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      events.push({ at, kind: "tool", label: String(b.name), detail: clip(JSON.stringify(b.input ?? {}), 200) });
    } else if (b.type === "tool_result") {
      const failed = b.is_error === true;
      const body = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      events.push({
        at,
        kind: failed ? "error" : "result",
        label: failed ? "tool error" : "result",
        detail: clip(body, 200),
      });
    }
  }
  return events;
}

/**
 * The last `limit` activity events for a pane's cwd, oldest first.
 *
 * Reads a bounded tail of the file rather than the whole thing — transcripts
 * reach tens of MB, and a diagnostic that has to slurp 40MB to tell you a
 * station is stuck is not a diagnostic.
 */
export function recentActivity(
  cwd: string,
  opts?: { limit?: number; home?: string; tailBytes?: number },
): { file: string | null; events: ActivityEvent[] } {
  const limit = opts?.limit ?? 20;
  const file = latestTranscript(cwd, opts?.home ?? os.homedir());
  if (!file) return { file: null, events: [] };

  let text = "";
  try {
    const tailBytes = opts?.tailBytes ?? 512 * 1024;
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - tailBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, tailBytes));
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    // a mid-file start almost certainly lands inside a line — drop the fragment
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } catch {
    return { file, events: [] };
  }

  const events: ActivityEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim()) events.push(...eventsFromLine(line));
  }
  return { file, events: events.slice(-limit) };
}

/** Wall-clock ms since the pane's last recorded activity, or null if unknown. Answers "is it moving?". */
export function idleMs(cwd: string, now: number = Date.now(), home?: string): number | null {
  const { events } = recentActivity(cwd, { limit: 1, home });
  const last = events[events.length - 1];
  if (!last || !last.at) return null;
  return now - last.at;
}
