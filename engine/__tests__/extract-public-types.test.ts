import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain-JS build script, no types
import { extractPublicTypes } from "../scripts/extract-public-types.mjs";

let tmpFile: string | undefined;

afterEach(() => {
  if (tmpFile) fs.rmSync(tmpFile, { force: true });
  tmpFile = undefined;
});

describe("extractPublicTypes", () => {
  it("emits the 7 public interfaces with Snapshot* renamed to their Public* form", () => {
    const dts = extractPublicTypes();

    expect(dts).toContain("export interface PublicCraft");
    expect(dts).toContain("export interface PublicQuestionOption");
    expect(dts).toContain("export interface PublicQuestion");
    expect(dts).toContain("export interface PublicTask");
    expect(dts).toContain("export interface PublicTodo");
    expect(dts).toContain("export interface PublicMenuItem");
    expect(dts).toContain("export interface PublicSnapshot");

    // the internal names must not leak through — every reference is renamed, not just the declarations
    expect(dts).not.toMatch(/\bSnapshotQuestionOption\b/);
    expect(dts).not.toMatch(/\bSnapshotQuestion\b/);
    expect(dts).not.toMatch(/\bSnapshotTask\b/);
    expect(dts).not.toMatch(/\bSnapshotTodo\b/);
    expect(dts).not.toMatch(/\bSnapshotMenuItem\b/);

    // PublicSnapshot's field types must point at the renamed interfaces, not the old names
    expect(dts).toMatch(/questions:\s*PublicQuestion\[\]/);
    expect(dts).toMatch(/tasks:\s*PublicTask\[\]/);
    expect(dts).toMatch(/todos:\s*PublicTodo\[\]/);
    expect(dts).toMatch(/crafts:\s*PublicCraft\[\]/);
    expect(dts).toMatch(/menu:\s*PublicMenuItem\[\]/);
    // PublicQuestion's own field must point at the renamed option type too
    expect(dts).toMatch(/options:\s*PublicQuestionOption\[\]\s*\|\s*null/);
  });

  it("is valid standalone TypeScript — no imports needed, only primitives/arrays/nested object types", () => {
    const dts = extractPublicTypes();
    expect(dts).not.toMatch(/^import /m);
  });

  it("throws a clear error if an expected interface is missing from the source (catches upstream renames early)", () => {
    // simulate a source that's missing PublicCraft by pointing at a file without it
    expect(() => extractPublicTypes(new URL("../src/store.ts", import.meta.url).pathname)).toThrow(
      /not found in source/,
    );
  });

  it("doesn't grab a sibling interface whose name shares a prefix (e.g. a future SnapshotTaskExtra)", () => {
    tmpFile = path.join(os.tmpdir(), `extract-public-types-boundary-${Date.now()}.ts`);
    fs.writeFileSync(
      tmpFile,
      `
export interface PublicCraft { station: string; focus: string | null; }
export interface SnapshotTaskExtra { decoyOnlyField: string; }
export interface SnapshotQuestionOption { label: string; }
export interface SnapshotQuestion { id: number; }
export interface SnapshotTask { realOnlyField: string; }
export interface SnapshotTodo { id: number; }
export interface SnapshotMenuItem { slug: string; }
export interface PublicSnapshot { crafts: PublicCraft[]; menu: SnapshotMenuItem[]; questions: SnapshotQuestion[]; tasks: SnapshotTask[]; todos: SnapshotTodo[]; }
`,
    );

    const dts = extractPublicTypes(tmpFile);

    expect(dts).toContain("realOnlyField");
    expect(dts).not.toContain("decoyOnlyField");
    expect(dts).not.toContain("SnapshotTaskExtra");
  });
});
