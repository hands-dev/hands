import { createHash } from "node:crypto";
import { isExpo } from "./identity.js";
import * as path from "node:path";
import { type JournalRow, type Peer, Store } from "./store.js";

/** Past this much silence (but still online), a peer reads as "idle" not "active". */
export const IDLE_THRESHOLD_MS = 3 * 60_000;

/**
 * Cheap fingerprint of the team state: peer ids + presence band + branch, plus
 * active-task assignments. The expo gates its expensive utilization re-map
 * on this changing — same hash as last pass means nothing moved, skip the
 * re-pull/re-map.
 */
export function computeStateHash(store: Store, now: number = Date.now()): string {
  const peers = store.listPeers(now).map((p) => {
    const activeAge = p.last_active ? now - p.last_active : null;
    const state = !p.online
      ? "offline"
      : activeAge !== null && activeAge <= IDLE_THRESHOLD_MS
        ? "active"
        : "idle";
    return `${p.id}|${state}|${p.branch ?? ""}|${p.focus ?? ""}`;
  });
  const tasks = store
    .listTasks({ active: true })
    .map((t) => `${t.id}|${t.assignee ?? ""}|${t.state}`)
    .sort();
  return createHash("sha1").update([...peers, ...tasks].join("\n")).digest("hex").slice(0, 12);
}

function fmtAge(ms: number): string {
  if (ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return hr < 24 ? `${hr}h` : `${Math.floor(hr / 24)}d`;
}

function parseFiles(activity: string | null): { files: string[]; ticket: string | null } {
  if (!activity) return { files: [], ticket: null };
  try {
    const a = JSON.parse(activity) as { files?: string[]; ticket?: string | null };
    return { files: a.files ?? [], ticket: a.ticket ?? null };
  } catch {
    return { files: [], ticket: null };
  }
}

const VERB: Record<string, string> = { commit: "committed", memory: "learned", note: "noted" };

export interface BoardResult {
  /** injectable text — empty string means "nothing new, stay quiet" */
  text: string;
  journalCount: number;
  collisions: number;
}

/**
 * Build the compact board digest for a given agent: what's changed on the bus
 * since it last looked. Quiet by design — returns "" unless there are new
 * journal entries or a collision, so injecting it every prompt stays cheap.
 */
export function buildBoard(
  store: Store,
  opts: { agentId: string; since?: number; now?: number; advance?: boolean },
): BoardResult {
  const now = opts.now ?? Date.now();
  const wmKey = "board_since";
  const since =
    opts.since ??
    (() => {
      const wm = store.getWatermark(opts.agentId, wmKey);
      return wm ? Number(wm) : now; // first run: baseline to now (quiet)
    })();

  const peers = store.listPeers(now);
  const others = peers.filter((p) => p.id !== opts.agentId);
  const mine = parseFiles(peers.find((p) => p.id === opts.agentId)?.activity ?? null);

  // Deltas: journal entries not authored by me.
  const journal = store
    .journalSince(since)
    .filter((j: JournalRow) => j.agent_id !== opts.agentId);

  // Collisions: another ONLINE peer touching one of my files, or on my ticket.
  const collisionLines: string[] = [];
  const myFiles = new Set(mine.files);
  for (const p of others) {
    if (!p.online) continue;
    const a = parseFiles(p.activity);
    const sharedFile = a.files.find((f) => myFiles.has(f));
    if (sharedFile) {
      collisionLines.push(`⚠ ${p.id} also touching ${path.basename(sharedFile)}`);
    } else if (mine.ticket && a.ticket === mine.ticket) {
      collisionLines.push(`⚠ ${p.id} also on ${mine.ticket}`);
    }
  }

  // Direct messages addressed to me — shown for AWARENESS (by the board time
  // window), which is independent of the receive cursor. A worker draining its
  // inbox via agent_bus_receive is what *handles* them; showing never consumes.
  const MAX_MSGS = 8;
  const inbox = store.messagesForSince(opts.agentId, since);

  // Answers to my escalated questions (passive unblock) + expo's new inbox.
  const answered = store.answeredForAsker(opts.agentId, since);
  const openForExpo = isExpo(opts.agentId)
    ? store.listQuestions({ state: "open" }).filter((q) => q.created_at > since)
    : [];

  // External (other engineers') PRs — the expo gets a team overview; each
  // station gets only PRs that touch its files or its ticket. New since `since`.
  const MAX_GH = 5;
  const ghLines: string[] = [];
  for (const pr of store.listGithubPrs({ state: "open" })) {
    if (pr.updated_at <= since || ghLines.length >= MAX_GH) continue;
    if (isExpo(opts.agentId)) {
      ghLines.push(`🔗 ${pr.author}: ${pr.title} (#${pr.number})`);
      continue;
    }
    let files: string[] = [];
    try {
      files = pr.files_json ? (JSON.parse(pr.files_json) as string[]) : [];
    } catch {
      files = [];
    }
    const fileHit = files.find((f) => myFiles.has(f));
    if (fileHit) {
      ghLines.push(
        `🔗 PR #${pr.number} by ${pr.author} touches ${path.basename(fileHit)} (yours): ${pr.title}`,
      );
    } else if (mine.ticket && pr.ticket === mine.ticket) {
      ghLines.push(`🔗 PR #${pr.number} by ${pr.author} on ${pr.ticket}: ${pr.title}`);
    }
  }

  // Delegation lifecycle: tasks freshly assigned to me (I'm a worker) + tasks
  // returned to me (I'm the foreman/creator).
  const assignedToMe = store.tasksAssignedSince(opts.agentId, since);
  const returnedToMe = store.tasksReturnedForCreator(opts.agentId, since);

  if (opts.advance) store.setWatermark(opts.agentId, wmKey, String(now));

  // Quiet unless there's a real delta.
  if (
    journal.length === 0 &&
    collisionLines.length === 0 &&
    answered.length === 0 &&
    openForExpo.length === 0 &&
    inbox.length === 0 &&
    ghLines.length === 0 &&
    assignedToMe.length === 0 &&
    returnedToMe.length === 0
  ) {
    return { text: "", journalCount: 0, collisions: 0 };
  }

  const lines: string[] = ["[agent-bus] update:"];
  const shownMsgs = inbox.slice(-MAX_MSGS);
  for (const msg of shownMsgs) {
    const to = msg.to_id === null ? "all" : "you";
    const subject = msg.subject ? `${msg.subject} — ` : "";
    lines.push(`  ✉ ${msg.from_id} → ${to}: ${subject}${msg.body}`);
  }
  if (inbox.length > MAX_MSGS) {
    lines.push(`  ✉ (+${inbox.length - MAX_MSGS} earlier — agent_bus_history)`);
  }
  for (const line of ghLines) lines.push(`  ${line}`);
  for (const q of answered) {
    lines.push(`  ✔ expo answered "${q.question}" → ${q.answer}`);
  }
  for (const q of openForExpo) {
    lines.push(`  ? ${q.asker} asks: "${q.question}" — adjudicate or escalate`);
  }
  for (const t of assignedToMe) {
    lines.push(`  📋 ${t.created_by} delegated: "${t.title}" — start with agent_bus_task_update`);
  }
  for (const t of returnedToMe) {
    lines.push(`  📋 ${t.assignee ?? ""} returned: "${t.title}" — review it`);
  }
  if (journal.length > 0) {
    const items = journal
      .slice(-6)
      .map((j) => {
        const verb = VERB[j.kind] ?? j.kind;
        const who = j.kind === "memory" ? "memory" : j.agent_id;
        return `${who} ${verb} "${j.text}" (${fmtAge(now - j.created_at)})`;
      })
      .join("; ");
    lines.push(`  new: ${items}`);
  }
  for (const c of collisionLines) lines.push(`  ${c}`);

  const peersLine = others
    .map((p) => peerLabel(p, now))
    .join(" · ");
  if (peersLine) lines.push(`  peers: ${peersLine}`);

  return { text: lines.join("\n"), journalCount: journal.length, collisions: collisionLines.length };
}

function peerLabel(p: Peer, now: number): string {
  const activeAge = p.last_active ? now - p.last_active : Number.POSITIVE_INFINITY;
  const where = p.branch ?? "?";
  const who = p.focus ? `${p.id}·${p.focus}` : p.id;
  if (!p.online) return `${who}·offline`;
  if (activeAge > IDLE_THRESHOLD_MS) return `${who}·idle ${fmtAge(activeAge)}·${where}`;
  return `${who}·${where}`;
}
