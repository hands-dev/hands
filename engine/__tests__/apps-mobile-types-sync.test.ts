import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain-JS build script, no types
import { extractInterface } from "../scripts/extract-interfaces.mjs";
// @ts-expect-error plain-JS build script, no types
import { extractMobileTypes } from "../scripts/extract-mobile-types.mjs";

/**
 * hands#117: two gaps in the mobile type pipeline that #217/#218 didn't
 * close, because they're a different failure shape than the one #217 fixed.
 *
 * #217 was about a HAND-MAINTAINED LIST of type names going stale (fixed by
 * extractClosure walking references instead of enumerating them). Both gaps
 * here survive that fix:
 *
 * 1. Nothing runs `extractMobileTypes()` in CI and compares it to the
 *    committed `apps/mobile/types/hands-snapshot.d.ts` — someone can edit
 *    MobileSnapshot/MobileAgent/etc in snapshot.ts, forget `npm run
 *    sync-types` inside apps/mobile, and nothing notices. Mirrors
 *    bundle.test.ts's committed-vs-fresh pattern exactly.
 *
 * 2. `MobileAgent`/`MobileTask`/`MobileQuestion` are deliberately
 *    HAND-AUTHORED narrow views — they don't reference `SnapshotAgent`/
 *    `SnapshotTask`/`SnapshotQuestion` at all, so extractClosure's walk
 *    never touches those types' fields. A field added to `SnapshotTask`
 *    is invisible to this whole pipeline: the closure finds nothing new
 *    (there's no reference to follow), the freshness check in (1) still
 *    passes (the same hand-authored MobileTask regenerates identically),
 *    and the mobile app just silently doesn't show it. This test makes
 *    that an explicit, reviewable decision instead of a silent gap: every
 *    field in the source type must be either mirrored in the Mobile* type
 *    or named in this test's exclusion list. A new source field that's
 *    neither fails LOUDLY, naming exactly which field and which type —
 *    the same shape of fix hands#217 was, just for a gap #217 didn't cover.
 */

const snapshotPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "snapshot.ts",
);
const committedTypesPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "apps",
  "mobile",
  "types",
  "hands-snapshot.d.ts",
);

/** Top-level field names of an already-extracted interface block (flat data shapes only — no nested object types among the record interfaces this checks). */
function fieldNames(block: string): Set<string> {
  return new Set([...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!));
}

describe("apps/mobile/types/hands-snapshot.d.ts is fresh (hands#117)", () => {
  it("matches a fresh extractMobileTypes() regeneration byte-for-byte", () => {
    const fresh = extractMobileTypes(snapshotPath) as string;
    const committed = fs.readFileSync(committedTypesPath, "utf8");
    expect(
      committed,
      "apps/mobile/types/hands-snapshot.d.ts is stale — run: cd apps/mobile && npm run sync-types",
    ).toBe(fresh);
  });
});

describe("Mobile* record types stay honest about what they exclude from their Snapshot* source (hands#117)", () => {
  // Every field NOT in this list, that exists in the source type but not the
  // Mobile* type, fails the test below. Adding a field to the source type
  // means picking one: mirror it in the Mobile* interface (if the mobile
  // app should show it), or add it here with a reason (if it's deliberately
  // staying out) — this list is that decision's record, not a formality.
  const MIRRORS: Array<{ source: string; mobile: string; deliberatelyExcluded: string[] }> = [
    {
      source: "SnapshotAgent",
      mobile: "MobileAgent",
      deliberatelyExcluded: [
        "branch", // git branch — not shown; the mobile skeleton has no per-station detail view yet
        "cwd",
        "pid",
        "files", // local-machine paths — meaningless off-device, same reasoning PublicSnapshot drops them for
        "lastActive",
        "lastSeen", // raw timestamps the skeleton doesn't render; `state`/`online` already carry the signal
        "wakesLastHour",
        "wakes24h", // operator-facing load metric, not part of the read-only rail/line/needs-you skeleton
        "pendingCommands", // expo-only queue detail
        "sessionName",
        "themeColor", // `stationColor()` derives this client-side from the id instead
        "ready",
        "readyReason", // dispatch-readiness detail — relevant to the expo, not to what the skeleton shows
      ],
    },
    {
      source: "SnapshotTask",
      mobile: "MobileTask",
      deliberatelyExcluded: [
        "body", // the full delegation payload — no per-ticket detail view yet
        "result", // the returned artifact — same, no detail view
        "createdAt",
        "startedAt",
        "finishedAt", // token-cost/timing detail, operator-facing, not the skeleton's concern
      ],
    },
    {
      source: "SnapshotQuestion",
      mobile: "MobileQuestion",
      deliberatelyExcluded: [
        "answer",
        "resolvedBy",
        "answeredVia", // the skeleton only shows OPEN questions (read-only, unanswerable) — resolution detail is moot
        "outcome",
        "outcomeNote",
        "outcomeAt", // expo hindsight self-audit — not user-facing at all
        "options",
        "multiSelect", // the skeleton doesn't render the answerable UI these back — read-only means read-only
      ],
    },
  ];

  const snapshotSource = fs.readFileSync(snapshotPath, "utf8");
  const mobileSource = extractMobileTypes(snapshotPath) as string;

  it.each(MIRRORS)("$mobile mirrors every $source field it doesn't explicitly exclude", ({ source, mobile, deliberatelyExcluded }) => {
    const sourceFields = fieldNames(extractInterface(snapshotSource, source));
    const mobileFields = fieldNames(extractInterface(mobileSource, mobile));
    const excluded = new Set(deliberatelyExcluded);

    for (const field of sourceFields) {
      if (mobileFields.has(field)) continue;
      expect(
        excluded.has(field),
        `${source}.${field} is new — not in ${mobile}, not in this test's exclusion list. ` +
          `Add it to ${mobile} (engine/src/snapshot.ts) if the mobile app should show it, or add ` +
          `"${field}" to this test's deliberatelyExcluded list with a reason if it shouldn't.`,
      ).toBe(true);
    }

    // The inverse direction: every excluded name must be real — a typo or a
    // field that got removed from source should shrink this list, not sit
    // there unverified.
    for (const field of excluded) {
      expect(sourceFields.has(field), `"${field}" is listed as deliberately excluded but isn't a field of ${source} at all — stale entry, remove it`).toBe(true);
    }
  });
});
