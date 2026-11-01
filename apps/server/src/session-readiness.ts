import { createHash } from "node:crypto";
import type { TapeWatermark } from "@echo/contracts";

// Quietness lives in @echo/contracts now: the inbox capture-state
// derivation in @echo/db shares the rule and cannot import the server.
export { isSessionQuiet, SESSION_QUIET_MS } from "@echo/contracts";

/** Watermark over the ordered tape: event count plus sha256 of event ids. */
export function computeWatermark(events: Array<{ event_id: string }>): TapeWatermark {
  const sha256 = createHash("sha256")
    .update(events.map((event) => event.event_id).join("\n"))
    .digest("hex");
  return { eventCount: events.length, sha256 };
}
