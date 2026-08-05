import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { CONFIG_BASENAME } from "./config.js";
import { repoInfo } from "./paths.js";
import { registerProject } from "./projects.js";
import { githubUsername } from "./remote.js";

/**
 * `hands init` — per-repo setup, run from inside the target repo. The
 * PLUGIN owns MCP registration, hooks, and skills; this command scaffolds
 * what must stay per-repo: <repo>/hands.config.json (principal + optional
 * books journal). Idempotent — an existing config is left untouched.
 */

interface InitFlags {
  yes: boolean;
  principal: string | null;
  journalUrl: string | null;
  handle: string | null;
}

function parseFlags(argv: string[]): InitFlags {
  const flags: InitFlags = { yes: false, principal: null, journalUrl: null, handle: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--yes" || a === "-y") flags.yes = true;
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

export async function runInit(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const interactive = process.stdin.isTTY === true && !flags.yes;
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const ask = async (q: string, fallback: string): Promise<string> => {
    if (!rl) return fallback;
    const answer = (await rl.question(`${q} [${fallback}] `)).trim();
    return answer || fallback;
  };

  try {
    const info = repoInfo(process.cwd());
    if (!info) {
      out(`⚠ not inside a git repo — skipped ${CONFIG_BASENAME} (run init from your repo's main checkout)`);
    } else {
      const configPath = path.join(info.repoRoot, CONFIG_BASENAME);
      // Register in BOTH branches. The already-configured branch returns early,
      // so registering only on scaffold would leave every kitchen that was
      // initialized before the launcher existed unreachable by name.
      const entry = registerProject(info.repoRoot);
      if (entry) out(`✔ registered "${entry.name}" — open it from anywhere with: hands ${entry.name}`);
      if (fs.existsSync(configPath)) {
        out(`✔ ${configPath} already exists (left untouched)`);
        out("  (to attach the books to an existing config: hands books <url>)");
      } else {
        const principal =
          flags.principal ?? (await ask("Who is the principal (the human the expo reports to)?", "Michael"));
        const journalUrl =
          flags.journalUrl ??
          (await ask(
            "Books repo (a separate PRIVATE git repo for the durable journal; empty = books off)?",
            "",
          ));
        const scaffold: Record<string, unknown> = {
          principal: { name: principal },
          topology: "strict-hub",
          stations: {
            model: "sonnet",
            overrides: {},
            launcher: "auto",
            allowScaling: true,
          },
          merge: { adminMergeLowRisk: false },
          gh: { poll: true },
        };
        if (journalUrl.trim()) {
          const handle =
            flags.handle ??
            (await ask(
              "Books handle (your fleet's namespace)?",
              githubUsername() ?? os.userInfo().username,
            ));
          scaffold.remote = { url: journalUrl.trim(), handle };
        }
        fs.writeFileSync(configPath, `${JSON.stringify(scaffold, null, 2)}\n`);
        out(`✔ scaffolded ${configPath}`);
      }
    }

    out("");
    out("Done. Next steps:");
    out("  1. main checkout: /hands:expo   (or /loop /hands:expo)");
    out("  2. open stations: hands station add -n 2");
    out("  3. dashboard:     hands serve   → http://localhost:4319");
    out("  (restart running Claude Code sessions so the plugin's MCP server + hooks load)");
  } finally {
    rl?.close();
  }
}
