#!/usr/bin/env node
/**
 * Shared source-text extraction used by both extract-public-types.mjs
 * (hands-website's cross-repo vendor) and extract-mobile-types.mjs
 * (apps/mobile's in-repo vendor) — the two are the same mechanism (pull
 * named interfaces out of engine/src/snapshot.ts by brace-depth, optionally
 * rename a few) aimed at two different audiences with different redaction
 * needs, not two different problems.
 */
import * as fs from "node:fs";

/** Extracts one `export interface Name { ... }` block by brace-depth, not a single-line regex — nested object types (e.g. `counts`) would break a line-based match. */
export function extractInterface(source, name) {
  // A plain substring search on "export interface SnapshotTask" would also
  // match "export interface SnapshotTaskExtra" — require a non-identifier
  // char (or end of file) right after the name so a future sibling
  // interface can't be grabbed by mistake.
  const marker = new RegExp(`export interface ${name}(?![\\w$])`);
  const match = marker.exec(source);
  if (!match) throw new Error(`extract-interfaces: "export interface ${name}" not found in source — has it moved or been renamed?`);
  const start = match.index;
  const braceStart = source.indexOf("{", start);
  if (braceStart === -1) throw new Error(`extract-interfaces: no opening brace found for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`extract-interfaces: unterminated interface ${name} (unbalanced braces)`);
}

/**
 * Extracts one `export type Name = ...;` alias by bracket depth, stopping at
 * the first top-level `;` — handles a plain union (`"a" | "b"`) as well as
 * an alias whose RHS is itself an object/array type with nested braces.
 */
export function extractTypeAlias(source, name) {
  const marker = new RegExp(`export type ${name}(?![\\w$])`);
  const match = marker.exec(source);
  if (!match) throw new Error(`extract-interfaces: "export type ${name}" not found in source — has it moved or been renamed?`);
  const start = match.index;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === ";" && depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`extract-interfaces: unterminated type alias ${name} (no top-level ";" found)`);
}

export function applyRenames(text, renameMap) {
  let renamed = text;
  for (const [from, to] of Object.entries(renameMap)) {
    renamed = renamed.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return renamed;
}

/**
 * Extract `names` (in order) from `sourcePath`, applying `renameMap`
 * (default: none) to every block. Each name is tried as an interface first,
 * then as a type alias — the two forms don't collide in practice, and this
 * lets one ordered list mix both without the caller having to say which is
 * which.
 */
export function extractInterfaces(sourcePath, names, renameMap = {}) {
  const source = fs.readFileSync(sourcePath, "utf8");
  return names.map((name) => {
    let block;
    try {
      block = extractInterface(source, name);
    } catch {
      block = extractTypeAlias(source, name);
    }
    return applyRenames(block, renameMap);
  });
}
