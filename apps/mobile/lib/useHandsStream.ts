import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import EventSource from "react-native-sse";
import type { MobileSnapshot } from "../types/hands-snapshot";
import { eventsUrl } from "./settings";

export interface HandsStreamState {
  snapshot: MobileSnapshot | null;
  connected: boolean;
  lastError: string | null;
}

/**
 * Holds the SSE connection to a local `hands serve` instance's /api/events
 * and survives disconnect/reconnect (hands#107). Two reconnect paths, for
 * two different failure modes:
 *
 * 1. react-native-sse's own poll timer (default 5s, verified in its source
 *    — engine/scripts don't apply here, this is a vendored RN lib) retries
 *    automatically whenever the underlying XHR reaches DONE, covering a
 *    plain network blip while the app stays foregrounded.
 * 2. That poll timer is a JS `setTimeout`, and RN suspends JS execution
 *    while backgrounded — a phone locking mid-connection doesn't get a
 *    graceful retry, it just stops. So on every foreground transition this
 *    hook tears down and opens a fresh EventSource unconditionally, rather
 *    than trusting whatever state the old connection silently ended up in.
 */
export function useHandsStream(host: string): HandsStreamState {
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      esRef.current?.close();
      setConnected(false);

      const es = new EventSource(eventsUrl(host));
      esRef.current = es;

      es.addEventListener("open", () => {
        if (cancelled) return;
        setConnected(true);
        setLastError(null);
      });

      es.addEventListener("message", (event) => {
        if (cancelled || event.data == null) return;
        try {
          setSnapshot(JSON.parse(event.data) as MobileSnapshot);
          setLastError(null);
        } catch {
          // a torn frame loses one update; the next push heals it — same
          // policy as the web dashboard's useSnapshot.ts
        }
      });

      es.addEventListener("error", (event) => {
        if (cancelled) return;
        setConnected(false);
        setLastError(event.type === "exception" ? String(event.message) : "connection error");
      });
    };

    connect();

    const onAppStateChange = (next: AppStateStatus) => {
      if (next === "active") connect();
    };
    const subscription = AppState.addEventListener("change", onAppStateChange);

    return () => {
      cancelled = true;
      subscription.remove();
      esRef.current?.close();
      esRef.current = null;
    };
  }, [host]);

  return { snapshot, connected, lastError };
}
