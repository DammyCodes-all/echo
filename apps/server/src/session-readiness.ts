import { createHash } from "node:crypto";
import type { TapeWatermark } from "@echo/contracts";

/**
 * A session must be event-silent this long before it counts as quiet.
 * Previously the story gate; now the changes read-through liveness rule.
 */
export const SESSION_QUIET_MS = 60_000;

/**
 * True when the tape's latest event is old enough (or there are no events at
 * all — nothing recorded means nothing to wait for). Unparseable timestamps
 * fail open: corrupt clocks shouldn't silence a session.
 */
export function isSessionQuiet(
  lastObservedAt: string | null,
  nowMs: number,
  quietMs: number = SESSION_QUIET_MS,
): boolean {
  if (lastObservedAt === null) return true;
  const last = Date.parse(lastObservedAt);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= quietMs;
}

/** Watermark over the ordered tape: event count plus sha256 of event ids. */
export function computeWatermark(events: Array<{ event_id: string }>): TapeWatermark {
  const sha256 = createHash("sha256")
    .update(events.map((event) => event.event_id).join("\n"))
    .digest("hex");
  return { eventCount: events.length, sha256 };
}
