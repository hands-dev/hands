import * as os from "node:os";

/**
 * LAN-address detection for `hands serve --lan` (hands#110). `serve()` binds to a wildcard host
 * (0.0.0.0) so a phone on the network can reach it, but 0.0.0.0 itself is not a connectable
 * address — a phone needs the machine's actual LAN-facing IPv4 address to put in a QR code or
 * type manually. A machine can have several interfaces (Wi-Fi, Ethernet, a VPN, Docker/container
 * bridges), so picking one is a guess; this module is honest about that rather than asserting
 * confidence it doesn't have. Never silently encodes a wrong guess into a QR someone scans — that
 * fails invisibly from the scanning side, the exact shape of bug this repo has spent effort
 * eliminating elsewhere.
 */

export interface LanCandidate {
  address: string;
  iface: string;
}

/**
 * Interface name patterns that are almost never the LAN a phone shares: VPN tunnels, container
 * bridges, and macOS's own low-power/peer-to-peer interfaces. Not exhaustive — a deprioritization
 * heuristic, not a filter that's trusted to be complete. `pickLanAddress` still reports every
 * candidate so a caller can see (and override) the guess.
 */
const DEPRIORITIZED_IFACE_RE = /^(docker|veth|br-|utun|tun\d|tailscale|wg|virbr|vmnet|anpi|awdl|llw)/i;

/** Every non-internal IPv4 address on the machine, across all interfaces. */
export function lanCandidates(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): LanCandidate[] {
  const out: LanCandidate[] = [];
  for (const [iface, infos] of Object.entries(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      if (info.family === "IPv4" && !info.internal) out.push({ address: info.address, iface });
    }
  }
  return out;
}

export interface LanPick {
  /** null when no usable candidate exists at all — say so, never fall back to a guess */
  address: string | null;
  iface: string | null;
  candidates: LanCandidate[];
  /** true when more than one plausible (non-deprioritized) interface was found — the pick is a guess */
  ambiguous: boolean;
}

/**
 * Picks ONE address to encode in a pairing QR/URL. `ambiguous` reflects the PREFERRED pool (after
 * deprioritizing obvious VPN/container interfaces), not the raw candidate count — a machine with
 * one real Wi-Fi interface and a Docker bridge isn't ambiguous, it's confident once the bridge is
 * filtered out. Only true multi-interface ties (two Ethernet ports, Wi-Fi + Ethernet both up) are
 * reported as ambiguous, so a caller can say so plainly and offer an override rather than assert
 * false confidence.
 */
export function pickLanAddress(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): LanPick {
  const candidates = lanCandidates(interfaces);
  if (candidates.length === 0) return { address: null, iface: null, candidates, ambiguous: false };
  const preferred = candidates.filter((c) => !DEPRIORITIZED_IFACE_RE.test(c.iface));
  const pool = preferred.length > 0 ? preferred : candidates;
  const first = pool[0]!;
  return { address: first.address, iface: first.iface, candidates, ambiguous: pool.length > 1 };
}
