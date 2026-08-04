import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { stationFiles } from "../src/remote.js";
import { stationContext } from "../src/server.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-books-"));
  env = { HANDS_HOME: home, HANDS_TEST_HOME: path.join(home, "user") };
  resetConfigCache();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  resetConfigCache();
});

function writeUserConfig(config: object): void {
  const dir = path.join(home, "user", ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hands.config.json"), JSON.stringify(config));
  resetConfigCache();
}

describe("stationFiles", () => {
  it("books off → local stations/ dir under the coordination dir", () => {
    const files = stationFiles("station-1", env);
    expect(files.durable).toBe(false);
    expect(files.dir).toBe(path.join(home, "stations"));
    expect(files.book).toBe(path.join(home, "stations", "station-1.md"));
    expect(files.skill).toBe(path.join(home, "stations", "station-1.skill.md"));
  });

  it("books on → inside the clone under the contributor's namespace", () => {
    writeUserConfig({ remote: { url: "git@example.com:x/books.git", handle: "michael", project: "proj" } });
    const files = stationFiles("station-2", env);
    expect(files.durable).toBe(true);
    expect(files.dir).toBe(path.join(home, "remote", "journal", "proj", "michael", "stations"));
    expect(files.book).toBe(path.join(files.dir, "station-2.md"));
  });
});

describe("stationContext (instruction injection)", () => {
  it("injects skill then book for a station, and nothing for the expo or empty files", () => {
    const files = stationFiles("station-1", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.skill, "# How I work the ordering API\nAlways run the smoke tests.");
    fs.writeFileSync(files.book, "# Ordering API\n400-handling lives in app.py:order().");

    const injected = stationContext("station-1", env);
    expect(injected).toContain("Your station skill");
    expect(injected).toContain("Always run the smoke tests.");
    expect(injected).toContain("Your prep book");
    expect(injected).toContain("app.py:order()");
    expect(injected.indexOf("station skill")).toBeLessThan(injected.indexOf("prep book"));

    expect(stationContext("expo", env)).toBe("");
    expect(stationContext("station-9", env)).toBe(""); // no files → nothing
  });

  it("caps a runaway book and flags the truncation", () => {
    const files = stationFiles("station-1", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.book, "x".repeat(20_000));
    const injected = stationContext("station-1", env);
    expect(injected.length).toBeLessThan(8_000);
    expect(injected).toContain("truncated — trim this file");
  });
});
