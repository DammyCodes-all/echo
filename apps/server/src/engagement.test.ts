import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngagementStateSchema } from "@echo/contracts";
import { type EchoDb, openEchoDb, upsertProject, upsertSession } from "@echo/db";
import { describe, expect, it } from "vitest";
import { createEngagementService } from "./engagement";

function seedSession(): { db: EchoDb; sessionId: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-engagement-"));
  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  const projectId = "prj_engagement";
  const sessionId = "ses_engagement";
  upsertProject(db, { id: projectId, root: dataDir, name: "engagement" });
  upsertSession(db, {
    id: sessionId,
    projectId,
    agent: "opencode",
    model: null,
    directory: dataDir,
    title: "engagement",
    startedAt: "2026-10-28T10:00:00.000Z",
    tapePath: join(dataDir, "tape.jsonl"),
    captureQuality: "partial",
  });
  return { db, sessionId };
}

const eventsBody = {
  events: [
    {
      id: "evt_story_opened",
      cardId: null,
      kind: "story_opened",
      occurredAt: "2026-10-28T10:00:00.000Z",
    },
    {
      id: "evt_seen_a",
      cardId: "card-a",
      kind: "card_seen",
      occurredAt: "2026-10-28T10:01:00.000Z",
    },
    {
      id: "evt_expanded_b",
      cardId: "card-b",
      kind: "card_expanded",
      occurredAt: "2026-10-28T10:02:00.000Z",
    },
  ],
};

describe("engagement service", () => {
  it("records events and derives tiers via state()", () => {
    const { db, sessionId } = seedSession();
    try {
      const service = createEngagementService(db);
      const recorded = service.record(sessionId, eventsBody);
      expect(recorded.status).toBe(200);
      expect(recorded.body).toEqual({ sessionId, inserted: 3 });

      const outcome = service.state(sessionId, ["card-a", "card-b", "card-c"]);
      expect(outcome.status).toBe(200);
      const parsed = EngagementStateSchema.parse(outcome.body);
      expect(parsed.tiers).toEqual({
        "card-a": "seen",
        "card-b": "engaged",
        "card-c": "unseen",
      });
    } finally {
      db.close();
    }
  });

  it("dedupes re-recorded event ids", () => {
    const { db, sessionId } = seedSession();
    try {
      const service = createEngagementService(db);
      expect(service.record(sessionId, eventsBody).body).toEqual({
        sessionId,
        inserted: 3,
      });
      const again = service.record(sessionId, eventsBody);
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ sessionId, inserted: 0 });
    } finally {
      db.close();
    }
  });

  it("returns 404 for unknown sessions", () => {
    const { db } = seedSession();
    try {
      const service = createEngagementService(db);
      const recorded = service.record("ses_missing", eventsBody);
      expect(recorded.status).toBe(404);
      expect(recorded.body).toEqual({
        error: { code: "not_found", message: "unknown session" },
      });
      const stateOutcome = service.state("ses_missing");
      expect(stateOutcome.status).toBe(404);
      expect(stateOutcome.body).toEqual({
        error: { code: "not_found", message: "unknown session" },
      });
    } finally {
      db.close();
    }
  });

  it("rejects an empty events array", () => {
    const { db, sessionId } = seedSession();
    try {
      const outcome = createEngagementService(db).record(sessionId, { events: [] });
      expect(outcome.status).toBe(400);
      expect(outcome.body).toEqual({
        error: {
          code: "invalid_request",
          message: expect.any(String),
        },
      });
    } finally {
      db.close();
    }
  });

  it("marks an explicitly requested but never recorded card as unseen", () => {
    const { db, sessionId } = seedSession();
    try {
      const service = createEngagementService(db);
      service.record(sessionId, eventsBody);
      const outcome = service.state(sessionId, ["card-a", "card-never"]);
      expect(outcome.status).toBe(200);
      const parsed = EngagementStateSchema.parse(outcome.body);
      expect(parsed.tiers["card-never"]).toBe("unseen");
    } finally {
      db.close();
    }
  });

  it("derives only recorded cards when no cardIds are given", () => {
    const { db, sessionId } = seedSession();
    try {
      const service = createEngagementService(db);
      service.record(sessionId, eventsBody);
      const outcome = service.state(sessionId);
      expect(outcome.status).toBe(200);
      const parsed = EngagementStateSchema.parse(outcome.body);
      expect(parsed.tiers).toEqual({ "card-a": "seen", "card-b": "engaged" });
    } finally {
      db.close();
    }
  });
});
