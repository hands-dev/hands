#!/usr/bin/env node
/**
 * Publish the standalone installer's payload — plugin/dist/{cli.mjs,cli-impl.mjs,BUILD.json,
 * assets/**} — to Vercel Blob, keyed by commit. See install.sh's HANDS_BLOB_ORIGIN for the
 * reader side of this (hands#94).
 *
 * Run via `npm run publish-installer` from CI's bundle-plugin.yml, right after `npm run
 * bundle:stamp` — the commit key comes from the BUILD.json that step just wrote, never
 * recomputed independently here, so publish and stamp can't disagree about which commit this is.
 *
 * Layout:
 *   installer/<commit>/{cli.mjs,cli-impl.mjs,BUILD.json,assets/**}  — immutable once published.
 *     Safe to re-publish the same commit (a manual workflow_dispatch rerun, say): the bundle is
 *     a deterministic function of that commit's source (bundle.test.ts byte-compares it, and the
 *     BUILD.json-churn-on-every-dev-build problem this could otherwise cause was hands#166/#188's
 *     fix), so re-uploading identical content to the same key is a genuine no-op, not a risk.
 *   installer/latest.json  — the ONE mutable pointer, `{ commit, publishedAt }`. Written LAST,
 *     only after every commit-keyed file above has uploaded AND been read back and verified byte
 *     for byte. install.sh resolves "latest" through this file ONCE, before downloading anything
 *     else, and then follows one fully-immutable commit tree — a failed or partial publish here
 *     simply never advances the pointer, so installers keep serving the last known-good release
 *     instead of a half-published one. That's the whole point of the two-tier design: nothing
 *     the installer reads is ever allowed to change out from under it mid-install.
 *
 * Every upload is read back over HTTP and byte-compared before this script calls it done — this
 * IS the "smoke test the real origin" the ticket asked for, run against the actual artifact every
 * single publish rather than as a separate, driftable check.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDistDir = path.resolve(pkgDir, "..", "plugin", "dist");

/** Read the commit this bundle was stamped with — throws if bundle:stamp hasn't run. */
export function readBuildInfo(distDir = defaultDistDir) {
  const raw = fs.readFileSync(path.join(distDir, "BUILD.json"), "utf8");
  const info = JSON.parse(raw);
  if (!info.commit) {
    throw new Error("plugin/dist/BUILD.json has no commit — run `npm run bundle:stamp` first");
  }
  return info;
}

/**
 * Exactly what install.sh fetches — no more, no less. server.mjs/server-impl.mjs/books-server.mjs
 * are the Claude Code plugin's own entry points (served from the git-committed plugin/dist via
 * the marketplace, never from Blob); listing them here would just be unused weight to verify.
 * Returns `[relativePathUnderDistDir, blobKey][]`, MANIFEST-driven so a new/renamed/removed asset
 * can never silently drift out of sync the way a second hardcoded list would (same reasoning as
 * install.sh's own manifest read, and bundle.mjs's comment on why MANIFEST.txt exists at all).
 */
export function collectFiles(commit, distDir = defaultDistDir) {
  const prefix = `installer/${commit}`;
  const manifest = fs
    .readFileSync(path.join(distDir, "assets", "MANIFEST.txt"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return [
    ["cli.mjs", `${prefix}/cli.mjs`],
    ["cli-impl.mjs", `${prefix}/cli-impl.mjs`],
    ["BUILD.json", `${prefix}/BUILD.json`],
    ["assets/MANIFEST.txt", `${prefix}/assets/MANIFEST.txt`],
    ...manifest.map((rel) => [`assets/${rel}`, `${prefix}/assets/${rel}`]),
  ];
}

/**
 * Publish one commit's payload plus advance the latest.json pointer. `put`/`fetchFn` are
 * dependency-injected (test hooks — same convention as engine/src/serve.ts's `opts?.fileFeedback`
 * etc.) so this can be exercised in vitest against fakes, no real Vercel credentials required.
 */
export async function publish({
  distDir = defaultDistDir,
  put,
  fetchFn = fetch,
  log = console.log,
} = {}) {
  const { commit } = readBuildInfo(distDir);
  const files = collectFiles(commit, distDir);

  const publishAndVerify = async (key, body, contentType) => {
    const { url } = await put(key, body, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      ...(contentType ? { contentType } : {}),
    });
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`verify GET ${url} → HTTP ${res.status}`);
    const got = Buffer.from(await res.arrayBuffer());
    if (!got.equals(body)) throw new Error(`verify ${url} — content mismatch after upload`);
    return url;
  };

  log(`publishing ${files.length} files to installer/${commit}/ …`);
  for (const [relPath, key] of files) {
    const body = fs.readFileSync(path.join(distDir, relPath));
    const url = await publishAndVerify(key, body);
    log(`  ✔ ${key} → ${url}`);
  }

  // The one mutable pointer — written LAST, only once every file above verified.
  const latest = `${JSON.stringify({ commit, publishedAt: new Date().toISOString() }, null, 2)}\n`;
  const latestUrl = await publishAndVerify("installer/latest.json", Buffer.from(latest), "application/json");
  log(`✔ installer/latest.json → ${commit} (${latestUrl})`);

  return { commit, files: files.map(([, key]) => key) };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { put } = await import("@vercel/blob");
  publish({ put }).catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
