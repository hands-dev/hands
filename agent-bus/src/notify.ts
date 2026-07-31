import * as fs from "node:fs";
import { notifyPath } from "./paths.js";

/**
 * Append a nudge line to each recipient's `<agent>.notify` file.
 *
 * MCP cannot wake an idle interactive Claude Code — the model must choose to
 * call `agent_bus_receive`. A pane can `tail -f ~/.claude/coordination/<me>.notify`
 * (e.g. via a Monitor) so a new line prompts it to check its inbox. This is a
 * best-effort side channel; delivery correctness lives entirely in the DB.
 */
export function notify(
  recipients: readonly string[],
  meta: { from: string; subject?: string | null; now?: number },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const iso = new Date(meta.now ?? Date.now()).toISOString();
  const subject = (meta.subject ?? "").replace(/[\t\n\r]/g, " ");
  const line = `${iso}\t${meta.from}\t${subject}\n`;
  for (const recipient of recipients) {
    try {
      fs.appendFileSync(notifyPath(recipient, env), line, { mode: 0o600 });
      // appendFileSync's mode only applies on create; enforce on existing files.
      fs.chmodSync(notifyPath(recipient, env), 0o600);
    } catch {
      // best-effort — a missing/locked notify file must never fail a send
    }
  }
}
