import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { coordinationDir, repoInfo } from "./paths.js";

/**
 * `agent-bus init` — one-command setup, run from inside the target repo:
 *   1. build the package (src/ → dist/)
 *   2. register the MCP server user-scope in ~/.claude.json (absolute paths)
 *   3. merge the two bus hooks into ~/.claude/settings.json
 *      (Stop → publish, UserPromptSubmit → board — the proven live pairing)
 *   4. scaffold <repo>/agent-bus.config.json (asks for the principal's name)
 *   5. render skills/{foreman,worker} templates → ~/.claude/skills/
 *   6. offer to migrate a legacy un-scoped ~/.claude/coordination dir
 *
 * Everything is merge-not-overwrite, with a .agent-bus.bak backup next to any
 * file we modify. Safe to re-run — it re-points paths and re-syncs skills.
 */

interface InitFlags {
  yes: boolean;
  skipBuild: boolean;
  migrate: boolean | null; // null = ask
  principal: string | null;
}

function parseFlags(argv: string[]): InitFlags {
  const flags: InitFlags = { yes: false, skipBuild: false, migrate: null, principal: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--skip-build") flags.skipBuild = true;
    else if (a === "--migrate") flags.migrate = true;
    else if (a === "--no-migrate") flags.migrate = false;
    else if (a === "--principal") flags.principal = argv[++i] ?? null;
    else if (a.startsWith("--principal=")) flags.principal = a.slice("--principal=".length);
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

/** The package dir (…/agent-bus), resolved from the compiled dist/ location. */
function packageDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

interface HookSpec {
  event: "Stop" | "UserPromptSubmit";
  command: string;
  timeout: number;
  async?: boolean;
  /** replaces any existing hook whose command matches this */
  signature: RegExp;
}

/**
 * Merge a hook into settings.json's hooks.<event>. If an entry already runs
 * this subcommand (any path — e.g. an old checkout), its command is re-pointed
 * instead of appending a duplicate.
 */
function mergeHook(settings: Record<string, unknown>, spec: HookSpec): "added" | "updated" {
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const entries = (hooks[spec.event] ??= []) as Array<{
    matcher?: string;
    hooks?: Array<{ type?: string; command?: string; timeout?: number; async?: boolean }>;
  }>;
  for (const entry of entries) {
    for (const h of entry.hooks ?? []) {
      if (h.command && spec.signature.test(h.command)) {
        h.command = spec.command;
        h.timeout = spec.timeout;
        if (spec.async !== undefined) h.async = spec.async;
        return "updated";
      }
    }
  }
  entries.push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: spec.command,
        timeout: spec.timeout,
        ...(spec.async !== undefined ? { async: spec.async } : {}),
      },
    ],
  });
  return "added";
}

function renderSkill(templateFile: string, vars: Record<string, string>): string {
  let body = fs.readFileSync(templateFile, "utf8");
  for (const [key, value] of Object.entries(vars)) {
    body = body.replaceAll(`{{${key}}}`, value);
  }
  const leftover = body.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`unrendered template var ${leftover[0]} in ${templateFile}`);
  return body;
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
  const pkgDir = packageDir();
  const workflowRoot = path.resolve(pkgDir, "..");
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
    // 1. build
    if (!flags.skipBuild) {
      out("▸ building agent-bus (src → dist)…");
      const res = spawnSync("npm", ["run", "build"], { cwd: pkgDir, stdio: "inherit" });
      if (res.status !== 0) throw new Error("npm run build failed");
    }
    const nodeBin = process.execPath;
    const serverJs = path.join(pkgDir, "dist", "server.js");

    // 2. MCP registration (user scope, absolute paths — identity derives from cwd)
    const claudeJsonPath = path.join(home, ".claude.json");
    const claudeJson = readJsonFile(claudeJsonPath);
    const mcpServers = (claudeJson.mcpServers ??= {}) as Record<string, unknown>;
    mcpServers["agent-bus"] = {
      type: "stdio",
      command: nodeBin,
      args: ["--no-warnings", serverJs],
      env: {},
    };
    writeJsonWithBackup(claudeJsonPath, claudeJson);
    out(`✔ MCP server registered in ${claudeJsonPath} (user scope)`);

    // 3. hooks
    const settingsPath = path.join(home, ".claude", "settings.json");
    const settings = readJsonFile(settingsPath);
    const publish = mergeHook(settings, {
      event: "Stop",
      command: `${nodeBin} --no-warnings ${serverJs} publish`,
      timeout: 30,
      async: true,
      signature: /server\.js publish/,
    });
    mergeHook(settings, {
      event: "UserPromptSubmit",
      command: `${nodeBin} --no-warnings ${serverJs} board`,
      timeout: 10,
      signature: /server\.js board/,
    });
    writeJsonWithBackup(settingsPath, settings);
    out(`✔ hooks ${publish === "added" ? "added" : "re-pointed"} in ${settingsPath} (Stop → publish, UserPromptSubmit → board)`);

    // 4. repo config scaffold
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
        const scaffold = {
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
        fs.writeFileSync(configPath, `${JSON.stringify(scaffold, null, 2)}\n`);
        out(`✔ scaffolded ${configPath}`);
      }
    }

    // 5. skills (rendered templates)
    const principalName = flags.principal ?? loadConfig({ cwd: process.cwd() }).principal.name;
    const vars = { PRINCIPAL: principalName, SERVER_JS: serverJs, NODE: nodeBin };
    for (const skill of ["foreman", "worker"]) {
      const src = path.join(workflowRoot, "skills", skill, "SKILL.md");
      const destDir = path.join(home, ".claude", "skills", skill);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, "SKILL.md"), renderSkill(src, vars));
      out(`✔ installed ~/.claude/skills/${skill}/SKILL.md (principal: ${principalName})`);
    }

    // 6. legacy migration (pre-slug files directly under ~/.claude/coordination)
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
            "to migrate later, re-run: agent-bus init --skip-build --migrate",
        );
      }
    }

    // 7. next steps
    out("");
    out("Done. Next steps:");
    out("  1. in this repo's main checkout, start the command center:   /foreman   (or /loop /foreman)");
    out(`  2. add workers:   node ${path.join(pkgDir, "dist", "cli.js")} worker add -n 2`);
    out(`  3. optional live dashboard:   ${nodeBin} ${serverJs} serve   → http://localhost:4319`);
    out("  (restart running Claude Code sessions to pick up the MCP registration)");
  } finally {
    rl?.close();
  }
}
