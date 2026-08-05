import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (pollUrl) {
      let cancelled = false;
      const poll = async (): Promise<void> => {
        setIsFetching(true);
        try {
          const res = await fetch(pollUrl);
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          const body = (await res.json()) as PublicSnapshot;
          if (cancelled) return;
          setSnapshot({ ...body, mode: "hosted" });
          setConnected(true);
          setLastError(null);
        } catch (err) {
          if (cancelled) return;
          setConnected(false);
          setLastError(err instanceof Error ? err.message : String(err));
        } finally {
          if (!cancelled) setIsFetching(false);
        }
      };
      void poll();
      const id = setInterval(() => void poll(), pollIntervalMs);
      return () => {
        cancelled = true;
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
