/**
 * A session must be event-silent this long before it counts as quiet.
 * Shared by the changes read-through liveness rule and the inbox
 * capture-state derivation so "still recording" means the same everywhere.
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
