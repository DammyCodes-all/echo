import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHistoryResponseSchema, SessionStorySchema } from "@echo/contracts";
import { type EchoDb, openEchoDb, upsertArtifactRef, upsertProject, upsertSession } from "@echo/db";
import { describe, expect, it } from "vitest";
import { createHistoryService } from "./history";

const ISO = "2026-10-28T10:00:00.000Z";

function makeStory(sessionId: string, summary: string, cardTouches: string[][]) {
  return SessionStorySchema.parse({
    schemaVersion: 1,
    sessionId,
    generatedAt: ISO,
    generator: { kind: "skeleton", model: null, promptVersion: "skeleton-v1" },
    tapeWatermark: { eventCount: 0, sha256: "abc" },
    summary,
    skeleton: true,
    shortVersion: [],
    askVsResult: { asked: [], delivered: [], extras: [], missing: [] },
    cards: cardTouches.map((touches, index) => ({
      id: `h_${String(index).padStart(16, "0")}`,
      headline: `card ${index}`,
      constituentHunkIds: [],
      constituentActionIds: [],
      rank: index + 1,
      sessionOrder: index,
      highRisk: false,
      riskReasons: [],
      verification: "nothing",
      why: [],
      before: [],
      now: [],
      checkedBy: [],
      touches,
      moment: { eventId: null, toolCallId: null, ts: null, excerpt: "x", label: "uncertain" },
      history: { priorSessionIds: [], previousPicture: null, note: null },
    })),
    routineSummary: null,
    detours: [],
    looseEnds: [],
    blindSpots: [],
    gaps: [],
    verifiedCounts: {
      observed: 0,
      partlyObserved: 0,
      agentStated: 0,
      nothing: cardTouches.length,
      total: cardTouches.length,
    },
  });
}

function seedStory(
  db: EchoDb,
  dataDir: string,
  projectId: string,
  sessionId: string,
  summary: string,
  cardTouches: string[][],
): void {
  upsertSession(db, {
    id: sessionId,
    projectId,
    agent: "opencode",
    model: null,
    directory: dataDir,
    title: sessionId,
    startedAt: ISO,
    tapePath: join(dataDir, `${sessionId}.jsonl`),
    captureQuality: "partial",
  });
  const story = makeStory(sessionId, summary, cardTouches);
  const path = join(
    dataDir,
    "projects",
    projectId,
    "sessions",
    sessionId,
    "artifacts",
    "story.json",
  );
  mkdirSync(join(dataDir, "projects", projectId, "sessions", sessionId, "artifacts"), {
    recursive: true,
  });
  writeFileSync(path, `${JSON.stringify(story, null, 2)}\n`);
  upsertArtifactRef(db, {
    sessionId,
    kind: "story",
    path,
    tapeWatermark: { eventCount: 0, sha256: "abc" },
    generator: "skeleton-v1",
    generatedAt: ISO,
  });
}

function seedDb(): { db: EchoDb; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-history-"));
  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  const projectId = "prj_history";
  upsertProject(db, { id: projectId, root: dataDir, name: "history" });
  seedStory(db, dataDir, projectId, "ses_current", "current work", [["a.ts", "b.ts", "c.ts"]]);
  seedStory(db, dataDir, projectId, "ses_overlap", "older work", [["b.ts", "c.ts", "d.ts"]]);
  seedStory(db, dataDir, projectId, "ses_other", "unrelated work", [["z.ts"]]);
  return { db, dataDir };
}

describe("history service", () => {
  it("returns overlapping sessions with shared files and a null picture", () => {
    const { db, dataDir } = seedDb();
    try {
      const outcome = createHistoryService(db, dataDir).forSession("ses_current");
      expect(outcome.status).toBe(200);
      const parsed = SessionHistoryResponseSchema.parse(outcome.body);
      expect(parsed.sessionId).toBe("ses_current");
      expect(parsed.entries).toHaveLength(1);
      const entry = parsed.entries.find((e) => e.sessionId === "ses_overlap");
      expect(entry).toEqual({
        sessionId: "ses_overlap",
        sharedFiles: ["b.ts", "c.ts"],
        matchNote: "shares 2 files with this session's cards",
        previousPicture: null,
        summary: "older work",
        endedAt: null,
      });
    } finally {
      db.close();
    }
  });

  it("excludes sessions with no touch overlap", () => {
    const { db, dataDir } = seedDb();
    try {
      const outcome = createHistoryService(db, dataDir).forSession("ses_current");
      expect(outcome.status).toBe(200);
      const parsed = SessionHistoryResponseSchema.parse(outcome.body);
      expect(parsed.entries.map((entry) => entry.sessionId)).not.toContain("ses_other");
    } finally {
      db.close();
    }
  });

  it("returns empty entries when the current session has no story artifact", () => {
    const { db, dataDir } = seedDb();
    try {
      upsertSession(db, {
        id: "ses_bare",
        projectId: "prj_history",
        agent: "opencode",
        model: null,
        directory: dataDir,
        title: "bare",
        startedAt: ISO,
        tapePath: join(dataDir, "ses_bare.jsonl"),
        captureQuality: "partial",
      });
      const outcome = createHistoryService(db, dataDir).forSession("ses_bare");
      expect(outcome.status).toBe(200);
      const parsed = SessionHistoryResponseSchema.parse(outcome.body);
      expect(parsed).toEqual({ sessionId: "ses_bare", entries: [] });
    } finally {
      db.close();
    }
  });

  it("returns 404 for unknown sessions", () => {
    const { db, dataDir } = seedDb();
    try {
      const outcome = createHistoryService(db, dataDir).forSession("ses_missing");
      expect(outcome.status).toBe(404);
      expect(outcome.body).toEqual({
        error: { code: "not_found", message: "unknown session" },
      });
    } finally {
      db.close();
    }
  });
});
