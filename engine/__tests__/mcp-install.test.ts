import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_BASENAME, resetConfigCache } from "../src/config.js";
import { resetRepoInfoCache } from "../src/paths.js";
import { localBooksOriginPath, resetProjectCache } from "../src/remote.js";
import {
  booksMcpEntry,
  desktopConfigPath,
  resolveBooksServerEntry,
  resolveBooksTarget,
  serverName,
  writeDesktopConfig,
} from "../src/mcp-install.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hands-mcp-install-"));
  resetRepoInfoCache();
  resetConfigCache();
  resetProjectCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repo checkout with hands.config.json, optionally pointing `remote.url` at a LOCAL PATH (not a real git URL) — the free-tier local-books case. */
function repoWithConfig(remote?: { url: string; handle?: string }): string {
  const dir = fs.mkdtempSync(path.join(root, "repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.co"]);
  git(dir, ["config", "user.name", "t"]);
  const cfg = {
    principal: { name: "Michael" },
    remote: remote ? { url: remote.url, handle: remote.handle ?? "michael", project: null } : undefined,
  };
  fs.writeFileSync(path.join(dir, CONFIG_BASENAME), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(dir, "README.md"), "x");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function bareRemote(): string {
  const dir = fs.mkdtempSync(path.join(root, "remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
  return dir;
}

describe("resolveBooksTarget", () => {
  it("fails clearly when cwd is not a git repo", () => {
    const dir = fs.mkdtempSync(path.join(root, "notrepo-"));
    const res = resolveBooksTarget({ cwd: dir, env: { HANDS_HOME: path.join(root, "home") } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("not inside a git repo");
  });

  it("succeeds via the local-default origin when nothing is configured (hands#129 — books are always on)", () => {
    const dir = repoWithConfig();
    const env = { HANDS_HOME: path.join(root, "home") };
    const res = resolveBooksTarget({ cwd: dir, env });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.target.url).toBe(localBooksOriginPath(env, dir));
      expect(fs.existsSync(path.join(res.target.dir, ".git"))).toBe(true);
    }
  });

  it("resolves a target for a LOCAL PATH remote.url (free tier, no real git host)", () => {
    const remote = bareRemote();
    const dir = repoWithConfig({ url: remote });
    const res = resolveBooksTarget({ cwd: dir, env: { HANDS_HOME: path.join(root, "home") } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.target.url).toBe(remote);
      expect(res.target.handle).toBe("michael");
      expect(fs.existsSync(path.join(res.target.dir, ".git"))).toBe(true);
    }
  });
});

describe("resolveBooksServerEntry", () => {
  it("finds a bundled books-server.mjs next to the running module", () => {
    const here = fs.mkdtempSync(path.join(root, "dist-"));
    fs.writeFileSync(path.join(here, "books-server.mjs"), "// stub");
    expect(resolveBooksServerEntry(here)).toBe(path.join(here, "books-server.mjs"));
  });

  it("returns null when neither the bundled nor the dev-fallback copy exists", () => {
    const here = fs.mkdtempSync(path.join(root, "empty-"));
    expect(resolveBooksServerEntry(here)).toBeNull();
  });
});

describe("booksMcpEntry / serverName", () => {
  it("bakes the resolved dir + project into env, never relying on cwd at runtime", () => {
    const entry = booksMcpEntry("/abs/books-server.mjs", {
      dir: "/abs/journal-clone",
      project: "hands",
      handle: "michael",
      url: "git@example.com:x/y.git",
    });
    expect(entry).toEqual({
      command: "node",
      args: ["--no-warnings", "/abs/books-server.mjs"],
      env: { HANDS_BOOKS_DIR: "/abs/journal-clone", HANDS_BOOKS_PROJECT: "hands" },
    });
    expect(serverName("hands")).toBe("hands-books-hands");
  });
});

describe("desktopConfigPath", () => {
  it("honors the test override", () => {
    expect(desktopConfigPath({ HANDS_TEST_DESKTOP_CONFIG: "/tmp/x.json" })).toBe("/tmp/x.json");
  });
});

describe("writeDesktopConfig", () => {
  it("creates a fresh config file when absent", () => {
    const file = path.join(root, "claude_desktop_config.json");
    const res = writeDesktopConfig(file, "hands-books-hands", {
      command: "node",
      args: ["--no-warnings", "/a/books-server.mjs"],
      env: { HANDS_BOOKS_DIR: "/a", HANDS_BOOKS_PROJECT: "hands" },
    });
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed.mcpServers["hands-books-hands"].env.HANDS_BOOKS_PROJECT).toBe("hands");
  });

  it("merges into an existing config without touching other servers", () => {
    const file = path.join(root, "claude_desktop_config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ mcpServers: { other: { command: "node", args: ["x.js"], env: {} } } }, null, 2),
    );
    const res = writeDesktopConfig(file, "hands-books-hands", {
      command: "node",
      args: ["--no-warnings", "/a/books-server.mjs"],
      env: { HANDS_BOOKS_DIR: "/a", HANDS_BOOKS_PROJECT: "hands" },
    });
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["hands-books-hands", "other"]);
  });

  it("refuses to clobber a malformed existing config", () => {
    const file = path.join(root, "claude_desktop_config.json");
    fs.writeFileSync(file, "{ not json");
    const res = writeDesktopConfig(file, "hands-books-hands", {
      command: "node",
      args: [],
      env: {},
    });
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });
});
