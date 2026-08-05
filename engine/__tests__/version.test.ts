import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInfo, classifyInstall, describe as describeBuild, otherInstall } from "../src/version.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-version-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function stamp(dir: string, version: string, commit: string | null) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "BUILD.json"),
    JSON.stringify({ version, commit, builtAt: "2026-08-05T00:00:00.000Z" }),
  );
}

describe("classifyInstall", () => {
  it("recognizes a standalone install under the home prefix", () => {
    expect(classifyInstall(path.join(home, ".hands", "lib", "cli.mjs"), home)).toBe("standalone");
  });

  it("recognizes a standalone install under a CUSTOM prefix", () => {
    // HANDS_PREFIX installs must not fall through to "unknown"
    expect(classifyInstall("/opt/tools/.hands/lib/cli.mjs", home)).toBe("standalone");
  });

  it("recognizes the plugin cache", () => {
    expect(
      classifyInstall("/home/u/.claude/plugins/cache/hands/hands/abc1234/dist/cli.mjs", home),
    ).toBe("plugin");
  });

  it("recognizes a source run", () => {
    expect(classifyInstall("/repo/engine/src/cli.ts", home)).toBe("source");
  });

  it("is unknown rather than wrong for an unrecognized path", () => {
    expect(classifyInstall("/usr/local/bin/whatever.mjs", home)).toBe("unknown");
    expect(classifyInstall("", home)).toBe("unknown");
  });
});

describe("buildInfo", () => {
  it("reads the stamp written next to the bundle", () => {
    const lib = path.join(home, ".hands", "lib");
    stamp(lib, "1.2.3", "abc1234");
    const info = buildInfo({ entry: path.join(lib, "cli.mjs"), home });
    expect(info.version).toBe("1.2.3");
    expect(info.commit).toBe("abc1234");
    expect(info.kind).toBe("standalone");
  });

  it("falls back to dev when there's no stamp", () => {
    const info = buildInfo({ entry: path.join(home, "nowhere", "cli.mjs"), home, cwd: home });
    expect(info.version).toBe("dev");
  });

  it("describes a build in one readable line", () => {
    const lib = path.join(home, ".hands", "lib");
    stamp(lib, "0.9.0", "deadbee");
    const line = describeBuild(buildInfo({ entry: path.join(lib, "cli.mjs"), home }));
    expect(line).toContain("0.9.0");
    expect(line).toContain("deadbee");
    expect(line).toContain("standalone");
  });
});

describe("otherInstall — the skew that actually bites", () => {
  it("finds a plugin build when running standalone", () => {
    stamp(path.join(home, ".hands", "lib"), "1.0.0", "aaaaaaa");
    stamp(path.join(home, ".claude", "plugins", "cache", "hands", "hands", "bbbbbbb", "dist"), "0.9.0", "bbbbbbb");

    const other = otherInstall("standalone", home);
    expect(other?.kind).toBe("plugin");
    expect(other?.stamp.commit).toBe("bbbbbbb");
  });

  it("finds a standalone build when running from the plugin", () => {
    stamp(path.join(home, ".hands", "lib"), "1.0.0", "aaaaaaa");
    const other = otherInstall("plugin", home);
    expect(other?.kind).toBe("standalone");
    expect(other?.stamp.version).toBe("1.0.0");
  });

  it("returns null when there is only one install", () => {
    stamp(path.join(home, ".hands", "lib"), "1.0.0", "aaaaaaa");
    expect(otherInstall("standalone", home)).toBeNull();
  });

  it("survives an unreadable plugin cache rather than throwing", () => {
    fs.mkdirSync(path.join(home, ".claude", "plugins", "cache", "hands", "hands", "junk"), {
      recursive: true,
    });
    expect(() => otherInstall("standalone", home)).not.toThrow();
  });
});
