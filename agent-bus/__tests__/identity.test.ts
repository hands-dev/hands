import { describe, expect, it } from "vitest";
import {
  agentIdFromArgv,
  displayName,
  indexFromDirName,
  resolveAgentId,
  resolveAgentRef,
} from "../src/identity.js";

describe("indexFromDirName", () => {
  it("parses the worktree-N convention", () => {
    expect(indexFromDirName("/Users/x/Development/ampersand-worktree-4")).toBe(4);
  });

  it("parses the -wtN convention", () => {
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

describe("resolveAgentId precedence", () => {
  const base = { cwd: "/Users/x/Development/ampersand-worktree-4", argv: ["node", "s"] as string[] };

  it("prefers AGENT_BUS_ID env", () => {
    expect(resolveAgentId({ ...base, env: { AGENT_BUS_ID: "explicit" } })).toBe("explicit");
  });

  it("falls back to --agent-id arg", () => {
    expect(resolveAgentId({ ...base, env: {}, argv: ["node", "s", "--agent-id=fromarg"] })).toBe(
      "fromarg",
    );
  });

  it("derives wt<n> from the cwd basename", () => {
    expect(resolveAgentId({ ...base, env: {} })).toBe("wt4");
  });

  it("resolves the main checkout to the foreman", () => {
    expect(resolveAgentId({ cwd: "/Users/x/Development/ampersand", env: {}, argv: ["node", "s"] })).toBe(
      "foreman",
    );
  });

  it("uses the basename for any other non-worktree dir", () => {
    expect(resolveAgentId({ cwd: "/Users/x/Development/some-tool", env: {}, argv: ["node", "s"] })).toBe(
      "some-tool",
    );
  });
});

describe("displayName (presentation layer)", () => {
  it("decorates a mapped worktree id with its human name", () => {
    expect(displayName("wt4")).toBe("C.J. (wt4)");
    expect(displayName("wt1")).toBe("Josh (wt1)");
    expect(displayName("foreman")).toBe("Leo (foreman)");
  });

  it("passes an unmapped id through unchanged", () => {
    expect(displayName("mobile")).toBe("mobile");
    expect(displayName("api")).toBe("api");
  });
});

describe("resolveAgentRef (name/label/id → routing id)", () => {
  it("resolves a bare human name, case-insensitively", () => {
    expect(resolveAgentRef("Toby")).toBe("wt2");
    expect(resolveAgentRef("toby")).toBe("wt2");
    expect(resolveAgentRef("DONNA")).toBe("wt5");
  });

  it("resolves a decorated label back to the parenthesised id", () => {
    expect(resolveAgentRef("C.J. (wt4)")).toBe("wt4");
    expect(resolveAgentRef("Josh (wt1)")).toBe("wt1");
  });

  it("leaves a canonical id untouched", () => {
    expect(resolveAgentRef("wt4")).toBe("wt4");
    expect(resolveAgentRef("foreman")).toBe("foreman");
  });

  it("passes through broadcast and unknown refs unchanged", () => {
    expect(resolveAgentRef("*")).toBe("*");
    expect(resolveAgentRef("mobile")).toBe("mobile");
  });

  it("round-trips displayName → resolveAgentRef for every mapped id", () => {
    for (const id of ["wt1", "wt2", "wt3", "wt4", "wt5", "wt6"]) {
      expect(resolveAgentRef(displayName(id))).toBe(id);
    }
  });
});
