import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain-JS build script, no types
import { buildBundles } from "../scripts/bundle.mjs";

/**
 * The plugin ships COMMITTED bundles (a plugin install is a plain copy — no
 * npm step), which makes stale-bundle drift the chronic failure mode. This
 * test rebuilds into a temp dir and byte-compares against plugin/dist: if you
 * changed src/ and forgot `npm run bundle`, it fails.
 */
const committedDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugin",
  "dist",
);

let tmp: string;

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("committed plugin bundles", () => {
  it("are fresh relative to src/ (run `npm run bundle` if this fails)", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yes-chef-bundle-"));
    await buildBundles(tmp);
    for (const file of ["server.mjs", "server-impl.mjs", "cli.mjs", "cli-impl.mjs"]) {
      const fresh = fs.readFileSync(path.join(tmp, file), "utf8");
      const committed = fs.readFileSync(path.join(committedDir, file), "utf8");
      expect(committed, `${file} is stale — run: cd yes-chef && npm run bundle`).toBe(fresh);
    }
  }, 60_000);
});
