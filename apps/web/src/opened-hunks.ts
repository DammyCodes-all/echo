const keyFor = (sessionId: string): string => `echo:opened-hunks:${sessionId}`;

function readKeys(sessionId: string): string[] {
  try {
    const raw = localStorage.getItem(keyFor(sessionId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** Records that a hunk was opened for review. Feeds Phase-5 targeting:
 *  checks go to the risky hunks never opened. localStorage only — no server
 *  round trip, no identity beyond the session. */
export function markHunkOpened(sessionId: string, hunkKey: string): void {
  try {
    const keys = readKeys(sessionId);
    if (!keys.includes(hunkKey)) {
      localStorage.setItem(keyFor(sessionId), JSON.stringify([...keys, hunkKey]));
    }
  } catch {
    // Engagement tracking is auxiliary; never break review on it.
  }
}

export function getOpenedHunks(sessionId: string): string[] {
  return readKeys(sessionId);
}

export function isHunkOpened(sessionId: string, hunkKey: string): boolean {
  return readKeys(sessionId).includes(hunkKey);
}
