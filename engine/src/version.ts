import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which build is actually running, and where it came from.
 *
 * This exists because "the command doesn't exist" turned out three separate
 * times in one day to mean "you're running a different build than the one you
 * edited": a stale plugin cache on PATH while the working tree had the
 * feature, MCP servers holding a week-old bundle, and a freshly rebuilt bundle
 * nobody was executing. None of those announce themselves — every symptom
 * looks like a bug in the feature instead.
 *
 * Once there are two ways to install (plugin, and the standalone installer),
 * the question stops being cosmetic: the two can drift, and the CLI you type
 * can be a different vintage than the MCP server your sessions are talking to.
 */

export type InstallKind = "standalone" | "plugin" | "source" | "unknown";

export interface BuildInfo {
  version: string;
  /** short commit the bundle was built from, when the stamp is present */
  commit: string | null;
  /** ISO timestamp the bundle was built, when the stamp is present */
  builtAt: string | null;
  kind: InstallKind;
  /** absolute path of the executing entry */
  entry: string;
}

export interface BuildStamp {
  version: string;
  commit: string | null;
  builtAt: string;
}

/** Written next to the bundles by `npm run bundle`. Absent when running from source. */
export const STAMP_BASENAME = "BUILD.json";

export function classifyInstall(entry: string, home: string = os.homedir()): InstallKind {
  if (!entry) return "unknown";
  // Match the `.hands/lib` segment rather than only `$HOME/.hands/lib`, so an
  // install to a custom HANDS_PREFIX (or a mirror layout) still reads as
  // standalone instead of falling through to "unknown".
  if (/[/\\]\.hands[/\\]lib[/\\]/.test(entry) || entry.startsWith(path.join(home, ".hands", "lib"))) {
    return "standalone";
  }
  if (/[/\\]plugins[/\\]cache[/\\]/.test(entry)) return "plugin";
  if (/\.tsx?$/.test(entry) || /[/\\]engine[/\\]src[/\\]/.test(entry)) return "source";
  return "unknown";
}

function readStamp(dir: string): BuildStamp | null {
  try {
    const raw = fs.readFileSync(path.join(dir, STAMP_BASENAME), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.version !== "string" || typeof parsed.builtAt !== "string") return null;
    return {
      version: parsed.version,
      commit: typeof parsed.commit === "string" ? parsed.commit : null,
      builtAt: parsed.builtAt,
    };
  } catch {
    return null;
  }
}

/** Best-effort HEAD, for source runs where there's no stamp but there IS a repo. */
function gitShort(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

export function buildInfo(opts?: { entry?: string; home?: string; cwd?: string }): BuildInfo {
  const entry = opts?.entry ?? process.argv[1] ?? fileURLToPath(import.meta.url);
  const kind = classifyInstall(entry, opts?.home ?? os.homedir());
  const stamp = readStamp(path.dirname(entry));
  if (stamp) {
    return { version: stamp.version, commit: stamp.commit, builtAt: stamp.builtAt, kind, entry };
  }
  // No stamp — running from source, or a bundle built before stamps existed.
  return {
    version: "dev",
    commit: gitShort(opts?.cwd ?? process.cwd()),
    builtAt: null,
    kind,
    entry,
  };
}

/**
 * The OTHER install, if there is one. Having both a standalone and a plugin
 * copy is fine; having them at different vintages is what bites, because the
 * CLI you type and the MCP server your sessions use can then disagree.
 */
export function otherInstall(
  current: InstallKind,
  home: string = os.homedir(),
): { kind: InstallKind; stamp: BuildStamp } | null {
  if (current !== "standalone") {
    const stamp = readStamp(path.join(home, ".hands", "lib"));
    if (stamp) return { kind: "standalone", stamp };
  }
  if (current !== "plugin") {
    const cacheRoot = path.join(home, ".claude", "plugins", "cache", "hands", "hands");
    try {
      for (const dir of fs.readdirSync(cacheRoot)) {
        const stamp = readStamp(path.join(cacheRoot, dir, "dist"));
        if (stamp) return { kind: "plugin", stamp };
      }
    } catch {
      // no plugin install — fine
    }
  }
  return null;
}

export function describe(info: BuildInfo): string {
  const bits = [info.version];
  if (info.commit) bits.push(`(${info.commit})`);
  bits.push(`· ${info.kind}`);
  if (info.builtAt) bits.push(`· built ${info.builtAt}`);
  return bits.join(" ");
}
