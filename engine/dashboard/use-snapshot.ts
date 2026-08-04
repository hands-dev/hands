import { useEffect, useState } from "react";
import type { DashboardPayload } from "../src/serve.js";

/**
 * Live kitchen state over SSE. The server pushes the full payload on every
 * real change (plus once on connect); EventSource handles reconnection.
 */
export function useSnapshot(): { snapshot: DashboardPayload | null; connected: boolean } {
  const [snapshot, setSnapshot] = useState<DashboardPayload | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        setSnapshot(JSON.parse(e.data as string) as DashboardPayload);
      } catch {
        // a torn frame loses one update; the next push heals it
      }
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  return { snapshot, connected };
}
