import {
  type SessionReview,
  SessionReviewSchema,
  SessionStorySchema,
  type StoredEvent,
} from "@echo/contracts";
import { describe, expect, it } from "vitest";
import { buildFacts, computeWatermark, skeletonStory } from "./story-facts";

const TS = "2026-10-28T10:00:00.000Z";

let seq = 0;

function makeEvent(
  overrides: Partial<StoredEvent> & { event_id: string; kind: string },
): StoredEvent {
  const event = {
    event_id: overrides.event_id,
    tape_seq: overrides.tape_seq ?? seq++,
    position_seq: overrides.position_seq ?? 0,
    record_key: null,
    kind: overrides.kind,
    ts: TS,
    observed_at: TS,
    tool_call_id: overrides.tool_call_id ?? null,
    payload: overrides.payload ?? {},
    redaction: { version: "v1", findings: 0 },
  };
  return event as StoredEvent;
}

function makeReview(overrides: Partial<SessionReview> = {}): SessionReview {
  return SessionReviewSchema.parse({
    sessionId: "s1",
    baselineCommit: "aaa",
    finalCommit: "bbb",
    hunks: [],
    attempts: [],
    evidenceByHunk: {},
    diagnostics: [],
    generatedAt: TS,
    ...overrides,
  });
}

function hunk(overrides: Record<string, unknown>) {
  return {
    id: "H1",
    path: "src/app.ts",
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 12,
    patch: "@@ -1,3 +1,12 @@\n+const x = 1;",
    addedText: "const x = 1;",
    removedText: "",
    addedLines: 12,
    removedLines: 3,
    riskScore: 0,
    riskReasons: [],
    ...overrides,
  };
}

describe("prompt clustering", () => {
  it("emits one cluster per prompt in tape order with 500-char truncation", () => {
    seq = 0;
    const events = [
      makeEvent({ event_id: "e1", kind: "prompt.submitted", payload: { text: "first" } }),
      makeEvent({
        event_id: "e2",
        kind: "tool.completed",
        payload: { command: "ls", exit_code: 0 },
      }),
      makeEvent({
        event_id: "e3",
        kind: "prompt.submitted",
        payload: { text: `second ${"x".repeat(600)}` },
      }),
    ];
    const facts = buildFacts(makeReview(), events);
    expect(facts.promptClusters.map((c) => c.id)).toEqual(["P1", "P2"]);
    expect(facts.promptClusters[0]?.promptEventId).toBe("e1");
    expect(facts.promptClusters[1]?.index).toBe(1);
    expect(facts.promptClusters[1]?.text.length).toBe(500);
    expect(facts.promptClusters[1]?.text.endsWith("…")).toBe(true);
  });
});

describe("blast taxonomy", () => {
  it("fires on payment paths and stays quiet on docs", () => {
    seq = 0;
    const review = makeReview({
      hunks: [
        hunk({ id: "H1", path: "billing/retry.ts", addedText: "charge(100);" }),
        hunk({ id: "H2", path: "docs/guide.md", addedText: "How to use the app." }),
      ],
    });
    const facts = buildFacts(review, []);
    const pay = facts.facts.find((f) => f.id === "H1");
    const docs = facts.facts.find((f) => f.id === "H2");
    expect(pay?.riskFlags).toContain("payments");
    expect(pay?.riskReasons[0]).toMatch(/payment/);
    expect(docs?.riskFlags).toEqual([]);
    expect(docs?.riskReasons).toEqual([]);
  });
});

describe("routine classification", () => {
  it("folds lockfiles, whitespace and comment-only patches but not real code", () => {
    seq = 0;
    const review = makeReview({
      hunks: [
        hunk({ id: "H1", path: "pnpm-lock.yaml", addedText: "lockfile v6" }),
        hunk({
          id: "H2",
          path: "src/a.ts",
          addedText: "   \n\t\n  ",
          removedText: " ",
          patch: "@@ -1 +1 @@\n- \n+   ",
          addedLines: 1,
          removedLines: 1,
        }),
        hunk({
          id: "H3",
          path: "src/b.ts",
          addedText: "// hello\n# world\n/* note */",
          removedText: "// old",
          patch: "x",
        }),
        hunk({ id: "H4", path: "src/c.ts", addedText: "export const x = 1;" }),
      ],
    });
    const facts = buildFacts(review, []);
    expect(new Set(facts.routineFactIds)).toEqual(new Set(["H1", "H2", "H3"]));
    for (const id of ["H1", "H2", "H3"]) {
      expect(facts.facts.find((f) => f.id === id)?.summary).toMatch(/\(routine: /);
    }
    expect(facts.facts.find((f) => f.id === "H4")?.summary).not.toMatch(/\(routine: /);
  });
});

describe("run to hunk linking", () => {
  function linkedReview() {
    return makeReview({
      hunks: [hunk({ id: "H1", path: "billing/retry.ts", addedText: "charge(100);" })],
      evidenceByHunk: {
        H1: [
          {
            relation: "introduced_by",
            confidence: "exact",
            snapshotId: null,
            eventId: "e-edit",
            toolCallId: null,
            detail: "edit",
          },
        ],
      },
    });
  }

  it("links a run after the hunk anchor that references the path", () => {
    seq = 0;
    const events = [
      makeEvent({
        event_id: "e-edit",
        kind: "tool.completed",
        payload: { command: "edit billing/retry.ts", exit_code: 0 },
      }),
      makeEvent({
        event_id: "e-run",
        kind: "tool.completed",
        payload: { command: "pnpm vitest billing/retry.ts", exit_code: 0 },
      }),
    ];
    const facts = buildFacts(linkedReview(), events);
    const h1 = facts.facts.find((f) => f.id === "H1");
    expect(h1?.testedByRunIds).toHaveLength(1);
    expect(h1?.verification).toBe("partly_observed");
  });

  it("does not link a run that occurred before the anchor", () => {
    seq = 0;
    const events = [
      makeEvent({
        event_id: "e-run",
        kind: "tool.completed",
        tape_seq: 0,
        payload: { command: "pnpm vitest billing/retry.ts", exit_code: 0 },
      }),
      makeEvent({
        event_id: "e-edit",
        kind: "tool.requested",
        tape_seq: 5,
        payload: { name: "edit", input: "billing/retry.ts" },
      }),
    ];
    const facts = buildFacts(linkedReview(), events);
    const h1 = facts.facts.find((f) => f.id === "H1");
    expect(h1?.testedByRunIds).toEqual([]);
    expect(h1?.verification).toBe("nothing");
  });
});

describe("skeleton story", () => {
  it("parses under SessionStorySchema with consistent verifiedCounts", () => {
    seq = 0;
    const review = makeReview({
      hunks: [
        hunk({ id: "H1", path: "billing/retry.ts", addedText: "charge(100);" }),
        hunk({ id: "H2", path: "pnpm-lock.yaml", addedText: "x" }),
      ],
      evidenceByHunk: {
        H1: [
          {
            relation: "introduced_by",
            confidence: "exact",
            snapshotId: null,
            eventId: "e-edit",
            toolCallId: null,
            detail: "edit",
          },
        ],
      },
      attempts: [
        {
          id: "att1",
          path: "billing/retry.ts",
          snapshotId: "snap1",
          commitOid: "ccc",
          trigger: "tool.post",
          eventId: "e-edit",
          takenAt: TS,
          status: "failed_with_side_effect",
          confidence: "exact",
          introducedLines: 1,
          survivingLines: 0,
          introducedText: ["charge(100);"],
          replacementText: [],
          finalStart: null,
          finalEnd: null,
          detail: "attempt broke the build",
          link: {
            eventId: "e-edit",
            toolCallId: null,
            toolOutcome: "failed",
            turnId: null,
            batchId: null,
          },
        },
      ],
    });
    const events = [
      makeEvent({
        event_id: "e0",
        kind: "prompt.submitted",
        payload: { text: "fix billing retry" },
      }),
      makeEvent({
        event_id: "e-edit",
        kind: "tool.completed",
        payload: { command: "edit billing/retry.ts", exit_code: 0 },
      }),
      makeEvent({
        event_id: "e-run",
        kind: "tool.completed",
        payload: { command: "pnpm vitest billing/retry.ts", exit_code: 0 },
      }),
    ];
    const facts = buildFacts(review, events);
    const story = skeletonStory({
      sessionId: "s1",
      facts,
      watermark: computeWatermark(events),
      captureQuality: "partial",
    });
    const parsed = SessionStorySchema.parse(story);
    expect(parsed.skeleton).toBe(true);
    expect(parsed.generator).toEqual({
      kind: "skeleton",
      model: null,
      promptVersion: "skeleton-v1",
    });
    expect(parsed.cards).toHaveLength(1);
    const counts = parsed.verifiedCounts;
    expect(counts.total).toBe(parsed.cards.length);
    expect(counts.observed + counts.partlyObserved + counts.agentStated + counts.nothing).toBe(
      counts.total,
    );
    expect(parsed.routineSummary).toMatch(/1 routine changes/);
    expect(parsed.detours[0]?.costReason).toBe("side_effect");
    expect(parsed.blindSpots).toContain("intermediate states may not be captured");
    expect(parsed.askVsResult.asked[0]).toMatchObject({ label: "agent_stated", factIds: ["P1"] });
  });
});

describe("watermark", () => {
  it("is deterministic and order-sensitive", () => {
    const a = [{ event_id: "e1" }, { event_id: "e2" }];
    const b = [{ event_id: "e2" }, { event_id: "e1" }];
    expect(computeWatermark(a)).toEqual(computeWatermark([{ event_id: "e1" }, { event_id: "e2" }]));
    expect(computeWatermark(a).eventCount).toBe(2);
    expect(computeWatermark(a).sha256).not.toBe(computeWatermark(b).sha256);
    expect(computeWatermark(a).sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
