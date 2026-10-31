import { describe, expect, it } from "vitest";
import {
  ARTIFACT_FILE_NAMES,
  AskThreadSchema,
  CardIdSchema,
  CardPictureSchema,
  ChangeCardSchema,
  CheckCardIdSchema,
  ChecksV2ResponseSchema,
  EngagementStateSchema,
  HunkIdSchema,
  ProjectLearnResponseSchema,
  ProjectTechStackSchema,
  PublicCheckQuestionSchema,
  RecordEngagementRequestSchema,
  SessionStorySchema,
  SessionSummarySchema,
  StoredCheckQuestionSchema,
} from "./index";

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

function learnBase() {
  return {
    projectId: "prj_1",
    sessionCount: 1,
    checkedCount: 1,
    skippedCount: 0,
    notCheckedCount: 0,
    bucketTotals: {
      solid: 1,
      right_but_unsure: 0,
      confident_but_wrong: 0,
      wrong_and_knew_it: 0,
      never_looked: 0,
    },
    nextUp: [],
    weakAreas: [{ file: "billing/retry.ts", confidentWrong: 1, total: 1 }],
    sessions: [
      {
        sessionId: "ses_1",
        title: "Retry billing",
        summary: "One-line takeaway.",
        checkStatus: "checked",
        lastActivity: "2026-10-29T00:00:00.000Z",
        checksStatus: "completed",
        picture: [{ cardId: "h_0123456789abcdef", bucket: "solid", questionId: null }],
      },
    ],
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
  explanation: "It retries once, per the observed wrapper.",
};

describe("story-first contracts", () => {
  it("parses a minimal valid SessionStory", () => {
    const parsed = SessionStorySchema.parse(minimalStory({ cards: [minimalCard()] }));
    expect(parsed.cards).toHaveLength(1);
    expect(parsed.schemaVersion).toBe(1);
  });

  it("rejects an invalid verification badge", () => {
    const result = ChangeCardSchema.safeParse(minimalCard({ verification: "verified" }));
    expect(result.success).toBe(false);
  });

  it("parses a stored MCQ and strips the key through the public schema", () => {
    const stored = StoredCheckQuestionSchema.parse(storedMcq);
    expect(stored.format).toBe("mcq");

    const pub = PublicCheckQuestionSchema.parse(storedMcq);
    expect(pub.format).toBe("mcq");
    expect("correctOptionId" in pub).toBe(false);
    expect("distractorSources" in pub).toBe(false);
    expect("explanation" in pub).toBe(false);
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
      lastActivity: "2026-10-27T10:00:00.050Z",
      status: "finalized",
      captureQuality: "full",
      eventCount: 3,
      summary: "One-line takeaway.",
      summarySkeleton: false,
      checkStatus: "not_checked",
      highRiskCount: 0,
      captureState: "ready",
      changeCount: 0,
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
      lastActivity: "2026-10-27T10:00:00.050Z",
      status: "finalized",
      captureQuality: "full",
      eventCount: 3,
      summary: "One-line takeaway.",
      summarySkeleton: false,
      checkStatus: "done",
      highRiskCount: 0,
      captureState: "ready",
      changeCount: 0,
    });
    expect(bad.success).toBe(false);
  });

  it("enforces the canonical card ID shape (h_ + 16 hex)", () => {
    expect(CardIdSchema.safeParse("h_0123456789abcdef").success).toBe(true);
    expect(HunkIdSchema.safeParse("h_0123456789abcdef").success).toBe(true);
    for (const bad of [
      "src/retry.ts:0",
      "h_0123456789abcde",
      "h_0123456789abcdef0",
      "h_0123456789ABCDEF",
      "0123456789abcdef",
      "",
    ]) {
      expect(CardIdSchema.safeParse(bad).success).toBe(false);
      expect(HunkIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects cards with non-canonical ids", () => {
    expect(ChangeCardSchema.safeParse(minimalCard({ id: "src/retry.ts:0" })).success).toBe(false);
    expect(ChangeCardSchema.safeParse(minimalCard({ constituentHunkIds: ["nope"] })).success).toBe(
      false,
    );
    expect(
      ChangeCardSchema.safeParse(minimalCard({ constituentHunkIds: ["h_0123456789abcdef"] }))
        .success,
    ).toBe(true);
  });

  it("rejects non-canonical keys in the engagement tiers map", () => {
    expect(
      EngagementStateSchema.safeParse({
        sessionId: "ses_test",
        tiers: { "src/retry.ts:0": "seen" },
      }).success,
    ).toBe(false);
    expect(
      EngagementStateSchema.safeParse({
        sessionId: "ses_test",
        tiers: { h_0123456789abcdef: "engaged" },
      }).success,
    ).toBe(true);
  });

  it("accepts c_ and h_ card ids for checks/picture/threads", () => {
    expect(CheckCardIdSchema.safeParse("c_0123456789abcdef").success).toBe(true);
    expect(CheckCardIdSchema.safeParse("h_0123456789abcdef").success).toBe(true);
    for (const bad of ["x_0123456789abcdef", "c_0123456789ABCDEF", "", "src/a.ts"]) {
      expect(CheckCardIdSchema.safeParse(bad).success).toBe(false);
    }
    // Stored + public checks accept both; legacy h_ still passes.
    for (const cardId of ["h_0123456789abcdef", "c_0123456789abcdef"]) {
      expect(StoredCheckQuestionSchema.safeParse({ ...storedMcq, cardId }).success).toBe(true);
      expect(PublicCheckQuestionSchema.safeParse({ ...storedMcq, cardId }).success).toBe(true);
      expect(
        CardPictureSchema.safeParse({ cardId, bucket: "solid", questionId: null }).success,
      ).toBe(true);
    }
    expect(StoredCheckQuestionSchema.safeParse({ ...storedMcq, cardId: "nope" }).success).toBe(
      false,
    );
    // Ask threads carry the same widened reference.
    expect(
      AskThreadSchema.safeParse({
        schemaVersion: 1,
        sessionId: "ses_test",
        updatedAt: "2026-10-28T10:00:00.000Z",
        messages: [
          {
            id: "m1",
            role: "user",
            text: "why?",
            cardId: "c_0123456789abcdef",
            response: null,
            createdAt: "2026-10-28T10:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(true);
    // Story cards stay h_-only until the deletion slice.
    expect(ChangeCardSchema.safeParse(minimalCard({ id: "c_0123456789abcdef" })).success).toBe(
      false,
    );
  });

  it("pins the versioned artifact file layout", () => {
    expect(ARTIFACT_FILE_NAMES).toEqual({
      story: "story.json",
      checks_v2: "checks_v2.json",
      ask_thread: "ask_thread.json",
    });
  });

  it("requires schemaVersion 1 on the ask thread", () => {
    const base = { sessionId: "ses_test", updatedAt: "2026-10-28T10:00:00.000Z", messages: [] };
    expect(AskThreadSchema.safeParse(base).success).toBe(false);
    expect(AskThreadSchema.safeParse({ ...base, schemaVersion: 1 }).success).toBe(true);
  });

  it("bounds RecordEngagementRequest events to 1..100", () => {
    const one = {
      id: "e1",
      cardId: null,
      kind: "story_opened",
      occurredAt: "2026-10-28T10:00:00.000Z",
    };
    expect(RecordEngagementRequestSchema.safeParse({ events: [] }).success).toBe(false);
    expect(
      RecordEngagementRequestSchema.safeParse({
        events: Array.from({ length: 101 }, (_, i) => ({ ...one, id: `e${i}` })),
      }).success,
    ).toBe(false);
    expect(RecordEngagementRequestSchema.safeParse({ events: [one] }).success).toBe(true);
  });

  it("bounds project tech stack items to 8 with known kinds", () => {
    const base = {
      projectId: "prj_1",
      purpose: "Code review workspace.",
      items: [{ name: "TypeScript", kind: "language" }],
      generator: "model",
      generatedAt: "2026-10-29T00:00:00.000Z",
    };
    expect(ProjectTechStackSchema.safeParse(base).success).toBe(true);
    expect(
      ProjectTechStackSchema.safeParse({
        ...base,
        items: [{ name: "X", kind: "database" }],
      }).success,
    ).toBe(false);
    expect(
      ProjectTechStackSchema.safeParse({
        ...base,
        items: Array.from({ length: 9 }, (_, i) => ({ name: `Stack${i}`, kind: "data" })),
      }).success,
    ).toBe(false);
  });

  it("accepts a project learn payload with bucket totals", () => {
    expect(ProjectLearnResponseSchema.safeParse(learnBase()).success).toBe(true);
    expect(
      ProjectLearnResponseSchema.safeParse({
        ...learnBase(),
        bucketTotals: { ...learnBase().bucketTotals, solid: 2 },
      }).success,
    ).toBe(true);
    expect(ProjectLearnResponseSchema.safeParse({ ...learnBase(), sessions: "nope" }).success).toBe(
      false,
    );
    expect(
      ProjectLearnResponseSchema.safeParse({ ...learnBase(), bucketTotals: { solid: 1 } }).success,
    ).toBe(false);
    expect(
      ProjectLearnResponseSchema.safeParse({
        ...learnBase(),
        nextUp: [
          {
            sessionId: "ses_1",
            title: null,
            reason: "2 high-risk cards with no check yet",
            highRiskUnpictured: 2,
            neverLooked: 0,
            lastActivity: "2026-10-29T00:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(true);
  });
});
