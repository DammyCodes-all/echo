import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ChangeCard, ProjectLearnResponseSchema, type SessionStory } from "@echo/contracts";
import {
  type EchoDb,
  openEchoDb,
  setSessionCheckStatus,
  upsertArtifactRef,
  upsertProject,
  upsertSession,
} from "@echo/db";
import { describe, expect, it } from "vitest";
import { createLearnService } from "./learn";

const PROJECT_ID = "prj_learn";
const ISO = "2026-10-29T12:00:00.000Z";

function seedDb(): { db: EchoDb; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-learn-data-"));
  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  upsertProject(db, { id: PROJECT_ID, root: "/repo", name: "learn" });
  return { db, dataDir };
}

function addSession(db: EchoDb, dataDir: string, sessionId: string): void {
  upsertSession(db, {
    id: sessionId,
    projectId: PROJECT_ID,
    agent: "opencode",
    model: null,
    directory: "/repo",
    title: `Title ${sessionId}`,
    startedAt: ISO,
    tapePath: join(dataDir, `${sessionId}.jsonl`),
    captureQuality: "full",
  });
}

function makeCard(id: string, touches: string[], highRisk = false): ChangeCard {
  return {
    id,
    headline: `Change ${id}.`,
    constituentHunkIds: [],
    constituentActionIds: [],
    rank: 1,
    sessionOrder: 0,
    highRisk,
    riskReasons: [],
    verification: "observed",
    why: [],
    before: [],
    now: [],
    checkedBy: [],
    touches,
    moment: {
      eventId: null,
      toolCallId: null,
      ts: null,
      excerpt: `Change ${id}.`,
      label: "uncertain",
    },
    history: { priorSessionIds: [], previousPicture: null, note: null },
  };
}

function writeStory(db: EchoDb, dataDir: string, sessionId: string, cards: ChangeCard[]): void {
  const story: SessionStory = {
    schemaVersion: 1,
    sessionId,
    generatedAt: ISO,
    generator: { kind: "skeleton", model: null, promptVersion: "skeleton-v1" },
    tapeWatermark: { eventCount: 0, sha256: "abc" },
    summary: `Summary ${sessionId}.`,
    skeleton: true,
    shortVersion: [],
    askVsResult: { asked: [], delivered: [], extras: [], missing: [] },
    cards,
    routineSummary: null,
    detours: [],
    looseEnds: [],
    blindSpots: [],
    gaps: [],
    verifiedCounts: {
      observed: 0,
      partlyObserved: 0,
      agentStated: 0,
      nothing: 0,
      total: cards.length,
    },
  };
  const path = join(
    dataDir,
    "projects",
    PROJECT_ID,
    "sessions",
    sessionId,
    "artifacts",
    "story.json",
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(story));
  upsertArtifactRef(db, {
    sessionId,
    kind: "story",
    path,
    tapeWatermark: story.tapeWatermark,
    generator: "skeleton-v1",
    generatedAt: ISO,
  });
}

function writeChecks(
  db: EchoDb,
  dataDir: string,
  sessionId: string,
  status: "completed" | "in_progress",
  picture: Array<{ cardId: string; bucket: string; questionId: string | null }>,
): void {
  const artifact = {
    schemaVersion: 1,
    sessionId,
    status,
    generatedAt: ISO,
    tapeWatermark: { eventCount: 0, sha256: "abc" },
    questions: [],
    attempts: [],
    picture,
    currentQuestionId: null,
  };
  const path = join(
    dataDir,
    "projects",
    PROJECT_ID,
    "sessions",
    sessionId,
    "artifacts",
    "checks_v2.json",
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(artifact));
  upsertArtifactRef(db, {
    sessionId,
    kind: "checks_v2",
    path,
    tapeWatermark: artifact.tapeWatermark,
    generator: "check-v1",
    generatedAt: ISO,
  });
}

describe("learn service", () => {
  it("returns 404 for an unknown project", () => {
    const { db, dataDir } = seedDb();
    try {
      const outcome = createLearnService({ db, dataDir }).summary("prj_missing");
      expect(outcome.status).toBe(404);
    } finally {
      db.close();
    }
  });

  it("aggregates buckets and weak areas across sessions", () => {
    const { db, dataDir } = seedDb();
    try {
      addSession(db, dataDir, "ses_a");
      addSession(db, dataDir, "ses_b");
      writeStory(db, dataDir, "ses_a", [makeCard("h_aaaaaaaaaaaaaaaa", ["billing/retry.ts"])]);
      writeStory(db, dataDir, "ses_b", [makeCard("h_bbbbbbbbbbbbbbbb", ["billing/retry.ts"])]);
      writeChecks(db, dataDir, "ses_a", "completed", [
        { cardId: "h_aaaaaaaaaaaaaaaa", bucket: "confident_but_wrong", questionId: null },
      ]);
      writeChecks(db, dataDir, "ses_b", "completed", [
        { cardId: "h_bbbbbbbbbbbbbbbb", bucket: "solid", questionId: null },
      ]);
      setSessionCheckStatus(db, "ses_a", "checked");
      setSessionCheckStatus(db, "ses_b", "checked");

      const outcome = createLearnService({ db, dataDir }).summary(PROJECT_ID);
      expect(outcome.status).toBe(200);
      const parsed = ProjectLearnResponseSchema.parse(outcome.body);
      expect(parsed.sessionCount).toBe(2);
      expect(parsed.checkedCount).toBe(2);
      expect(parsed.bucketTotals.confident_but_wrong).toBe(1);
      expect(parsed.bucketTotals.solid).toBe(1);
      expect(parsed.weakAreas).toEqual([{ file: "billing/retry.ts", confidentWrong: 1, total: 2 }]);
      expect(parsed.sessions).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("reports zero checked with an empty message payload", () => {
    const { db, dataDir } = seedDb();
    try {
      addSession(db, dataDir, "ses_fresh");
      const outcome = createLearnService({ db, dataDir }).summary(PROJECT_ID);
      expect(outcome.status).toBe(200);
      const parsed = ProjectLearnResponseSchema.parse(outcome.body);
      expect(parsed.checkedCount).toBe(0);
      expect(parsed.weakAreas).toEqual([]);
      expect(parsed.sessions[0]?.checksStatus).toBe("none");
    } finally {
      db.close();
    }
  });

  it("survives corrupt artifacts as gaps, not 500s", () => {
    const { db, dataDir } = seedDb();
    try {
      addSession(db, dataDir, "ses_rot");
      const bad = join(
        dataDir,
        "projects",
        PROJECT_ID,
        "sessions",
        "ses_rot",
        "artifacts",
        "checks_v2.json",
      );
      mkdirSync(dirname(bad), { recursive: true });
      writeFileSync(bad, "{ not json");
      const outcome = createLearnService({ db, dataDir }).summary(PROJECT_ID);
      expect(outcome.status).toBe(200);
      const parsed = ProjectLearnResponseSchema.parse(outcome.body);
      expect(parsed.sessions[0]?.picture).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("queues not-checked high-risk sessions first, capped at 5", () => {
    const { db, dataDir } = seedDb();
    try {
      for (let i = 0; i < 7; i += 1) addSession(db, dataDir, `ses_q${i}`);
      for (let i = 0; i < 7; i += 1) {
        writeStory(db, dataDir, `ses_q${i}`, [
          makeCard("h_aaaaaaaaaaaaaaaa", ["billing/retry.ts"], true),
        ]);
      }
      // Checked and skipped sessions never queue, even with risky cards.
      setSessionCheckStatus(db, "ses_q5", "checked");
      setSessionCheckStatus(db, "ses_q6", "skipped");

      const outcome = createLearnService({ db, dataDir }).summary(PROJECT_ID);
      expect(outcome.status).toBe(200);
      const parsed = ProjectLearnResponseSchema.parse(outcome.body);
      expect(parsed.nextUp).toHaveLength(5);
      expect([...parsed.nextUp.map((entry) => entry.sessionId)].sort()).toEqual([
        "ses_q0",
        "ses_q1",
        "ses_q2",
        "ses_q3",
        "ses_q4",
      ]);
      expect(parsed.nextUp[0]).toMatchObject({
        highRiskUnpictured: 1,
        reason: "1 high-risk card with no check yet",
      });
    } finally {
      db.close();
    }
  });

  it("queues never-looked sessions behind unpictured high-risk ones", () => {
    const { db, dataDir } = seedDb();
    try {
      addSession(db, dataDir, "ses_risk");
      addSession(db, dataDir, "ses_seen");
      writeStory(db, dataDir, "ses_risk", [
        makeCard("h_aaaaaaaaaaaaaaaa", ["billing/retry.ts"], true),
      ]);
      writeStory(db, dataDir, "ses_seen", [makeCard("h_bbbbbbbbbbbbbbbb", ["docs/readme.md"])]);
      writeChecks(db, dataDir, "ses_seen", "in_progress", [
        { cardId: "h_bbbbbbbbbbbbbbbb", bucket: "never_looked", questionId: null },
      ]);

      const outcome = createLearnService({ db, dataDir }).summary(PROJECT_ID);
      expect(outcome.status).toBe(200);
      const parsed = ProjectLearnResponseSchema.parse(outcome.body);
      expect(parsed.nextUp.map((entry) => entry.sessionId)).toEqual(["ses_risk", "ses_seen"]);
      expect(parsed.nextUp[1]?.reason).toBe("1 card never looked at");
    } finally {
      db.close();
    }
  });
});
