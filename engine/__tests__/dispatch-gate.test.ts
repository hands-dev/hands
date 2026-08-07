import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { attestationValid } from "../src/attest.js";
import { DEFAULT_CONFIG } from "../src/config.js";

/**
 * The gate's decision logic. The MCP wiring is exercised by hand against a live
 * kitchen; these pin the rules that decide dispatchable-or-not, which is where
 * a mistake silently either blocks a working kitchen or lets a stale one
 * through.
 */

let home: string;
let store: Store;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-gate-"));
  env = { HANDS_HOME: home };
  store = new Store({ env });
});

afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the gate's default", () => {
  it("requires attestation out of the box", () => {
    // A gate defaulting to off is a gate nobody turns on. The migration cost is
    // real (every station is unattested on first deploy) and is paid down by
    // the refusal naming the exact command, not by shipping it disabled.
    expect(DEFAULT_CONFIG.dispatch.requireAttestation).toBe(true);
  });
});

describe("attestation records", () => {
  it("a station that never attested has no record", () => {
    expect(store.getAttestation("station-1")).toBeNull();
  });

  it("records a clean attestation with the facts it attested against", () => {
    store.setAttestation({
      agentId: "station-1",
      ok: true,
      headSha: "aaa",
      originSha: "bbb",
      lockPid: 42,
      now: 1000,
    });
    const rec = store.getAttestation("station-1");
    expect(rec?.ok).toBe(1);
    expect(rec?.head_sha).toBe("aaa");
    expect(rec?.lock_pid).toBe(42);
  });

  it("records a DECLINE with the station's own words", () => {
    store.setAttestation({
      agentId: "station-2",
      ok: false,
      reason: "14 uncommitted files I don't recognise",
    });
    const rec = store.getAttestation("station-2");
    expect(rec?.ok).toBe(0);
    // this is the point of attestation over inspection: only the station knows
    expect(rec?.reason).toContain("don't recognise");
  });

  it("re-attesting replaces rather than accumulating", () => {
    store.setAttestation({ agentId: "station-1", ok: false, reason: "dirty" });
    store.setAttestation({ agentId: "station-1", ok: true });
    expect(store.allAttestations()).toHaveLength(1);
    expect(store.getAttestation("station-1")?.ok).toBe(1);
  });

  it("can be cleared when an event invalidates it", () => {
    store.setAttestation({ agentId: "station-1", ok: true });
    store.clearAttestation("station-1");
    expect(store.getAttestation("station-1")).toBeNull();
  });
});

describe("dispatchability", () => {
  const facts = { headSha: "aaa", originSha: "bbb", lockPid: 42 };

  function record(over: Partial<Parameters<typeof store.setAttestation>[0]> = {}) {
    store.setAttestation({
      agentId: "station-1",
      ok: true,
      headSha: "aaa",
      originSha: "bbb",
      lockPid: 42,
      now: 1000,
      ...over,
    });
    return store.getAttestation("station-1")!;
  }

  it("dispatchable when the attestation still matches reality", () => {
    expect(attestationValid(record(), facts).valid).toBe(true);
  });

  it("NOT dispatchable after the station's worktree moves", () => {
    expect(attestationValid(record(), { ...facts, headSha: "moved" }).valid).toBe(false);
  });

  it("NOT dispatchable after origin advances — the station is now behind", () => {
    expect(attestationValid(record(), { ...facts, originSha: "advanced" }).valid).toBe(false);
  });

  it("NOT dispatchable after the worktree lock changes hands", () => {
    expect(attestationValid(record(), { ...facts, lockPid: 99 }).valid).toBe(false);
  });

  it("NOT dispatchable when the station declined, however recently", () => {
    const declined = record({ ok: false, reason: "unrecognised stash" });
    expect(attestationValid(declined, facts).valid).toBe(false);
  });

  it("stays dispatchable while offline and unchanged", () => {
    // nothing ran, so nothing changed — don't make people boot stations to re-sign
    expect(attestationValid(record({ now: 1000 }), { ...facts, shiftStartedAt: 500 }).valid).toBe(true);
  });
});

describe("snapshot readiness — what the dashboard renders", () => {
  it("carries four states, not a boolean", async () => {
    const { buildSnapshot } = await import("../src/snapshot.js");
    store.registerAgent({ id: "station-1", cwd: "/x", pid: 1 });
    store.registerAgent({ id: "station-2", cwd: "/y", pid: 2 });
    store.registerAgent({ id: "station-3", cwd: "/z", pid: 3 });

    store.setAttestation({ agentId: "station-1", ok: true });
    store.setAttestation({ agentId: "station-2", ok: false, reason: "unrecognised stash" });
    // station-3 never attests

    const byId = new Map(buildSnapshot(store, Date.now(), env).agents.map((a) => [a.id, a]));
    expect(byId.get("station-1")?.ready).toBe("ready");
    expect(byId.get("station-2")?.ready).toBe("declined");
    expect(byId.get("station-3")?.ready).toBe("unattested");
  });

  it("relays the station's OWN words on a decline", async () => {
    const { buildSnapshot } = await import("../src/snapshot.js");
    store.registerAgent({ id: "station-2", cwd: "/y", pid: 2 });
    store.setAttestation({
      agentId: "station-2",
      ok: false,
      reason: "14 uncommitted files I don't recognise",
    });
    const agent = buildSnapshot(store, Date.now(), env).agents.find((a) => a.id === "station-2");
    // only the station knows this; the expo relaying it beats any inspection
    expect(agent?.readyReason).toContain("don't recognise");
  });

  it("never marks the expo unattested — only stations attest", async () => {
    const { buildSnapshot } = await import("../src/snapshot.js");
    store.registerAgent({ id: "expo", cwd: "/repo", pid: 9 });
    const expo = buildSnapshot(store, Date.now(), env).agents.find((a) => a.id === "expo");
    expect(expo?.ready).toBe("ready");
  });
});
