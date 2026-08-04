import * as fs from "node:fs";
import * as path from "node:path";
import { coordinationDir } from "./paths.js";

/**
 * The expo's held priorities — a plain, human-editable markdown list you can
 * change any time. Ranked top-to-bottom. If it's missing/empty the expo asks
 * you for it; the confirmation timestamp lets it occasionally re-check staleness.
 */
export function prioritiesPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(coordinationDir(env), "priorities.md");
}

export interface Priorities {
  items: string[];
  raw: string;
  exists: boolean;
}

function stripMarker(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "") // list bullets / "1." / "1)"
    .trim();
}

export function readPriorities(env: NodeJS.ProcessEnv = process.env): Priorities {
  const file = prioritiesPath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { items: [], raw: "", exists: false };
  }
  const items = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#")) // skip blanks + markdown headers
    .map(stripMarker)
    .filter(Boolean);
  return { items, raw, exists: true };
}

export function writePriorities(items: string[], env: NodeJS.ProcessEnv = process.env): void {
  const dir = coordinationDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = `# Today's priorities (ranked — the expo adjudicates against these)\n\n${items
    .map((it, i) => `${i + 1}. ${it}`)
    .join("\n")}\n`;
  const file = prioritiesPath(env);
  fs.writeFileSync(file, body, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
}
