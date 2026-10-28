import { describe, expect, it } from "vitest";
import {
  ChangeCardSchema,
  ChecksV2ResponseSchema,
  PublicCheckQuestionSchema,
  RecordEngagementRequestSchema,
  SessionStorySchema,
  SessionSummarySchema,
  StoredCheckQuestionSchema,
} from "./index";

const claim = { text: "The retry wrapper landed.", label: "observed", factIds: ["F1"] };

function minimalCard(overrides: Record<string, unknown> = {}) {
  return {
    id: "h_0123456789abcdef",
    headline: "Added a retry wrapper",
    constituentHunkIds: [],
    constituentActionIds: [],
    rank: 1,
    sessionOrder: 0,
    highRisk: false,
    riskReasons: [],
    verification: "observed",
    why: [],
    before: [],
    now: [],
    checkedBy: [],
    touches: [],
    moment: {
      eventId: null,
      toolCallId: null,
      ts: null,
      excerpt: "",
      label: "observed",
    },
    history: { priorSessionIds: [], previousPicture: null, note: null },
    ...overrides,
  };
}

function minimalStory(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sessionId: "ses_test",
    generatedAt: "2026-10-28T10:00:00.000Z",
    generator: { kind: "skeleton", model: null, promptVersion: "skeleton-v1" },
    tapeWatermark: { eventCount: 0, sha256: "abc" },
    summary: "One-line takeaway.",
    skeleton: true,
    shortVersion: [],
    askVsResult: { asked: [], delivered: [], extras: [], missing: [] },
    cards: [],
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
      total: 0,
    },
    ...overrides,
  };
}

const storedMcq = {
  format: "mcq",
  id: "q1",
  cardId: "h_0123456789abcdef",
  kind: "consequence",
  question: "What happens on retry?",
  evidenceFactIds: ["F1"],
  evidencePaths: ["src/retry.ts"],
  options: [
    { id: "opt_a", text: "It retries once" },
    { id: "opt_b", text: "It gives up" },
  ],
  correctOptionId: "opt_a",
  distractorSources: ["reverted attempt A2"],
};

describe("story-first contracts", () => {
  it("parses a minimal valid SessionStory", () => {
    const parsed = SessionStorySchema.parse(minimalStory({ cards: [minimalCard()] }));
    expect(parsed.cards).toHaveLength(1);
    expect(parsed.schemaVersion).toBe(1);
  });

  it("rejects an invalid verification badge", () => {
    const result = ChangeCardSchema.safeParse(
      minimalCard({ verification: "verified" }),
    );
    expect(result.success).toBe(false);
  });

  it("parses a stored MCQ and strips the key through the public schema", () => {
    const stored = StoredCheckQuestionSchema.parse(storedMcq);
    expect(stored.format).toBe("mcq");

    const pub = PublicCheckQuestionSchema.parse(storedMcq);
    expect(pub.format).toBe("mcq");
    expect("correctOptionId" in pub).toBe(false);
    expect("distractorSources" in pub).toBe(false);
    expect("rubric" in pub).toBe(false);
    if (pub.format === "mcq") {
      expect(pub.options).toHaveLength(2);
    }
  });

  it("parses a ChecksV2Response without brier anywhere", () => {
    const parsed = ChecksV2ResponseSchema.parse({
      schemaVersion: 1,
      sessionId: "ses_test",
      status: "offered",
      generatedAt: "2026-10-28T10:00:00.000Z",
      tapeWatermark: { eventCount: 0, sha256: "abc" },
      questions: [
        {
          format: "mcq",
          id: "q1",
          cardId: "h_0123456789abcdef",
          kind: "consequence",
          question: "What happens on retry?",
          evidenceFactIds: ["F1"],
          evidencePaths: ["src/retry.ts"],
          options: [
            { id: "opt_a", text: "It retries once" },
            { id: "opt_b", text: "It gives up" },
          ],
        },
      ],
      attempts: [
        {
          id: "a1",
          questionId: "q1",
          confidence: "certain",
          selectedOptionId: "opt_a",
          answerText: null,
          correct: true,
          bucket: "solid",
          rubricHits: [],
          evidence: [],
          createdAt: "2026-10-28T10:01:00.000Z",
        },
      ],
      picture: [],
      currentQuestionId: null,
    });
    expect(parsed.questions).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain("brier");
  });

  it("parses the extended SessionSummary and rejects a bad checkStatus", () => {
    const parsed = SessionSummarySchema.parse({
      id: "ses_test",
      projectId: "prj_test",
      title: null,
      model: null,
      directory: null,
      startedAt: null,
      endedAt: null,
      status: "finalized",
      captureQuality: "full",
      eventCount: 3,
      summary: "One-line takeaway.",
      checkStatus: "not_checked",
      highRiskCount: 0,
      captureState: "ready",
    });
    expect(parsed.checkStatus).toBe("not_checked");

    const bad = SessionSummarySchema.safeParse({
      id: "ses_test",
      projectId: "prj_test",
      title: null,
      model: null,
      directory: null,
      startedAt: null,
      endedAt: null,
      status: "finalized",
      captureQuality: "full",
      eventCount: 3,
      summary: "One-line takeaway.",
      checkStatus: "done",
      highRiskCount: 0,
      captureState: "ready",
    });
    expect(bad.success).toBe(false);
  });

  it("bounds RecordEngagementRequest events to 1..100", () => {
    const one = {
      id: "e1",
      cardId: null,
      kind: "story_opened",
      occurredAt: "2026-10-28T10:00:00.000Z",
    };
    expect(RecordEngagementRequestSchema.safeParse({ events: [] }).success).toBe(
      false,
    );
    expect(
      RecordEngagementRequestSchema.safeParse({
        events: Array.from({ length: 101 }, (_, i) => ({ ...one, id: `e${i}` })),
      }).success,
    ).toBe(false);
    expect(
      RecordEngagementRequestSchema.safeParse({ events: [one] }).success,
    ).toBe(true);
  });
});
