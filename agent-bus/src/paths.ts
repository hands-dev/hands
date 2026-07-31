import * as os from "node:os";
import * as path from "node:path";

/**
 * Root for all agent-bus state. Overridable via `AGENT_BUS_HOME` (tests point
 * this at a temp dir so they never touch the real `~/.claude`).
 */
export function coordinationDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_BUS_HOME?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".claude", "coordination");
}

export function dbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(coordinationDir(env), "agent-bus.db");
}

export function notifyPath(agentId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(coordinationDir(env), `${agentId}.notify`);
}
