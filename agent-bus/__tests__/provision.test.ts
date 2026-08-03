import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentBusConfig, DEFAULT_CONFIG } from "../src/config.js";
import { resetRepoInfoCache } from "../src/paths.js";
import {
  addWorkers,
  launchCommand,
  listWorkers,
  ProvisionError,
  removeWorker,
  scaleWorkers,
  workerRoot,
} from "../src/provision.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let root: string;
let repo: string;
let cfg: AgentBusConfig;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-prov-"));
  repo = path.join(root, "proj");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  resetRepoInfoCache();
  // manual launcher: provision only, never spawn sessions; keep worktrees in the sandbox
  cfg = {
    ...DEFAULT_CONFIG,
    workers: {
      ...DEFAULT_CONFIG.workers,
      launcher: "manual",
      worktreeRoot: path.join(root, "managed"),
      overrides: { "worker-2": "opus" },
    },
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetRepoInfoCache();
});

describe("worker provisioning (manual launcher)", () => {
  it("adds N workers as hidden worktrees on agent-bus/worker-<n> branches", () => {
    const plans = addWorkers(2, { cwd: repo, config: cfg });
    expect(plans.map((p) => p.id)).toEqual(["worker-1", "worker-2"]);
    expect(plans.every((p) => p.launched === false && p.launcher === "manual")).toBe(true);
    // model tier: default + per-worker override
    expect(plans[0]!.model).toBe("sonnet");
    expect(plans[1]!.model).toBe("opus");
    // the worktrees exist under the managed root, on ephemeral branches
    for (const p of plans) {
      expect(fs.existsSync(path.join(p.dir, "README.md"))).toBe(true);
      expect(git(p.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(p.branch);
    }
    // the paste command carries identity + loop
    expect(plans[0]!.command).toContain("AGENT_BUS_ID=worker-1");
    expect(plans[0]!.command).toContain("claude --model sonnet '/loop /agent-bus:worker'");
  });

  it("ls reflects the pool; add fills the lowest free index", () => {
    addWorkers(2, { cwd: repo, config: cfg });
    removeWorker("worker-1", { cwd: repo, config: cfg });
    expect(listWorkers(repo, cfg).map((w) => w.id)).toEqual(["worker-2"]);
    const plans = addWorkers(1, { cwd: repo, config: cfg });
    expect(plans[0]!.id).toBe("worker-1");
    expect(listWorkers(repo, cfg).map((w) => w.id)).toEqual(["worker-1", "worker-2"]);
  });

  it("rm removes worktree + branch and is idempotent", () => {
    addWorkers(1, { cwd: repo, config: cfg });
    const dir = path.join(workerRoot(repo, cfg), "worker-1");
    expect(fs.existsSync(dir)).toBe(true);
    expect(removeWorker("worker-1", { cwd: repo, config: cfg }).removed).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(git(repo, ["branch", "--list", "agent-bus/worker-1"])).toBe("");
    // idempotent
    expect(removeWorker("worker-1", { cwd: repo, config: cfg }).removed).toBe(false);
  });

  it("rm refuses to discard uncommitted work without force", () => {
    addWorkers(1, { cwd: repo, config: cfg });
    const dir = path.join(workerRoot(repo, cfg), "worker-1");
    fs.writeFileSync(path.join(dir, "wip.txt"), "uncommitted\n");
    expect(() => removeWorker("worker-1", { cwd: repo, config: cfg })).toThrow(ProvisionError);
    expect(removeWorker("worker-1", { cwd: repo, config: cfg, force: true }).removed).toBe(true);
  });

  it("scale reconciles up and down (highest index retired first)", () => {
    const up = scaleWorkers(3, { cwd: repo, config: cfg });
    expect(up.added.map((p) => p.id)).toEqual(["worker-1", "worker-2", "worker-3"]);
    const down = scaleWorkers(1, { cwd: repo, config: cfg });
    expect(down.removed).toEqual(["worker-2", "worker-3"]);
    expect(listWorkers(repo, cfg).map((w) => w.id)).toEqual(["worker-1"]);
    const same = scaleWorkers(1, { cwd: repo, config: cfg });
    expect(same.added).toEqual([]);
    expect(same.removed).toEqual([]);
  });

  it("rejects garbage ids and non-repo cwds", () => {
    expect(() => removeWorker("wt4", { cwd: repo, config: cfg })).toThrow(ProvisionError);
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    expect(() => addWorkers(1, { cwd: plain, config: cfg })).toThrow(ProvisionError);
  });

  it("launchCommand quotes odd paths", () => {
    const cmd = launchCommand({ id: "worker-1", dir: "/tmp/has space/w", model: "sonnet" });
    expect(cmd).toContain("'/tmp/has space/w'");
  });
});
