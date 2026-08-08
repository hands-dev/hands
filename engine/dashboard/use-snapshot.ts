import { useEffect, useRef, useState } from "react";
import type { DashboardPayload } from "../src/serve.js";
import type { PublicSnapshot } from "../src/snapshot.js";

/**
 * The hosted equivalent of DashboardPayload — a PublicSnapshot read from a
 * hosted app's JSON route (itself reading dashboard.json off the books
 * repo), tagged so App.tsx can branch cleanly instead of guessing from
 * field absence.
 */
export type HostedDashboardPayload = PublicSnapshot & { mode: "hosted" };

const HOSTED_POLL_INTERVAL_MS = 30_000;

/**
 * A hosted payload route is someone else's server — cheap sanity check
 * before trusting the shape, so a wrong-shape 200 (misconfigured route,
 * an HTML error page served with a 200, a stale cached response) lands in
 * lastError instead of crashing every downstream component that assumes
 * these are arrays.
 */
function looksLikePublicSnapshot(body: unknown): body is PublicSnapshot {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    Array.isArray(b.questions) &&
    Array.isArray(b.tasks) &&
    Array.isArray(b.todos) &&
    Array.isArray(b.menu) &&
    Array.isArray(b.crafts) &&
    typeof b.counts === "object" &&
    b.counts !== null
  );
}

/**
 * Live kitchen state. Local mode (default): SSE — the server pushes the
 * full payload on every real change (plus once on connect); EventSource
 * handles reconnection. Hosted mode (opts.pollUrl set): the source data
 * itself only updates on the ~60s syncPush debounce, so there's no
 * freshness win from a server-push transport here — plain polling.
 */
export function useSnapshot(opts?: { pollUrl?: string; pollIntervalMs?: number }): {
  snapshot: DashboardPayload | HostedDashboardPayload | null;
  connected: boolean;
  isFetching: boolean;
  lastError: string | null;
} {
  const pollUrl = opts?.pollUrl;
  const pollIntervalMs = opts?.pollIntervalMs ?? HOSTED_POLL_INTERVAL_MS;

  const [snapshot, setSnapshot] = useState<DashboardPayload | HostedDashboardPayload | null>(null);
  const [connected, setConnected] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // A slow response from an earlier tick must not clobber a newer one —
  // abort whatever's in flight before starting the next poll.
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    if (pollUrl) {
      let cancelled = false;
      const poll = async (): Promise<void> => {
        inFlight.current?.abort();
        const controller = new AbortController();
        inFlight.current = controller;
        setIsFetching(true);
        try {
          const res = await fetch(pollUrl, { cache: "no-store", signal: controller.signal });
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          const body: unknown = await res.json();
          if (cancelled || controller.signal.aborted) return;
          if (!looksLikePublicSnapshot(body)) throw new Error("unexpected payload shape");
          setSnapshot({ ...body, mode: "hosted" });
          setConnected(true);
          setLastError(null);
        } catch (err) {
          if (cancelled || controller.signal.aborted) return;
          setConnected(false);
          setLastError(err instanceof Error ? err.message : String(err));
        } finally {
          if (!cancelled && inFlight.current === controller) setIsFetching(false);
        }
      };
      void poll();
      const id = setInterval(() => void poll(), pollIntervalMs);
      return () => {
        cancelled = true;
        inFlight.current?.abort();
        clearInterval(id);
      };
    }

    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        setSnapshot(JSON.parse(e.data as string) as DashboardPayload);
        setLastError(null);
      } catch {
        // a torn frame loses one update; the next push heals it
      }
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [pollUrl, pollIntervalMs]);

  return { snapshot, connected, isFetching, lastError };
}
