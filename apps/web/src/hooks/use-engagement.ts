import type { EngagementEvent, EngagementKind } from "@echo/contracts";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../api";

export function useEngagement(sessionId: string): {
  track: (kind: EngagementKind, cardId?: string | null) => void;
} {
  const queue = useRef<EngagementEvent[]>([]);

  const track = useCallback((kind: EngagementKind, cardId: string | null = null) => {
    queue.current.push({
      id: crypto.randomUUID(),
      cardId,
      kind,
      occurredAt: new Date().toISOString(),
    });
  }, []);

  useEffect(() => {
    if (sessionId === "") return;
    const flush = () => {
      if (queue.current.length === 0) return;
      const events = queue.current;
      queue.current = [];
      // Engagement is best-effort telemetry: a failed flush is dropped silently.
      api.recordEngagement(sessionId, events).catch(() => undefined);
    };
    const timer = window.setInterval(flush, 5000);
    return () => {
      window.clearInterval(timer);
      flush();
    };
    // No sendBeacon: the endpoint expects an authenticated same-origin JSON
    // POST and provides no beacon counterpart, so a best-effort fetch on the
    // interval plus one final fetch on unmount is the whole strategy.
  }, [sessionId]);

  return { track };
}
