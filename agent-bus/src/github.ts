import { execFileSync } from "node:child_process";
import { ticketFromBranch } from "./git.js";
import type { Store } from "./store.js";

interface RawPr {
  number: number;
  title: string;
  author: { login: string } | null;
  headRefName: string;
  updatedAt: string;
  url: string;
  files?: Array<{ path: string }>;
}

export interface PollResult {
  ok: boolean;
  error?: string;
  login?: string;
  repo?: string;
  scanned: number;
  fromOthers: number;
  new: number;
  updated: number;
}

function gh(args: string[], cwd: string): string {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

const PR_FIELDS = "number,title,author,headRefName,updatedAt,url,files";

/**
 * Poll GitHub for what OTHER engineers are doing — open + recently-merged PRs on
 * this repo, excluding your own — and record them for the dashboard team lane and
 * per-worktree relevance matching. Runs via `agent-bus gh-poll` (the foreman).
 * Best-effort: a missing/unauthenticated `gh` returns ok:false, never throws.
 */
export function pollGithub(
  store: Store,
  opts: { cwd: string; now?: number; limit?: number },
): PollResult {
  const now = opts.now ?? Date.now();
  const limit = String(opts.limit ?? 50);
  const result: PollResult = { ok: false, scanned: 0, fromOthers: 0, new: 0, updated: 0 };

  let login: string;
  let repo: string;
  try {
    login = gh(["api", "user", "--jq", ".login"], opts.cwd).trim();
    repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], opts.cwd).trim();
  } catch (err) {
    result.error = `gh unavailable: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    return result;
  }
  result.login = login;
  result.repo = repo;

  let open: RawPr[] = [];
  let merged: RawPr[] = [];
  try {
    open = JSON.parse(gh(["pr", "list", "--state", "open", "--json", PR_FIELDS, "--limit", limit], opts.cwd));
    merged = JSON.parse(
      gh(["pr", "list", "--state", "merged", "--json", PR_FIELDS, "--limit", "20"], opts.cwd),
    );
  } catch (err) {
    result.error = `pr list failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    return result;
  }

  const rows: Array<{ pr: RawPr; state: string }> = [
    ...open.map((pr) => ({ pr, state: "open" })),
    ...merged.map((pr) => ({ pr, state: "merged" })),
  ];
  result.scanned = rows.length;

  for (const { pr, state } of rows) {
    const author = pr.author?.login ?? "unknown";
    if (author === login) continue; // your own PRs are already covered by the worktree journal
    result.fromOthers++;
    const res = store.upsertGithubPr({
      number: pr.number,
      title: pr.title,
      author,
      branch: pr.headRefName ?? null,
      url: pr.url,
      state,
      ticket: ticketFromBranch(`${pr.title} ${pr.headRefName ?? ""}`),
      files: (pr.files ?? []).map((f) => f.path),
      updatedAt: Date.parse(pr.updatedAt) || now,
      now,
    });
    if (res.isNew) result.new++;
    else if (res.changed) result.updated++;
  }

  result.ok = true;
  return result;
}
