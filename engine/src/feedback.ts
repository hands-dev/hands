import { execFileSync } from "node:child_process";

/** Always hands' own repo — never wherever the session happens to be running (see plugin/skills/feedback/SKILL.md's guardrail). */
export const FEEDBACK_REPO = "hands-dev/hands";

/** The `gh` invocation seam — real by default, injectable in tests so nothing here needs a real `gh` binary or network access. */
export type GhRunner = (args: string[], cwd: string) => string;

export const runGh: GhRunner = (args, cwd) =>
  execFileSync("gh", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  });

function githubHandle(cwd: string, gh: GhRunner): string | null {
  try {
    return gh(["api", "user", "--jq", ".login"], cwd).trim() || null;
  } catch {
    return null;
  }
}

function currentRepo(cwd: string, gh: GhRunner): string | null {
  try {
    return gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd).trim() || null;
  } catch {
    return null;
  }
}

/** `filed by @<handle> from <repo> · <date>` — same shape as /hands:feedback's footer. Each field is best-effort; a missing one is dropped, never blocks filing. */
export function feedbackFooter(cwd: string, now: number = Date.now(), gh: GhRunner = runGh): string {
  const handle = githubHandle(cwd, gh);
  const repo = currentRepo(cwd, gh);
  const date = new Date(now).toISOString().slice(0, 10);
  const who = handle ? `@${handle}` : "an unknown handle";
  const where = repo ? ` from ${repo}` : "";
  return `filed by ${who}${where} · ${date}`;
}

/** `feedback: <first line, truncated>` — the same distillation the skill does when the caller doesn't supply their own title. */
export function defaultFeedbackTitle(body: string): string {
  const gist = body.trim().split("\n")[0]!.slice(0, 60);
  return `feedback: ${gist}`;
}

export interface FeedbackResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * File a GitHub issue on hands-dev/hands — the same destination, footer
 * shape, and label-fallback behavior as the /hands:feedback skill, just
 * without an interactive confirm step (the caller — the CLI's explicit
 * argument, or a submit click on the dashboard's own form — already IS the
 * confirmation; there's no third party this could come from).
 */
export function fileFeedback(opts: { body: string; title?: string; cwd?: string; gh?: GhRunner }): FeedbackResult {
  const cwd = opts.cwd ?? process.cwd();
  const gh = opts.gh ?? runGh;
  const body = opts.body.trim();
  if (!body) return { ok: false, error: "feedback body is empty" };
  const title = opts.title?.trim() || defaultFeedbackTitle(body);
  const fullBody = `${body}\n\n---\n${feedbackFooter(cwd, Date.now(), gh)}`;

  const attempt = (withLabel: boolean): string => {
    const args = ["issue", "create", "--repo", FEEDBACK_REPO, "--title", title, "--body", fullBody];
    if (withLabel) args.push("--label", "feedback");
    return gh(args, cwd).trim();
  };

  try {
    return { ok: true, url: attempt(true) };
  } catch {
    // the "feedback" label may not exist / this token may lack permission to apply it — retry once without it rather than losing the note
    try {
      return { ok: true, url: attempt(false) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
    }
  }
}
