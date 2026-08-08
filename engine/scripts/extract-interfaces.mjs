#!/usr/bin/env node
/**
 * Shared source-text extraction used by both extract-public-types.mjs
 * (hands-website's cross-repo vendor) and extract-mobile-types.mjs
 * (apps/mobile's in-repo vendor) — the two are the same mechanism (pull one
 * root interface plus everything it transitively references out of
 * engine/src/snapshot.ts by brace-depth, optionally rename a few) aimed at
 * two different audiences with different redaction needs, not two different
 * problems. See extractClosure below for why this walks from a root instead
 * of taking a hand-maintained list of names.
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

// TS/JS builtins that can appear where a field's own type would (generic
// containers, primitive wrapper types) — never something declared in the
// source we're extracting from, so the closure walk must not chase them.
const BUILTIN_TYPE_NAMES = new Set(["Array", "Record", "Partial", "Omit", "Pick", "Readonly", "Promise"]);

/**
 * Extract `rootNames` from `sourcePath` PLUS every interface/type-alias they
 * transitively reference, applying `renameMap` (default: none) to the
 * output. Each name is tried as an interface first, then as a type alias.
 *
 * This is a derived closure, not a hand-maintained list (hands#217): an
 * enumerated list can go stale silently the moment a root type gains a new
 * field referencing a type nobody remembered to add — which is exactly what
 * happened here (SnapshotMenuItem/SnapshotQuestionOption went missing after
 * #205/#211 added them, and nothing failed). Walking references from the
 * root instead means there is no list to forget: a new field is picked up
 * automatically, and a field whose type genuinely doesn't exist in source
 * throws the same "not found" error extractInterface/extractTypeAlias
 * already raise, naming exactly which type is missing.
 *
 * Reference detection is a regex over each already-extracted block
 * (`:\s*([A-Z]\w+)`, the same shape `field: SomeType` always takes in this
 * file's plain data interfaces) — not a real type-checker, so it only
 * chases a capitalized identifier immediately after a colon. That covers
 * every field in snapshot.ts today (arrays and `| null` unions included,
 * since the regex only needs the identifier right after the colon), but
 * would miss a reference buried in a generic parameter or a union where the
 * custom type isn't first. If a future field needs that, extend the regex
 * here rather than reaching back for a hand-maintained list.
 */
export function extractClosure(sourcePath, rootNames, renameMap = {}) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const blocks = new Map(); // name -> raw (pre-rename) block text
  const order = []; // dependency-first: post-order DFS

  function visit(name) {
    if (blocks.has(name)) return; // marked before recursing — cycle-safe
    let block;
    try {
      block = extractInterface(source, name);
    } catch {
      block = extractTypeAlias(source, name);
    }
    blocks.set(name, block);
    for (const [, ref] of block.matchAll(/:\s*([A-Z]\w+)/g)) {
      if (BUILTIN_TYPE_NAMES.has(ref)) continue;
      visit(ref);
    }
    order.push(name);
  }
  for (const root of rootNames) visit(root);

  return order.map((name) => applyRenames(blocks.get(name), renameMap));
}
