/**
 * Parses a scanned QR payload into the same `host:port` shape the manual Settings field already
 * uses (hands#110) — `hands serve --lan` prints/encodes a plain `http://<lan-ip>:<port>/` URL (see
 * engine/src/lan.ts and cli.ts's `--lan` handling), the exact string you'd type into a browser on
 * that network. Reusing that format means pairing and the manual fallback share one representation
 * end to end: `setServerHost`/`eventsUrl` never need to know which path produced the host string.
 *
 * Returns null for anything that isn't a well-formed `http:` URL — a phone's camera can scan ANY
 * QR code, not just ones this app printed, and a mis-scan must fail visibly (the caller shows an
 * error and lets the user try again) rather than silently saving garbage into the host field.
 */
export function parsePairingPayload(raw: string): string | null {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !url.hostname) return null;
  const port = url.port || "4319";
  return `${url.hostname}:${port}`;
}
