import * as fs from "node:fs";
import { notifyPath } from "./paths.js";

/**
 * Append a nudge line to each recipient's `<agent>.notify` file.
 *
 * MCP cannot wake an idle interactive Claude Code — the model must choose to
 * call `hands_receive`. A pane can `tail -f ~/.claude/coordination/<me>.notify`
 * (e.g. via a Monitor) so a new line prompts it to check its inbox. This is a
 * best-effort side channel; delivery correctness lives entirely in the DB.
 *
 * A write failure (bad `coordinationDir`, permissions, disk full, …) must
 * never throw — the DB row is what matters, and a caller retry on a thrown
 * error here would risk a duplicate send. But it also must not be swallowed
 * silently (hands#173): the caller gets back exactly which recipients were
 * actually notified vs which write attempts failed, so `hands_send` can
 * report a failure as a failure instead of indistinguishable success.
 */
export function notify(
  recipients: readonly string[],
  meta: { from: string; subject?: string | null; now?: number },
  env: NodeJS.ProcessEnv = process.env,
): { notified: string[]; failed: string[] } {
  const iso = new Date(meta.now ?? Date.now()).toISOString();
  const subject = (meta.subject ?? "").replace(/[\t\n\r]/g, " ");
  const line = `${iso}\t${meta.from}\t${subject}\n`;
  const notified: string[] = [];
  const failed: string[] = [];
  for (const recipient of recipients) {
    try {
      fs.appendFileSync(notifyPath(recipient, env), line, { mode: 0o600 });
      // appendFileSync's mode only applies on create; enforce on existing files.
      fs.chmodSync(notifyPath(recipient, env), 0o600);
      notified.push(recipient);
    } catch {
      failed.push(recipient);
    }
  }
  return { notified, failed };
}
