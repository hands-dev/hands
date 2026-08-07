import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mergeStationSettings,
  pushPermissionStale,
  PUSH_RULE,
  reconcileStationPushPermission,
  seedStationPermissions,
  stationSettings,
} from "../src/seed-permissions.js";

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

describe("mergeStationSettings", () => {
  it("creates the file when absent", () => {
    const res = mergeStationSettings(dir, { theme: "custom:foo-station-1" });
    expect(res.written).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    expect(parsed.theme).toBe("custom:foo-station-1");
  });

  it("merges into an existing file WITHOUT clobbering keys already there (hands#104's whole point)", () => {
    seedStationPermissions(dir);
    const before = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    expect(Array.isArray(before.permissions.allow)).toBe(true);

    const res = mergeStationSettings(dir, { theme: "custom:foo-station-1" });
    expect(res.written).toBe(true);

    const after = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    expect(after.theme).toBe("custom:foo-station-1");
    expect(after.permissions).toEqual(before.permissions);
  });

  it("never overwrites a key that's already set, and reports written:false", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ theme: "custom:hand-rolled" }));

    const res = mergeStationSettings(dir, { theme: "custom:foo-station-1" });
    expect(res.written).toBe(false);
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    expect(parsed.theme).toBe("custom:hand-rolled");
  });

  it("tolerates a malformed existing file by starting fresh rather than throwing", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(settingsFile(), "{not json");

    const res = mergeStationSettings(dir, { theme: "custom:foo-station-1" });
    expect(res.written).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    expect(parsed.theme).toBe("custom:foo-station-1");
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

  it("does not hand a station blanket git — only push is granted, reset must not ride in on a prefix (hands#86)", () => {
    expect(allow.allow).not.toContain("Bash(git *)");
    expect(allow.allow).toContain("Bash(git push *)");
    expect(allow.deny).not.toContain("Bash(git push *)");
    expect(allow.deny).toContain("Bash(git reset --hard *)");
  });

  it("leaves Edit and Write prompting — a station ships its own branch, a human still merges", () => {
    expect(allow.allow).not.toContain("Edit");
    expect(allow.allow).not.toContain("Write");
    expect(allow.deny).toContain("Bash(gh pr merge *)");
  });

  it("denies the tools that would let a station restructure the line", () => {
    expect(allow.deny).toContain("mcp__plugin_hands_hands__hands_scale");
    expect(allow.deny).toContain("mcp__plugin_hands_hands__hands_station_remove");
  });
});

describe("pushPermissionStale / reconcileStationPushPermission — hands#86 catch-up for already-provisioned seats", () => {
  it("a freshly seeded station is never stale", () => {
    seedStationPermissions(dir);
    expect(pushPermissionStale(dir)).toBe(false);
  });

  it("a station with no settings file at all is not 'stale' — that's seedStationPermissions' job", () => {
    expect(pushPermissionStale(dir)).toBe(false);
    expect(reconcileStationPushPermission(dir)).toEqual({ path: settingsFile(), changed: false });
    expect(fs.existsSync(settingsFile())).toBe(false); // reconcile never creates the file
  });

  it("flags the pre-hands#86 shape: push present in deny, absent from allow", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ permissions: { allow: ["Read", "HandTuned"], deny: [PUSH_RULE, "Bash(git reset --hard *)"] } }),
    );
    expect(pushPermissionStale(dir)).toBe(true);
  });

  it("reconciles: drops push from deny, adds it to allow, leaves everything else untouched", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({
        permissions: { allow: ["Read", "HandTuned"], deny: [PUSH_RULE, "Bash(git reset --hard *)"] },
        theme: "custom:hand-rolled",
      }),
    );

    const res = reconcileStationPushPermission(dir);
    expect(res.changed).toBe(true);

    const after = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    expect(after.permissions.allow).toEqual(["Read", "HandTuned", PUSH_RULE]);
    expect(after.permissions.deny).toEqual(["Bash(git reset --hard *)"]);
    expect(after.theme).toBe("custom:hand-rolled"); // untouched top-level key
    expect(pushPermissionStale(dir)).toBe(false);
  });

  it("is a no-op (changed:false) once already reconciled", () => {
    seedStationPermissions(dir); // current policy already has push in allow, not deny
    const res = reconcileStationPushPermission(dir);
    expect(res.changed).toBe(false);
  });

  it("still adds push to allow even if it was simply absent from both lists (no deny entry at all)", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ permissions: { allow: ["Read"], deny: [] } }));
    expect(pushPermissionStale(dir)).toBe(true);
    reconcileStationPushPermission(dir);
    const after = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    expect(after.permissions.allow).toContain(PUSH_RULE);
  });
});
