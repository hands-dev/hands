import { changedFiles, currentBranch, headSha, newCommits, ticketFromBranch } from "./git.js";
import { scanMemory } from "./memory.js";
import type { Store } from "./store.js";

const MAX_FILES = 50;

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
  opts: { agentId: string; cwd: string; pid?: number; env?: NodeJS.ProcessEnv; now?: number },
): PublishResult {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const branch = currentBranch(opts.cwd);
  const files = changedFiles(opts.cwd).slice(0, MAX_FILES);
  const ticket = ticketFromBranch(branch);

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
