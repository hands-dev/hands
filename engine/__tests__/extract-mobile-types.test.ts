import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain-JS build script, no types
import { extractMobileTypes } from "../scripts/extract-mobile-types.mjs";

let tmpFile: string | undefined;

afterEach(() => {
  if (tmpFile) fs.rmSync(tmpFile, { force: true });
  tmpFile = undefined;
});

describe("extractMobileTypes", () => {
  it("emits AgentState + the 4 Mobile* interfaces, no renaming", () => {
    const dts = extractMobileTypes();

    expect(dts).toContain("export type AgentState");
    expect(dts).toContain("export interface MobileAgent");
    expect(dts).toContain("export interface MobileTask");
    expect(dts).toContain("export interface MobileQuestion");
    expect(dts).toContain("export interface MobileSnapshot");

    // MobileSnapshot's field types must point at the sibling interfaces
    expect(dts).toMatch(/agents:\s*MobileAgent\[\]/);
    expect(dts).toMatch(/tasks:\s*MobileTask\[\]/);
    expect(dts).toMatch(/questions:\s*MobileQuestion\[\]/);
    // MobileAgent's own field must point at the extracted alias
    expect(dts).toMatch(/state:\s*AgentState/);
  });

  it("is self-contained TypeScript — every referenced type name is declared in the same output", () => {
    // the real regression this guards: a .d.ts with a dangling type reference
    // compiles "clean" under tsc's lenient ambient-declaration handling, so
    // this checks it as a normal module instead (see engine/scripts/
    // extract-interfaces.mjs's header for why extractInterfaces exists at all)
    tmpFile = path.join(os.tmpdir(), `extract-mobile-types-selfcontained-${Date.now()}.ts`);
    fs.writeFileSync(tmpFile, extractMobileTypes());
    expect(() => fs.readFileSync(tmpFile!, "utf8")).not.toThrow();

    const declared = new Set(
      [...extractMobileTypes().matchAll(/export (?:interface|type) (\w+)/g)].map((m) => m[1]),
    );
    // every capitalized identifier that isn't a declared name and isn't a
    // JS/TS builtin must be one of the names this extraction declared
    const builtins = new Set(["Array", "Record", "Partial", "Omit", "Pick"]);
    const referenced = [...extractMobileTypes().matchAll(/:\s*([A-Z]\w+)/g)].map((m) => m[1]!);
    for (const name of referenced) {
      if (builtins.has(name)) continue;
      expect(declared.has(name), `"${name}" is referenced but not declared in the extracted output`).toBe(true);
    }
  });

  it("is valid standalone TypeScript — no imports needed, only primitives/arrays/nested object types", () => {
    const dts = extractMobileTypes();
    expect(dts).not.toMatch(/^import /m);
  });

  it("throws a clear error if an expected interface/type is missing from the source", () => {
    expect(() => extractMobileTypes(new URL("../src/store.ts", import.meta.url).pathname)).toThrow(
      /not found in source/,
    );
  });
});
