import { execFileSync } from "node:child_process";

/** Run a git command in `cwd`, returning trimmed stdout or null on any failure. */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

export function currentBranch(cwd: string): string | null {
  const b = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return b && b !== "HEAD" ? b : (b ?? null);
}

export function headSha(cwd: string): string | null {
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Repo-relative paths with pending or recent changes (staged, unstaged, untracked). */
export function changedFiles(cwd: string): string[] {
  const out = git(cwd, ["status", "--porcelain"]);
  if (!out) return [];
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let p = line.slice(3).trim();
    // Renames: "old -> new" — keep the new path.
    const arrow = p.indexOf(" -> ");
    if (arrow !== -1) p = p.slice(arrow + 4).trim();
    // Strip surrounding quotes git adds for paths with odd chars.
    p = p.replace(/^"(.*)"$/, "$1");
    if (p) files.push(p);
  }
  return files;
}

export interface Commit {
  sha: string;
  subject: string;
}

const UNIT = "";

/**
 * Commits newer than `sinceSha` on HEAD.
 * - `sinceSha` null → just HEAD (establish a baseline; never backfill all history).
 * - range invalid (rebase / branch switch) → fall back to HEAD if it moved.
 */
export function newCommits(cwd: string, sinceSha: string | null): Commit[] {
  const head = headSha(cwd);
  if (!head) return [];
  if (!sinceSha) {
    const subj = git(cwd, ["log", "-1", `--format=%s`]) ?? "";
    return [{ sha: head, subject: subj }];
  }
  if (sinceSha === head) return [];
  const out = git(cwd, ["log", `--format=%H${UNIT}%s`, `${sinceSha}..HEAD`]);
  if (out === null) {
    // range failed — sinceSha is not an ancestor; report just the new HEAD
    const subj = git(cwd, ["log", "-1", `--format=%s`]) ?? "";
    return [{ sha: head, subject: subj }];
  }
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split(UNIT);
      return { sha: sha ?? "", subject: subject ?? "" };
    });
}

/** Extract a ticket ref (ENG-1389 / INN-234) from a branch name, uppercased. */
export function ticketFromBranch(branch: string | null): string | null {
  if (!branch) return null;
  const m = branch.match(/([A-Za-z]{2,})-(\d+)/);
  return m ? `${m[1]!.toUpperCase()}-${m[2]}` : null;
}
