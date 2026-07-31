import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface MemoryEntry {
  /** filename without extension */
  name: string;
  /** short content hash — changes when the memory is edited */
  hash: string;
  /** the frontmatter `description:` line, for the journal text */
  description: string;
}

/**
 * Directory holding the ampersand memory store. Overridable via
 * `AGENT_BUS_MEMORY_DIR`. All ampersand worktrees share one memory dir, so
 * memory journaling is deduped globally (watermark agent '*').
 */
export function memoryDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_BUS_MEMORY_DIR?.trim();
  if (override) return override;
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    "-Users-michaelphillips-Development-ampersand",
    "memory",
  );
}

function descriptionOf(body: string): string {
  const m = body.match(/^description:\s*(.+)$/m);
  return m ? m[1]!.trim() : "";
}

/** Scan the memory dir for entries (excludes the MEMORY.md index). Best-effort. */
export function scanMemory(env: NodeJS.ProcessEnv = process.env): MemoryEntry[] {
  const dir = memoryDir(env);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const entries: MemoryEntry[] = [];
  for (const file of names) {
    if (!file.endsWith(".md") || file === "MEMORY.md") continue;
    try {
      const body = fs.readFileSync(path.join(dir, file), "utf8");
      entries.push({
        name: file.replace(/\.md$/, ""),
        hash: createHash("sha1").update(body).digest("hex").slice(0, 12),
        description: descriptionOf(body),
      });
    } catch {
      // unreadable file — skip
    }
  }
  return entries;
}
