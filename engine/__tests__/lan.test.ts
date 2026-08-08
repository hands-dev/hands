import { describe, expect, it } from "vitest";
import { lanCandidates, pickLanAddress } from "../src/lan.js";
import type { NetworkInterfaceInfo } from "node:os";

function iface(address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family,
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  } as NetworkInterfaceInfo;
}

describe("lanCandidates", () => {
  it("finds non-internal IPv4 addresses only, across every interface", () => {
    const result = lanCandidates({
      lo0: [iface("127.0.0.1", "IPv4", true)],
      en0: [iface("192.168.1.42"), iface("fe80::1", "IPv6")],
    });
    expect(result).toEqual([{ address: "192.168.1.42", iface: "en0" }]);
  });

  it("returns nothing on an empty interface map", () => {
    expect(lanCandidates({})).toEqual([]);
  });

  it("skips an interface entry that's undefined (a real os.networkInterfaces() shape)", () => {
    expect(lanCandidates({ lo0: undefined })).toEqual([]);
  });
});

describe("pickLanAddress", () => {
  it("reports no address and no ambiguity when nothing is found", () => {
    expect(pickLanAddress({})).toEqual({ address: null, iface: null, candidates: [], ambiguous: false });
  });

  it("picks the only candidate, confidently", () => {
    const pick = pickLanAddress({ en0: [iface("192.168.1.42")] });
    expect(pick).toMatchObject({ address: "192.168.1.42", iface: "en0", ambiguous: false });
  });

  it("deprioritizes a Docker bridge in favor of a real interface — one real candidate is NOT ambiguous", () => {
    const pick = pickLanAddress({
      en0: [iface("192.168.1.42")],
      docker0: [iface("172.17.0.1")],
    });
    expect(pick).toMatchObject({ address: "192.168.1.42", iface: "en0", ambiguous: false });
    expect(pick.candidates).toHaveLength(2); // still reported, just not picked
  });

  it("deprioritizes a macOS VPN utun interface the same way", () => {
    const pick = pickLanAddress({
      en0: [iface("192.168.1.42")],
      utun4: [iface("10.8.0.5")],
    });
    expect(pick).toMatchObject({ address: "192.168.1.42", ambiguous: false });
  });

  it("is honestly ambiguous when two real-looking interfaces both have an address", () => {
    const pick = pickLanAddress({
      en0: [iface("192.168.1.42")],
      en1: [iface("10.0.0.5")],
    });
    expect(pick.ambiguous).toBe(true);
    expect(pick.candidates).toHaveLength(2);
    expect(["192.168.1.42", "10.0.0.5"]).toContain(pick.address); // picks one, but says so
  });

  it("falls back to a deprioritized candidate rather than reporting none, when it's all there is", () => {
    const pick = pickLanAddress({ docker0: [iface("172.17.0.1")] });
    expect(pick).toMatchObject({ address: "172.17.0.1", iface: "docker0", ambiguous: false });
  });
});
