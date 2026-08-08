import * as fs from "node:fs";
import * as path from "node:path";
import { type JournalEvent, type JournalRef, readEvents } from "./remote.js";

/**
 * Deterministic markdown digests — the journal repo's PRIMARY, human-readable
 * layer (`journal/<project>/<handle>/<date>.md` + a per-handle README index).
 *
 * Determinism is load-bearing: two machines on one handle must render
 * byte-identical output from the same event set or every sync ping-pongs
 * commits. Hence: input events are globally ts-sorted (readEvents), section
 * and agent ordering are fixed, no wall-clock leaks into the output, and
 * truncation is code-point safe. A version stamp on line 1 lets mixed-version
 * fleets coexist: never rewrite a file stamped by a NEWER renderer, and skip
 * the write entirely when bytes are unchanged.
 *
 * Content policy (deliberate): task/question/todo titles and one-line
 * truncated results — but NO message bodies. Digests are what people share
 * and screenshot; bodies stay in the NDJSON layer.
 */

export const DIGEST_VERSION = 1;
const STAMP_PREFIX = "<!-- hands digest v";
const STAMP = `${STAMP_PREFIX}${DIGEST_VERSION} -->`;
const STAMP_RE = /^<!-- hands digest v(\d+) -->/;

const RESULT_MAX = 120;

/** UTC day key for an event — must match the append-side file naming. */
export function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function hhmm(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16);
}

/** One line, ≤ RESULT_MAX code points, no newlines — safe on multi-byte text. */
function oneLine(text: unknown): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length <= RESULT_MAX ? flat : `${points.slice(0, RESULT_MAX - 1).join("")}…`;
}

/** expo first, then station-N ascending, then anything else, unattributed last. */
function agentRank(agent: string): [number, number, string] {
  if (agent === "expo") return [0, 0, agent];
  const station = agent.match(/^station-(\d+)$/);
  if (station) return [1, Number.parseInt(station[1]!, 10), agent];
  if (agent === "unattributed") return [3, 0, agent];
  return [2, 0, agent];
}

function compareAgents(a: string, b: string): number {
  const [ga, na, sa] = agentRank(a);
  const [gb, nb, sb] = agentRank(b);
  return ga - gb || na - nb || sa.localeCompare(sb);
}

function describe(event: JournalEvent): string | null {
  const d = event.data;
  const t = hhmm(event.ts);
  switch (event.type) {
    case "task.create": {
      const dish = d.dish ? ` (${oneLine(d.dish)})` : "";
      return `- ${t} ticket #${d.id}${dish} fired: **${oneLine(d.title)}**${d.assignee ? ` → ${d.assignee}` : " (unassigned)"}`;
    }
    case "task.update": {
      const result = d.result ? ` — ${oneLine(d.result)}` : "";
      const verb =
        d.state === "cancelled" ? "86'd" : d.state === "in_progress" ? "picked up" : String(d.state);
      return `- ${t} ticket #${d.id} ${verb}${result}`;
    }
    case "question.ask":
      return `- ${t} question #${d.id} asked: ${oneLine(d.question)}`;
    case "question.escalate":
      return `- ${t} question #${d.id} escalated${d.recommendation ? ` (rec: ${oneLine(d.recommendation)})` : ""}`;
    case "question.answer":
      return `- ${t} question #${d.id} answered by ${d.by}: ${oneLine(d.answer)}`;
    case "question.outcome":
      return `- ${t} question #${d.id} outcome: ${d.outcome}${d.note ? ` — ${oneLine(d.note)}` : ""}`;
    case "todo.create":
      return `- ${t} todo #${d.id} added: ${oneLine(d.title)}`;
    case "todo.update":
      return `- ${t} todo #${d.id} → ${d.state}${d.doneSignal ? ` (${oneLine(d.doneSignal)})` : ""}`;
    case "focus.set":
      return `- ${t} focus → ${oneLine(d.focus) || "(cleared)"}`;
    case "recipe.promoted":
      return `- ${t} recipe "${oneLine(d.slug)}" onto the menu${d.rank ? ` (#${d.rank})` : ""}`;
    case "recipe.demoted":
      return `- ${t} recipe "${oneLine(d.slug)}" off the menu`;
    default:
      return null; // messages/cursors are counted, not itemized; unknown types skipped
  }
}

export interface DayDigest {
  date: string;
  body: string;
  /** one-line summary for the README index */
  summary: string;
}

/**
 * Render one day's digest from the handle's FULL event stream (pre-sorted by
 * ts). Pure and deterministic — same events in, same bytes out.
 */
export function renderDigest(
  events: readonly JournalEvent[],
  opts: { project: string; handle: string; date: string },
): DayDigest {
  const day = events.filter((e) => dayOf(e.ts) === opts.date);
  // Each agent's focus label as of the END of this date, derived from events
  // only (determinism): the last focus.set at or before the date wins.
  const focusAsOf = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "focus.set" || dayOf(e.ts) > opts.date) continue;
    const station = String(e.data.station ?? "");
    const focus = e.data.focus;
    if (!station) continue;
    if (typeof focus === "string" && focus.trim()) focusAsOf.set(station, focus.trim());
    else focusAsOf.delete(station);
  }
  const byAgent = new Map<string, JournalEvent[]>();
  const notes: JournalEvent[] = [];
  let messages = 0;
  const messagesByAgent = new Map<string, number>();

  for (const event of day) {
    const agent = event.agent ?? "unattributed";
    if (event.type === "digest.note") {
      notes.push(event);
      continue;
    }
    if (event.type === "message") {
      messages++;
      messagesByAgent.set(agent, (messagesByAgent.get(agent) ?? 0) + 1);
      continue;
    }
    if (event.type === "cursor") continue; // bookkeeping — not digest-worthy
    // a focus change belongs to the station it describes, not who set it
    const owner = event.type === "focus.set" ? String(event.data.station ?? agent) : agent;
    const bucket = byAgent.get(owner);
    if (bucket) bucket.push(event);
    else byAgent.set(owner, [event]);
  }

  const lines: string[] = [STAMP, `# ${opts.date} · ${opts.handle} · ${opts.project}`, ""];

  if (notes.length > 0) {
    lines.push("## Notes");
    for (const note of notes) lines.push(`- ${hhmm(note.ts)} ${oneLine(note.data.text)}`);
    lines.push("");
  }

  const agents = [...new Set([...byAgent.keys(), ...messagesByAgent.keys()])].sort(compareAgents);
  let itemized = 0;
  for (const agent of agents) {
    const items = (byAgent.get(agent) ?? [])
      .map(describe)
      .filter((line): line is string => line !== null);
    const sent = messagesByAgent.get(agent) ?? 0;
    if (items.length === 0 && sent === 0) continue;
    const label = focusAsOf.get(agent);
    lines.push(label ? `## ${agent} · ${label}` : `## ${agent}`);
    lines.push(...items);
    if (sent > 0) lines.push(`- messages sent: ${sent}`);
    lines.push("");
    itemized += items.length;
  }

  if (agents.length === 0 && notes.length === 0) {
    lines.push("_no activity_", "");
  }

  const summary = `${itemized} item${itemized === 1 ? "" : "s"} · ${messages} message${messages === 1 ? "" : "s"}${notes.length > 0 ? ` · ${notes.length} note${notes.length === 1 ? "" : "s"}` : ""}`;
  return { date: opts.date, body: `${lines.join("\n")}\n`, summary };
}

/** Per-handle README: newest-first index of digest days. */
export function renderIndex(
  days: readonly { date: string; summary: string }[],
  opts: { project: string; handle: string },
): string {
  const lines = [STAMP, `# ${opts.handle} · ${opts.project}`, ""];
  const sorted = [...days].sort((a, b) => b.date.localeCompare(a.date));
  for (const day of sorted) {
    lines.push(`- [${day.date}](./${day.date}.md) — ${day.summary}`);
  }
  if (sorted.length === 0) lines.push("_no digests yet_");
  return `${lines.join("\n")}\n`;
}

/**
 * Write `content` unless the existing file is byte-identical or was stamped by
 * a NEWER renderer (mixed-version fleets must not rewrite-loop). Returns true
 * when the file changed.
 */
function writeIfOwn(file: string, content: string): boolean {
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    // absent — write it
  }
  if (existing !== null) {
    if (existing === content) return false;
    const stamped = existing.match(STAMP_RE);
    if (stamped && Number.parseInt(stamped[1]!, 10) > DIGEST_VERSION) return false;
  }
  fs.writeFileSync(file, content);
  return true;
}

/**
 * (Re)generate digests for the given dates (or every date seen in the event
 * stream when omitted) plus the README index. Only this journal's own
 * project/handle namespace is touched. Returns repo-relative changed paths.
 */
export function regenerateDigests(journal: JournalRef, dates?: ReadonlySet<string>): string[] {
  const events = readEvents(journal.dir, journal.project, journal.handle);
  if (events.length === 0) return [];
  const handleDir = path.join(journal.dir, "journal", journal.project, journal.handle);
  fs.mkdirSync(handleDir, { recursive: true });

  const allDates = [...new Set(events.map((e) => dayOf(e.ts)))].sort();
  const target = dates ? allDates.filter((d) => dates.has(d)) : allDates;
  const changed: string[] = [];
  const index: { date: string; summary: string }[] = [];

  for (const date of allDates) {
    const digest = renderDigest(events, { project: journal.project, handle: journal.handle, date });
    index.push({ date, summary: digest.summary });
    if (!target.includes(date)) continue;
    const file = path.join(handleDir, `${date}.md`);
    if (writeIfOwn(file, digest.body)) {
      changed.push(path.join("journal", journal.project, journal.handle, `${date}.md`));
    }
  }

  const readme = renderIndex(index, { project: journal.project, handle: journal.handle });
  if (writeIfOwn(path.join(handleDir, "README.md"), readme)) {
    changed.push(path.join("journal", journal.project, journal.handle, "README.md"));
  }
  return changed;
}
