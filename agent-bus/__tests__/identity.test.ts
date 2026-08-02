import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentIdFromArgv,
  indexFromDirName,
  isForeman,
  isWorker,
  resolveAgentId,
  resolveAgentRef,
} from "../src/identity.js";
import { repoInfo, resetRepoInfoCache } from "../src/paths.js";

describe("indexFromDirName", () => {
  it("parses the managed worker-<n> dirs", () => {
    expect(indexFromDirName("/Users/x/.agent-bus/worktrees/repo-abc/worker-3")).toBe(3);
  });

  it("parses the legacy worktree-N / -wtN conventions", () => {
    expect(indexFromDirName("/Users/x/Development/ampersand-worktree-4")).toBe(4);
    expect(indexFromDirName("/tmp/thing-wt2")).toBe(2);
  });

  it("returns null for the main checkout / branch-named worktrees", () => {
    expect(indexFromDirName("/Users/x/Development/ampersand")).toBeNull();
    expect(indexFromDirName("/Users/x/Development/fix-eng-642")).toBeNull();
  });
});

describe("agentIdFromArgv", () => {
  it("reads --agent-id <name>", () => {
    expect(agentIdFromArgv(["node", "server.ts", "--agent-id", "alpha"])).toBe("alpha");
  });

  it("reads --agent-id=<name>", () => {
    expect(agentIdFromArgv(["node", "server.ts", "--agent-id=beta"])).toBe("beta");
  });

  it("returns null when absent or dangling", () => {
    expect(agentIdFromArgv(["node", "server.ts"])).toBeNull();
    expect(agentIdFromArgv(["node", "server.ts", "--agent-id"])).toBeNull();
  });
});

describe("isWorker / isForeman", () => {
  it("classifies canonical ids", () => {
    expect(isWorker("worker-1")).toBe(true);
    expect(isWorker("worker-12")).toBe(true);
    expect(isWorker("foreman")).toBe(false);
    expect(isWorker("wt4")).toBe(false);
    expect(isWorker("Michael")).toBe(false);
    expect(isForeman("foreman")).toBe(true);
    expect(isForeman("worker-1")).toBe(false);
  });
});

describe("resolveAgentId precedence (non-git cwds)", () => {
  const base = { cwd: "/Users/x/Development/ampersand-worktree-4", argv: ["node", "s"] as string[] };

  it("prefers AGENT_BUS_ID env", () => {
    expect(resolveAgentId({ ...base, env: { AGENT_BUS_ID: "explicit" } })).toBe("explicit");
  });

  it("falls back to --agent-id arg", () => {
    expect(resolveAgentId({ ...base, env: {}, argv: ["node", "s", "--agent-id=fromarg"] })).toBe(
      "fromarg",
    );
  });

  it("derives worker-<n> from the cwd basename", () => {
    expect(resolveAgentId({ ...base, env: {} })).toBe("worker-4");
  });

  it("honours the foreman-basename override (env and option)", () => {
    expect(
      resolveAgentId({
        cwd: "/Users/x/Development/ampersand",
        env: { AGENT_BUS_FOREMAN_BASENAME: "ampersand" },
        argv: ["node", "s"],
      }),
    ).toBe("foreman");
    expect(
      resolveAgentId({
        cwd: "/Users/x/Development/ampersand",
        env: {},
        argv: ["node", "s"],
        foremanBasename: "ampersand",
      }),
    ).toBe("foreman");
  });

  it("uses the basename for any other non-worker dir", () => {
    expect(resolveAgentId({ cwd: "/Users/x/Development/some-tool", env: {}, argv: ["node", "s"] })).toBe(
      "some-tool",
    );
  });
});

describe("resolveAgentId in a real repo (main-worktree autodetect)", () => {
  let root: string;
  let main: string;
  let linked: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-idrepo-"));
    main = path.join(root, "myproj");
    fs.mkdirSync(main);
    const git = (cwd: string, args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(main, ["init", "-q", "-b", "main"]);
    git(main, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
    linked = path.join(root, "myproj-feature");
    git(main, ["worktree", "add", "-q", linked, "-b", "feature"]);
    resetRepoInfoCache();
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    resetRepoInfoCache();
  });

  it("resolves any repo's MAIN worktree to foreman, regardless of its name", () => {
    expect(resolveAgentId({ cwd: main, env: {}, argv: ["node", "s"] })).toBe("foreman");
  });

  it("does NOT make a linked worktree the foreman (basename fallback)", () => {
    expect(resolveAgentId({ cwd: linked, env: {}, argv: ["node", "s"] })).toBe("myproj-feature");
  });

  it("both worktrees resolve to the same repo slug", () => {
    const a = repoInfo(main);
    const b = repoInfo(linked);
    expect(a?.slug).toBeTruthy();
    expect(a?.slug).toBe(b?.slug);
    expect(a?.isMainWorktree).toBe(true);
    expect(b?.isMainWorktree).toBe(false);
  });
});

describe("resolveAgentRef (passthrough — no roster)", () => {
  it("passes ids, principal names, and broadcast through unchanged", () => {
    expect(resolveAgentRef("worker-4")).toBe("worker-4");
    expect(resolveAgentRef("foreman")).toBe("foreman");
    expect(resolveAgentRef("Michael")).toBe("Michael");
    expect(resolveAgentRef("*")).toBe("*");
    expect(resolveAgentRef("  worker-2  ")).toBe("worker-2");
  });
});
