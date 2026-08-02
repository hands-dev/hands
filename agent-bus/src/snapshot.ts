import * as path from "node:path";
import { IDLE_THRESHOLD_MS } from "./board.js";
import { readPriorities } from "./priorities.js";
import { Store } from "./store.js";

export type AgentState = "active" | "idle" | "offline";

export interface SnapshotAgent {
  id: string;
  state: AgentState;
  online: boolean;
  branch: string | null;
  ticket: string | null;
  cwd: string;
  pid: number;
  files: string[];
  lastActive: number | null;
  lastSeen: number;
}

export interface SnapshotMessage {
  id: number;
  from: string;
  to: string; // "*" for broadcast
  subject: string | null;
  body: string;
  at: number;
}

export interface SnapshotJournal {
  id: number;
  by: string;
  kind: string;
  text: string;
  ref: string | null;
  at: number;
}

export interface Collision {
  a: string;
  b: string;
  kind: "file" | "ticket";
  detail: string;
}

export interface SnapshotQuestion {
  id: number;
  asker: string;
  question: string;
  state: string;
  answer: string | null;
  resolvedBy: string | null;
  recommendation: string | null;
  priority: string | null;
  /** foreman hindsight self-audit: "validated" | "contradicted" | null (unassessed) */
  outcome: string | null;
  outcomeNote: string | null;
  outcomeAt: number | null;
  at: number;
}

export interface SnapshotPr {
  number: number;
  title: string;
  author: string;
  branch: string | null;
  url: string;
  state: string;
  ticket: string | null;
  files: number;
  /** worktree ids this PR overlaps (shared file or same ticket) */
  relevantTo: string[];
  at: number;
}

export interface SnapshotTask {
  id: number;
  title: string;
  from: string;
  assignee: string;
  state: string;
  priority: string | null;
  result: string | null;
  at: number;
}

export interface SnapshotTodo {
  id: number;
  title: string;
  detail: string | null;
  state: string;
  source: string;
  origin: string | null;
  priority: string | null;
  doneSignal: string | null;
  at: number;
}

export interface Snapshot {
  now: number;
  agents: SnapshotAgent[];
  journal: SnapshotJournal[];
  messages: SnapshotMessage[];
  collisions: Collision[];
  priorities: string[];
  questions: SnapshotQuestion[];
  github: SnapshotPr[];
  tasks: SnapshotTask[];
  todos: SnapshotTodo[];
  counts: {
    agents: number;
    online: number;
    messages: number;
    journal: number;
    openQuestions: number;
    needsHuman: number;
    githubPrs: number;
    activeTasks: number;
    returnedTasks: number;
    openTodos: number;
  };
}

function activity(raw: string | null): { files: string[]; ticket: string | null } {
  if (!raw) return { files: [], ticket: null };
  try {
    const a = JSON.parse(raw) as { files?: string[]; ticket?: string | null };
    return { files: a.files ?? [], ticket: a.ticket ?? null };
  } catch {
    return { files: [], ticket: null };
  }
}

/** Read-only view of the whole bus for the dashboard. */
export function buildSnapshot(
  store: Store,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Snapshot {
  const peers = store.listPeers(now);
  const agents: SnapshotAgent[] = peers.map((p) => {
    const { files, ticket } = activity(p.activity);
    const activeAge = p.last_active ? now - p.last_active : Number.POSITIVE_INFINITY;
    const state: AgentState = !p.online ? "offline" : activeAge <= IDLE_THRESHOLD_MS ? "active" : "idle";
    return {
      id: p.id,
      state,
      online: p.online,
      branch: p.branch,
      ticket,
      cwd: p.cwd,
      pid: p.pid,
      files,
      lastActive: p.last_active,
      lastSeen: p.last_seen_at,
    };
  });

  // All-pairs collisions among ONLINE agents (shared file, or same ticket).
  const collisions: Collision[] = [];
  const online = agents.filter((a) => a.online);
  for (let i = 0; i < online.length; i++) {
    for (let j = i + 1; j < online.length; j++) {
      const a = online[i]!;
      const b = online[j]!;
      const shared = a.files.find((f) => b.files.includes(f));
      if (shared) {
        collisions.push({ a: a.id, b: b.id, kind: "file", detail: path.basename(shared) });
      } else if (a.ticket && a.ticket === b.ticket) {
        collisions.push({ a: a.id, b: b.id, kind: "ticket", detail: a.ticket });
      }
    }
  }

  const journal: SnapshotJournal[] = store
    .journalSince(0, 40)
    .reverse()
    .map((j) => ({ id: j.id, by: j.agent_id, kind: j.kind, text: j.text, ref: j.ref, at: j.created_at }));

  const messages: SnapshotMessage[] = store
    .history({ limit: 40 })
    .reverse()
    .map((m) => ({
      id: m.id,
      from: m.from_id,
      to: m.to_id ?? "*",
      subject: m.subject,
      body: m.body,
      at: m.created_at,
    }));

  const priorities = readPriorities(env).items;
  const questions: SnapshotQuestion[] = store.listQuestions({ limit: 30 }).map((q) => ({
    id: q.id,
    asker: q.asker,
    question: q.question,
    state: q.state,
    answer: q.answer,
    resolvedBy: q.resolved_by,
    recommendation: q.recommendation,
    priority: q.priority_ref,
    outcome: q.outcome,
    outcomeNote: q.outcome_note,
    outcomeAt: q.outcome_at,
    at: q.created_at,
  }));

  const github: SnapshotPr[] = store.listGithubPrs({ limit: 40 }).map((pr) => {
    let files: string[] = [];
    try {
      files = pr.files_json ? (JSON.parse(pr.files_json) as string[]) : [];
    } catch {
      files = [];
    }
    const fileSet = new Set(files);
    const relevantTo: string[] = [];
    for (const a of agents) {
      if (!a.online) continue;
      if (a.files.some((f) => fileSet.has(f)) || (a.ticket && a.ticket === pr.ticket)) {
        relevantTo.push(a.id);
      }
    }
    return {
      number: pr.number,
      title: pr.title,
      author: pr.author,
      branch: pr.branch,
      url: pr.url,
      state: pr.state,
      ticket: pr.ticket,
      files: files.length,
      relevantTo,
      at: pr.updated_at,
    };
  });

  const tasks: SnapshotTask[] = store.listTasks({ limit: 40 }).map((t) => ({
    id: t.id,
    title: t.title,
    from: t.created_by,
    assignee: t.assignee ?? "queue",
    state: t.state,
    priority: t.priority_ref,
    result: t.result,
    at: t.updated_at,
  }));
  const activeStates = new Set(["open", "assigned", "in_progress", "returned"]);

  const todos: SnapshotTodo[] = store.listTodos({ limit: 40 }).map((t) => ({
    id: t.id,
    title: t.title,
    detail: t.detail,
    state: t.state,
    source: t.source,
    origin: t.origin_ref,
    priority: t.priority_ref,
    doneSignal: t.done_signal,
    at: t.updated_at,
  }));

  return {
    now,
    agents,
    journal,
    messages,
    collisions,
    priorities,
    questions,
    github,
    tasks,
    todos,
    counts: {
      agents: agents.length,
      online: agents.filter((a) => a.online).length,
      messages: messages.length,
      journal: journal.length,
      openQuestions: questions.filter((q) => q.state === "open").length,
      needsHuman: questions.filter((q) => q.state === "needs_human").length,
      githubPrs: github.length,
      activeTasks: tasks.filter((t) => activeStates.has(t.state)).length,
      returnedTasks: tasks.filter((t) => t.state === "returned").length,
      openTodos: todos.filter((t) => t.state === "open").length,
    },
  };
}
