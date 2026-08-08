import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain-JS build script, no types
import { extractClosure } from "../scripts/extract-interfaces.mjs";

let tmpFile: string | undefined;

afterEach(() => {
  if (tmpFile) fs.rmSync(tmpFile, { force: true });
  tmpFile = undefined;
});

function writeTmp(content: string, ext: string): string {
  const file = path.join(os.tmpdir(), `extract-interfaces-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(file, content);
  return file;
}

function declaredNames(blocks: string[]): string[] {
  return blocks.map((b) => b.match(/export interface (\w+)/)![1]!);
}

describe("extractClosure — a derived dependency graph, not a hand-maintained list (hands#217)", () => {
  it("pulls in every transitively-referenced interface from a single root, with no list to forget", () => {
    tmpFile = writeTmp(
      `
export interface Leaf { value: string; }
export interface Middle { leaf: Leaf; }
export interface Root { middle: Middle; direct: Leaf; }
`,
      "ts",
    );
    const names = declaredNames(extractClosure(tmpFile, ["Root"]));
    // nobody told extractClosure about Leaf or Middle — it found them by walking Root's own fields
    expect(new Set(names)).toEqual(new Set(["Root", "Middle", "Leaf"]));
    // dependency-first: a type appears before anything that references it
    expect(names.indexOf("Leaf")).toBeLessThan(names.indexOf("Middle"));
    expect(names.indexOf("Middle")).toBeLessThan(names.indexOf("Root"));
  });

  it("walks a type alias reached through an interface field, same as extractPublicTypes/extractMobileTypes rely on", () => {
    tmpFile = writeTmp(
      `
export type Status = "active" | "idle";
export interface Root { status: Status; }
`,
      "ts",
    );
    const dts = extractClosure(tmpFile, ["Root"]).join("\n\n");
    expect(dts).toContain("export type Status");
    expect(dts).toContain("export interface Root");
  });

  it("is cycle-safe — two interfaces referencing each other terminate instead of recursing forever", () => {
    tmpFile = writeTmp(
      `
export interface NodeA { sibling: NodeB; }
export interface NodeB { sibling: NodeA; }
`,
      "ts",
    );
    const names = declaredNames(extractClosure(tmpFile, ["NodeA"]));
    expect(new Set(names)).toEqual(new Set(["NodeA", "NodeB"]));
  });

  it("this IS the fix for hands#217: a root gaining a field with no matching declaration throws, naming the type — the old hand-list could add a field without adding the type and nothing caught it", () => {
    tmpFile = writeTmp(
      `
export interface Root { missing: DoesNotExist; }
`,
      "ts",
    );
    expect(() => extractClosure(tmpFile, ["Root"])).toThrow(/DoesNotExist.*not found in source/s);
  });

  it("does not chase TS/JS builtins that happen to be the first capitalized identifier after a colon", () => {
    tmpFile = writeTmp(
      `
export interface Root { counts: Record<string, number>; }
`,
      "ts",
    );
    // Record is a builtin, skipped — extraction must NOT try (and fail) to find "export interface Record"
    expect(() => extractClosure(tmpFile, ["Root"])).not.toThrow();
    const names = declaredNames(extractClosure(tmpFile, ["Root"]));
    expect(names).toEqual(["Root"]);
  });

  it("applies renames to the closure's output the same way the old enumerated-list version did", () => {
    tmpFile = writeTmp(
      `
export interface SnapshotLeaf { value: string; }
export interface Root { leaf: SnapshotLeaf; }
`,
      "ts",
    );
    const dts = extractClosure(tmpFile, ["Root"], { SnapshotLeaf: "PublicLeaf" }).join("\n\n");
    expect(dts).toContain("export interface PublicLeaf");
    expect(dts).not.toContain("SnapshotLeaf");
    expect(dts).toMatch(/leaf:\s*PublicLeaf/);
  });
});

describe(
  "hands#217 — proof: tsc treats an unresolved reference in a .d.ts as ambient, but a real error in a .ts module",
  () => {
    // The exact bug: extract-public-types.mjs's old hand-maintained list could
    // omit a type that PublicSnapshot's fields actually reference, producing a
    // .d.ts with a dangling name. sync-dashboard-assets.yml validated that
    // output by running `tsc --noEmit` directly against the .d.ts — which
    // reports success unconditionally for exactly this shape of bug. This
    // spawns real tsc twice against the same broken content to prove the
    // distinction the CI fix (validate as .ts, not .d.ts) depends on.
    const BROKEN = `export interface Broken { field: TypeThatIsNeverDeclared; }\n`;

    it("a dangling reference in a .d.ts compiles clean — this is the bug", () => {
      tmpFile = writeTmp(BROKEN, "d.ts");
      expect(() =>
        execFileSync("npx", ["tsc", "--noEmit", "--skipLibCheck", "--strict", tmpFile!], { stdio: "pipe" }),
      ).not.toThrow();
    });

    it("the SAME content, saved as a .ts module, fails — this is what the CI fix now validates against", () => {
      tmpFile = writeTmp(BROKEN, "ts");
      expect(() =>
        execFileSync("npx", ["tsc", "--noEmit", "--skipLibCheck", "--strict", tmpFile!], { stdio: "pipe" }),
      ).toThrow();
    });
  },
  20_000,
);
