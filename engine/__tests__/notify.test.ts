import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notify } from "../src/notify.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "yes-chef-notify-"));
  fs.mkdirSync(home, { recursive: true });
  env = { YES_CHEF_HOME: home };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("notify", () => {
  it("appends a nudge line per recipient at 0600", () => {
    notify(["wt2", "wt3"], { from: "wt1", subject: "ping", now: 0 }, env);
    for (const recipient of ["wt2", "wt3"]) {
      const file = path.join(home, `${recipient}.notify`);
      const contents = fs.readFileSync(file, "utf8");
      expect(contents).toContain("wt1");
      expect(contents).toContain("ping");
      expect(contents.endsWith("\n")).toBe(true);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("appends (does not overwrite) on repeated sends and strips newlines from subject", () => {
    notify(["wt2"], { from: "wt1", subject: "first", now: 0 }, env);
    notify(["wt2"], { from: "wt1", subject: "line\nbreak", now: 0 }, env);
    const lines = fs
      .readFileSync(path.join(home, "wt2.notify"), "utf8")
      .trim()
      .split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]).not.toContain("\n");
    expect(lines[1]).toContain("line break");
  });
});
