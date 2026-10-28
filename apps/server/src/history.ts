import { existsSync, readFileSync } from "node:fs";
import {
  SessionHistoryResponseSchema,
  type SessionStory,
  SessionStorySchema,
} from "@echo/contracts";
import { type EchoDb, getArtifactRef, getSession, listSessions } from "@echo/db";

export interface HistoryOutcome {
  status: number;
  body: unknown;
}

export interface HistoryService {
  forSession(sessionId: string): HistoryOutcome;
}

function readStoryArtifact(path: string): SessionStory | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = SessionStorySchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createHistoryService(db: EchoDb, dataDir: string): HistoryService {
  // dataDir is accepted for API symmetry with story/checks services but is
  // unused: artifact paths come from the db ref, never reconstructed here.
  void dataDir;
  return {
    forSession(sessionId: string): HistoryOutcome {
      const session = getSession(db, sessionId);
      if (!session) {
        return {
          status: 404,
          body: { error: { code: "not_found", message: "unknown session" } },
        };
      }
      const currentRef = getArtifactRef(db, sessionId, "story");
      const currentStory = currentRef ? readStoryArtifact(currentRef.path) : null;
      if (!currentStory) {
        const body = { sessionId, entries: [] };
        // Defensive: the contract is the boundary, so a mismatch is a 500
        // even though the payload is constructed locally.
        const parsed = SessionHistoryResponseSchema.safeParse(body);
        if (!parsed.success) {
          return {
            status: 500,
            body: { error: { code: "redaction_failed", message: "history unavailable" } },
          };
        }
        return { status: 200, body: parsed.data };
      }
      const currentTouches = new Set<string>();
      for (const card of currentStory.cards) {
        for (const file of card.touches) currentTouches.add(file);
      }

      const entries: Array<{
        sessionId: string;
        summary: string | null;
        endedAt: string | null;
        sharedFiles: string[];
        matchNote: string;
        previousPicture: null;
      }> = [];
      // listSessions orders by updated_at DESC; scan at most 50 candidates.
      const candidates = listSessions(db, session.projectId)
        .filter((row) => row.id !== sessionId)
        .slice(0, 50);
      for (const row of candidates) {
        const ref = getArtifactRef(db, row.id, "story");
        if (!ref) continue;
        const story = readStoryArtifact(ref.path);
        if (!story) continue;
        const shared = new Set<string>();
        for (const card of story.cards) {
          for (const file of card.touches) {
            if (currentTouches.has(file)) shared.add(file);
          }
        }
        if (shared.size === 0) continue;
        const sharedFiles = [...shared].sort();
        const count = sharedFiles.length;
        entries.push({
          sessionId: row.id,
          summary: story.summary,
          endedAt: row.endedAt,
          sharedFiles,
          matchNote: `shares ${count} file${count === 1 ? "" : "s"} with this session's cards`,
          // Checks v2 lands Phase 5; card history carries no picture yet.
          previousPicture: null,
        });
      }
      entries.sort((a, b) => b.sharedFiles.length - a.sharedFiles.length);
      const body = { sessionId, entries: entries.slice(0, 10) };
      // Defensive: validate before responding so contract drift surfaces as
      // a 500 here instead of leaking an invalid payload to the client.
      const parsed = SessionHistoryResponseSchema.safeParse(body);
      if (!parsed.success) {
        return {
          status: 500,
          body: { error: { code: "redaction_failed", message: "history unavailable" } },
        };
      }
      return { status: 200, body: parsed.data };
    },
  };
}
