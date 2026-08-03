import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { coordinationDir, repoInfo } from "./paths.js";

/**
 * `roundhouse init` — per-repo setup, run from inside the target repo. The
 * PLUGIN now owns what the old installer hand-wired (MCP registration, hooks,
 * skills); this command handles what must stay per-repo/per-user:
 *
 *   1. scaffold <repo>/agent-bus.config.json (principal + optional journal)
 *   2. clean up an old-style (pre-plugin) install — user-scope MCP entry,
 *      settings.json hooks, copied ~/.claude/skills — so the plugin's
 *      registrations don't double-fire (two board hooks fight over the board
 *      cursor; two MCP servers register under different tool prefixes)
 *   3. offer to migrate a legacy un-scoped ~/.claude/coordination dir
 *
 * Everything is merge-not-overwrite, with a .agent-bus.bak backup next to any
 * file we modify. Safe to re-run.
 */

interface InitFlags {
  yes: boolean;
  migrate: boolean | null; // null = ask
  principal: string | null;
  journalUrl: string | null;
  handle: string | null;
}

function parseFlags(argv: string[]): InitFlags {
  const flags: InitFlags = { yes: false, migrate: null, principal: null, journalUrl: null, handle: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--migrate") flags.migrate = true;
    else if (a === "--no-migrate") flags.migrate = false;
    else if (a === "--principal") flags.principal = argv[++i] ?? null;
    else if (a.startsWith("--principal=")) flags.principal = a.slice("--principal=".length);
    else if (a === "--journal") flags.journalUrl = argv[++i] ?? null;
    else if (a.startsWith("--journal=")) flags.journalUrl = a.slice("--journal=".length);
    else if (a === "--handle") flags.handle = argv[++i] ?? null;
    else if (a.startsWith("--handle=")) flags.handle = a.slice("--handle=".length);
  }
  return flags;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function readJsonFile(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJsonWithBackup(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.agent-bus.bak`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Strip hook entries whose command matches `signature`; prune empty shells. */
function removeHooks(settings: Record<string, unknown>, signature: RegExp): number {
  const hooks = settings.hooks as
    | Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    | undefined;
  if (!hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const before = entry.hooks?.length ?? 0;
      entry.hooks = entry.hooks?.filter((h) => !(h.command && signature.test(h.command)));
      removed += before - (entry.hooks?.length ?? 0);
    }
    hooks[event] = entries.filter((e) => (e.hooks?.length ?? 0) > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  return removed;
}

/** Legacy pre-slug files sitting directly in ~/.claude/coordination. */
function legacyCoordinationFiles(dir: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter(
    (n) =>
      n === "agent-bus.db" ||
      n.startsWith("agent-bus.db-") ||
      n.endsWith(".notify") ||
      n === "priorities.md" ||
      n.startsWith("foreman.last-") ||
      n.endsWith(".last-compact"),
  );
}

export async function runInit(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const home = os.homedir();
  const interactive = process.stdin.isTTY === true && !flags.yes;
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const ask = async (q: string, fallback: string): Promise<string> => {
    if (!rl) return fallback;
    const answer = (await rl.question(`${q} [${fallback}] `)).trim();
    return answer || fallback;
  };
  const confirm = async (q: string, fallback: boolean): Promise<boolean> => {
    if (!rl) return fallback;
    const answer = (await rl.question(`${q} [${fallback ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
    if (!answer) return fallback;
    return answer.startsWith("y");
  };

  try {
    // 1. repo config scaffold
    const info = repoInfo(process.cwd());
    if (!info) {
      out("⚠ not inside a git repo — skipped agent-bus.config.json (run init from your repo's main checkout)");
    } else {
      const configPath = path.join(info.repoRoot, "agent-bus.config.json");
      if (fs.existsSync(configPath)) {
        out(`✔ ${configPath} already exists (left untouched)`);
      } else {
        const principal =
          flags.principal ?? (await ask("Who is the principal (the human the foreman reports to)?", "Michael"));
        const journalUrl =
          flags.journalUrl ??
          (await ask(
            "Durable journal repo (a separate PRIVATE git repo; empty = journaling off)?",
            "",
          ));
        const scaffold: Record<string, unknown> = {
          principal: { name: principal },
          topology: "strict-hub",
          workers: {
            model: "sonnet",
            overrides: {},
            launcher: "auto",
            allowForemanScaling: true,
          },
          merge: { adminMergeLowRisk: false },
          gh: { poll: true },
        };
        if (journalUrl.trim()) {
          const handle =
            flags.handle ?? (await ask("Journal handle (your fleet's namespace)?", os.userInfo().username));
          scaffold.remote = { url: journalUrl.trim(), handle };
        }
        fs.writeFileSync(configPath, `${JSON.stringify(scaffold, null, 2)}\n`);
        out(`✔ scaffolded ${configPath}`);
      }
    }

    // 2. old-style (pre-plugin) install cleanup — default YES: leftovers
    // double-fire against the plugin's own registrations
    const claudeJsonPath = path.join(home, ".claude.json");
    const claudeJson = readJsonFile(claudeJsonPath);
    const mcpServers = claudeJson.mcpServers as Record<string, unknown> | undefined;
    const oldMcp = mcpServers?.["agent-bus"] !== undefined;
    const settingsPath = path.join(home, ".claude", "settings.json");
    const settings = readJsonFile(settingsPath);
    const settingsRaw = JSON.stringify(settings);
    const oldHooks = /server\.js (publish|board)/.test(settingsRaw);
    const oldSkills = ["foreman", "worker"].filter((s) =>
      fs.existsSync(path.join(home, ".claude", "skills", s, "SKILL.md")),
    );
    if (oldMcp || oldHooks || oldSkills.length > 0) {
      const doClean = await confirm(
        "Found a pre-plugin agent-bus install (user-scope MCP/hooks/skills). Remove it so the " +
          "plugin's registrations don't double-fire?",
        true,
      );
      if (doClean) {
        if (oldMcp && mcpServers) {
          delete mcpServers["agent-bus"];
          writeJsonWithBackup(claudeJsonPath, claudeJson);
          out(`✔ removed user-scope mcpServers["agent-bus"] from ${claudeJsonPath}`);
        }
        if (oldHooks) {
          const removed = removeHooks(settings, /server\.js (publish|board)/);
          if (removed > 0) {
            writeJsonWithBackup(settingsPath, settings);
            out(`✔ removed ${removed} old agent-bus hook(s) from ${settingsPath}`);
          }
        }
        for (const s of oldSkills) {
          fs.rmSync(path.join(home, ".claude", "skills", s), { recursive: true, force: true });
          out(`✔ removed old ~/.claude/skills/${s} (the plugin ships /rh:${s})`);
        }
      } else {
        out("● left the old install in place — expect duplicate board injections and two MCP servers");
      }
    }

    // 3. legacy migration (pre-slug files directly under ~/.claude/coordination)
    const legacyDir = path.join(home, ".claude", "coordination");
    const legacy = legacyCoordinationFiles(legacyDir);
    if (legacy.length > 0 && info) {
      const target = coordinationDir({}, process.cwd());
      const doMove =
        flags.migrate ??
        (await confirm(
          `Found ${legacy.length} legacy file(s) in ${legacyDir} (pre-isolation bus). Move them into this repo's bus (${target})?`,
          false,
        ));
      if (doMove) {
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        for (const name of legacy) fs.renameSync(path.join(legacyDir, name), path.join(target, name));
        out(`✔ migrated ${legacy.length} file(s) → ${target}`);
      } else {
        out(
          `● left legacy files in place. To keep using them instead, set AGENT_BUS_HOME=${legacyDir}; ` +
            "to migrate later, re-run: roundhouse init --migrate",
        );
      }
    }

    // 4. next steps
    out("");
    out("Done. Next steps:");
    out("  1. main checkout: /rh:foreman   (or /loop /rh:foreman)");
    out("  2. add workers:   roundhouse worker add -n 2");
    out("  3. dashboard:     roundhouse serve   → http://localhost:4319");
    out("  (restart running Claude Code sessions so the plugin's MCP server + hooks load)");
  } finally {
    rl?.close();
  }
}
