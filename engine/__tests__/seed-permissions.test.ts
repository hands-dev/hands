import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedStationPermissions, stationSettings } from "../src/seed-permissions.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hands-seed-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const settingsFile = () => path.join(dir, ".claude", "settings.local.json");

describe("seedStationPermissions", () => {
  it("writes a parseable settings file into a bare worktree", () => {
    const res = seedStationPermissions(dir);
    expect(res.written).toBe(true);
    expect(res.path).toBe(settingsFile());
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    expect(Array.isArray(parsed.permissions.allow)).toBe(true);
    expect(parsed.permissions.allow.length).toBeGreaterThan(0);
  });

  it("creates the .claude directory when it does not exist", () => {
    expect(fs.existsSync(path.join(dir, ".claude"))).toBe(false);
    seedStationPermissions(dir);
    expect(fs.existsSync(path.join(dir, ".claude"))).toBe(true);
  });

  it("NEVER overwrites existing settings, and reports that it didn't", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(settingsFile(), '{"permissions":{"allow":["HandTuned"]}}');

    const res = seedStationPermissions(dir);

    expect(res.written).toBe(false);
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    expect(parsed.permissions.allow).toEqual(["HandTuned"]);
  });

  it("is idempotent — a second call is a no-op", () => {
    expect(seedStationPermissions(dir).written).toBe(true);
    expect(seedStationPermissions(dir).written).toBe(false);
  });
});

describe("the grant itself", () => {
  const allow = stationSettings().permissions as { allow: string[]; deny: string[] };

  it("lets a station read and investigate", () => {
    expect(allow.allow).toContain("Read");
    expect(allow.allow).toContain("Bash(git log *)");
    expect(allow.allow).toContain("Bash(gh issue view *)");
  });

  it("grants the bus tools a station needs to drain and report", () => {
    for (const tool of ["hands_paths", "hands_receive", "hands_tasks", "hands_task_update"]) {
      expect(allow.allow).toContain(`mcp__plugin_hands_hands__${tool}`);
    }
  });

  it("does not hand a station blanket git — push and reset must not ride in on a prefix", () => {
    expect(allow.allow).not.toContain("Bash(git *)");
    expect(allow.deny).toContain("Bash(git push *)");
    expect(allow.deny).toContain("Bash(git reset --hard *)");
  });

  it("leaves Edit and Write prompting — a station proposes, a human ships", () => {
    expect(allow.allow).not.toContain("Edit");
    expect(allow.allow).not.toContain("Write");
    expect(allow.deny).toContain("Bash(gh pr merge *)");
  });

  it("denies the tools that would let a station restructure the line", () => {
    expect(allow.deny).toContain("mcp__plugin_hands_hands__hands_scale");
    expect(allow.deny).toContain("mcp__plugin_hands_hands__hands_station_remove");
  });
});
