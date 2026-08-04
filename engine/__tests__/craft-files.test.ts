import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { craftFiles } from "../src/remote.js";
import { craftContext, pathsReport } from "../src/server.js";
import { Store } from "../src/store.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-crafts-"));
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

describe("craftFiles", () => {
  it("slugs the craft name; books off → local crafts/ dir", () => {
    const files = craftFiles("Ordering API", env);
    expect(files.durable).toBe(false);
    expect(files.slug).toBe("ordering-api");
    expect(files.dir).toBe(path.join(home, "crafts"));
    expect(files.book).toBe(path.join(home, "crafts", "ordering-api.md"));
    expect(files.skill).toBe(path.join(home, "crafts", "ordering-api.skill.md"));
    // spelling variants converge on one craft
    expect(craftFiles("ordering api", env).book).toBe(files.book);
  });

  it("books on → inside the clone under the contributor's namespace", () => {
    writeUserConfig({ remote: { url: "git@example.com:x/books.git", handle: "michael", project: "proj" } });
    const files = craftFiles("saucier", env);
    expect(files.durable).toBe(true);
    expect(files.dir).toBe(path.join(home, "remote", "journal", "proj", "michael", "crafts"));
    expect(files.book).toBe(path.join(files.dir, "saucier.md"));
  });
});

describe("craftContext (instruction injection) + hot-swap", () => {
  it("injects the assigned craft's skill then book; unassigned gets the pointer", () => {
    const store = new Store({ env });
    const files = craftFiles("saucier", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.skill, "# How the saucier works\nTaste everything twice.");
    fs.writeFileSync(files.book, "# Sauce knowledge\nBeurre blanc breaks over 58C.");

    // unassigned station → no craft context, just the pointer
    expect(craftContext("station-1", store, env)).toContain("hold no craft yet");

    store.setFocus("station-1", "saucier");
    const injected = craftContext("station-1", store, env);
    expect(injected).toContain("## Your craft: saucier");
    expect(injected).toContain("Taste everything twice.");
    expect(injected).toContain("Beurre blanc breaks over 58C.");
    expect(injected.indexOf("Craft skill")).toBeLessThan(injected.indexOf("Prep book"));

    // a craft with no files yet → founding message, not silence
    store.setFocus("station-2", "poissonnier");
    expect(craftContext("station-2", store, env)).toContain("founding it");

    // the expo never gets craft injection
    expect(craftContext("expo", store, env)).toBe("");
    store.close();
  });

  it("hot-swap: pathsReport re-resolves from current focus without any reconnect", () => {
    const store = new Store({ env });
    store.setFocus("station-1", "saucier");
    const cfg = loadConfig({ env });

    const before = pathsReport("station-1", cfg, store.getFocus("station-1")) as {
      book: string | null;
      craft: string | null;
      booksDir: string | null;
    };
    expect(before.craft).toBe("saucier");
    expect(before.book).toContain(path.join("crafts", "saucier.md"));
    expect(before.booksDir).toBeNull(); // books not configured in this env

    store.setFocus("station-1", "poissonnier"); // the swap — same seat, new craft
    const after = pathsReport("station-1", cfg, store.getFocus("station-1")) as {
      book: string | null;
      craft: string | null;
    };
    expect(after.craft).toBe("poissonnier");
    expect(after.book).toContain(path.join("crafts", "poissonnier.md"));
    store.close();
  });

  it("getFocus resolves for an offline (presence-expired) station", () => {
    const store = new Store({ env });
    const longAgo = Date.now() - 60 * 60_000;
    store.setFocus("station-3", "grillardin", longAgo);
    expect(store.getFocus("station-3")).toBe("grillardin");
    store.close();
  });

  it("caps a runaway book and flags the truncation", () => {
    const store = new Store({ env });
    store.setFocus("station-1", "saucier");
    const files = craftFiles("saucier", env);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.book, "x".repeat(20_000));
    const injected = craftContext("station-1", store, env);
    expect(injected.length).toBeLessThan(8_000);
    expect(injected).toContain("truncated — trim this file");
    store.close();
  });
});
