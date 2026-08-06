import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assignStationTheme,
  THEME_PALETTE,
  themeColorForIndex,
  themeFileContents,
  themeFileName,
  themeFilePath,
  themesDir,
} from "../src/theming.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-theming-"));
  env = { HANDS_TEST_HOME: home };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("themeColorForIndex", () => {
  it("is deterministic by index — same index always yields the same colour", () => {
    expect(themeColorForIndex(3)).toEqual(themeColorForIndex(3));
    expect(themeColorForIndex(1)).toEqual(THEME_PALETTE[0]);
    expect(themeColorForIndex(2)).toEqual(THEME_PALETTE[1]);
  });

  it("wraps past the palette length rather than throwing or repeating index 1's slot early", () => {
    const n = THEME_PALETTE.length;
    expect(themeColorForIndex(n + 1)).toEqual(THEME_PALETTE[0]);
    expect(themeColorForIndex(n)).toEqual(THEME_PALETTE[n - 1]);
  });

  it("every palette entry is a distinct colour", () => {
    const hexes = new Set(THEME_PALETTE.map((c) => c.hex));
    expect(hexes.size).toBe(THEME_PALETTE.length);
  });
});

describe("theme file paths", () => {
  it("themesDir honors HANDS_TEST_HOME, same override config.ts/credentials.ts/projects.ts use", () => {
    expect(themesDir(env)).toBe(path.join(home, ".claude", "themes"));
  });

  it("themeFileName is unique per repo slug + station index", () => {
    expect(themeFileName("myrepo-a1b2c3d4", 1)).toBe("myrepo-a1b2c3d4-station-1");
    expect(themeFileName("myrepo-a1b2c3d4", 2)).toBe("myrepo-a1b2c3d4-station-2");
  });

  it("themeFilePath composes themesDir + themeFileName + .json", () => {
    expect(themeFilePath("proj-abcd1234", 4, env)).toBe(
      path.join(home, ".claude", "themes", "proj-abcd1234-station-4.json"),
    );
  });
});

describe("assignStationTheme", () => {
  it("composes a full assignment: colour, file path, theme id, and session name", () => {
    const a = assignStationTheme({ repoLabel: "myrepo", repoSlug: "myrepo-a1b2c3d4", index: 1, env });
    expect(a.index).toBe(1);
    expect(a.color).toEqual(THEME_PALETTE[0]);
    expect(a.file).toBe(path.join(home, ".claude", "themes", "myrepo-a1b2c3d4-station-1.json"));
    expect(a.themeId).toBe("custom:myrepo-a1b2c3d4-station-1");
    expect(a.sessionName).toContain("myrepo");
    expect(a.sessionName).toContain("station-1");
    expect(a.sessionName).toContain(THEME_PALETTE[0]!.name);
  });

  it("two different repos with the same basename get the same colour per index but different files", () => {
    const a = assignStationTheme({ repoLabel: "app", repoSlug: "app-aaaaaaaa", index: 2, env });
    const b = assignStationTheme({ repoLabel: "app", repoSlug: "app-bbbbbbbb", index: 2, env });
    expect(a.color).toEqual(b.color);
    expect(a.file).not.toBe(b.file);
  });

  it("themeFileContents matches Claude Code's standalone custom-theme shape", () => {
    const a = assignStationTheme({ repoLabel: "myrepo", repoSlug: "myrepo-a1b2c3d4", index: 1, env });
    const contents = themeFileContents(a);
    expect(contents).toEqual({
      name: a.sessionName,
      base: "dark",
      overrides: { claude: a.color.hex, promptBorder: a.color.hex },
    });
  });
});
