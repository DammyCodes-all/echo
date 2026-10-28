import type { ChangeCard, SessionStory, StoryClaim } from "@echo/contracts";
import { buildAllStorySessions, expectedFactsFor, type FixtureStorySession } from "@echo/fixtures";
import { describe, expect, it } from "vitest";
import {
  type AttemptFact,
  dropFailedClaims,
  extractFacts,
  type Fact,
  type FactSet,
  type HunkFact,
  type RunFact,
  validateStoryFacts,
} from "./index";

function factsFor(slug: string): { session: FixtureStorySession; facts: FactSet } {
  const session = buildAllStorySessions().find((entry) => entry.slug === slug);
  if (!session) throw new Error(`fixture session missing: ${slug}`);
  const facts = extractFacts({
    sessionId: session.sessionId,
    tape: session.tape,
    hunks: session.hunks,
    attempts: session.attempts,
  });
  return { session, facts };
}

function eventRefsOf(fact: Fact): string[] {
  switch (fact.kind) {
    case "prompt":
    case "agent_text":
    case "gap":
      return [fact.eventId];
    case "attempt":
      return fact.eventId === null ? [] : [fact.eventId];
    case "run":
      return fact.eventIds;
    default:
      return [];
  }
}

/** The hand labels cite tape event ids; the pipeline remaps them to F-facts. */
function remapFactIds(facts: FactSet, eventIds: string[]): string[] {
  return facts.facts
    .filter((fact) => eventRefsOf(fact).some((ref) => eventIds.includes(ref)))
    .map((fact) => fact.id);
}

function remapClaims(facts: FactSet, claims: StoryClaim[]): StoryClaim[] {
  return claims.map((claim) => ({ ...claim, factIds: remapFactIds(facts, claim.factIds) }));
}

/** A model draft shaped exactly like the hand labels, modulo fact ids. */
function draftFromLabels(slug: string): {
  session: FixtureStorySession;
  facts: FactSet;
  draft: SessionStory;
} {
  const { session, facts } = factsFor(slug);
  const expected = expectedFactsFor(session);
  const cards = expected.cards.map((card) => ({
    ...card,
    why: remapClaims(facts, card.why),
    before: remapClaims(facts, card.before),
    now: remapClaims(facts, card.now),
    checkedBy: remapClaims(facts, card.checkedBy),
  }));
  const draft: SessionStory = {
    schemaVersion: 1,
    sessionId: session.sessionId,
    generatedAt: "2026-10-28T12:00:00.000Z",
    generator: { kind: "skeleton", model: null, promptVersion: "test" },
    tapeWatermark: { eventCount: session.tape.length, sha256: "test" },
    summary: "Test story.",
    skeleton: true,
    shortVersion: [],
    askVsResult: { asked: [], delivered: [], extras: [], missing: [] },
    cards,
    routineSummary: expected.routineLine,
    detours: expected.detoursIn.map((detour) => ({
      ...detour,
      claims: remapClaims(facts, detour.claims),
    })),
    looseEnds: expected.looseEnds.map((looseEnd) => ({
      ...looseEnd,
      claims: remapClaims(facts, looseEnd.claims),
    })),
    blindSpots: expected.blindSpots,
    gaps: [],
    verifiedCounts: { observed: 0, partlyObserved: 0, agentStated: 0, nothing: 0, total: 0 },
  };
  return { session, facts, draft };
}

function minimalCard(overrides: Partial<ChangeCard> = {}): ChangeCard {
  return {
    id: "h_aaaaaaaaaaaaaaaa",
    headline: "Test card",
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
    moment: { eventId: null, toolCallId: null, ts: null, excerpt: "", label: "observed" },
    history: { priorSessionIds: [], previousPicture: null, note: null },
    ...overrides,
  };
}

function minimalDraft(overrides: Partial<SessionStory> = {}): SessionStory {
  return {
    schemaVersion: 1,
    sessionId: "ses_test",
    generatedAt: "2026-10-28T12:00:00.000Z",
    generator: { kind: "skeleton", model: null, promptVersion: "test" },
    tapeWatermark: { eventCount: 3, sha256: "test" },
    summary: "Test story.",
    skeleton: true,
    shortVersion: [],
    askVsResult: { asked: [], delivered: [], extras: [], missing: [] },
    cards: [],
    routineSummary: null,
    detours: [],
    looseEnds: [],
    blindSpots: [],
    gaps: [],
    verifiedCounts: { observed: 0, partlyObserved: 0, agentStated: 0, nothing: 0, total: 0 },
    ...overrides,
  };
}

function makeHunkFact(overrides: Partial<HunkFact> = {}): HunkFact {
  return {
    id: "F1",
    kind: "hunk",
    hunkId: "h_aaaaaaaaaaaaaaaa",
    path: "src/app.ts",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    addedLines: 1,
    removedLines: 1,
    addedText: "new",
    removedText: "old",
    mechanical: { class: null, reason: null },
    risk: {
      flags: [],
      unverifiedBoost: false,
      boostReasons: [],
      rewriteCount: 0,
      centrality: null,
    },
    passingRunObserved: true,
    ...overrides,
  };
}

function makeAttemptFact(overrides: Partial<AttemptFact> = {}): AttemptFact {
  return {
    id: "F2",
    kind: "attempt",
    attemptId: "att_aaaaaaaaaaaaaaaa",
    path: "src/app.ts",
    status: "landed",
    confidence: "exact",
    introducedLines: 1,
    survivingLines: 1,
    eventId: "evt_1",
    toolCallId: "call_1",
    trigger: "tool.post",
    takenAt: "2026-10-28T10:00:00.000Z",
    ...overrides,
  };
}

function factSet(facts: Fact[]): FactSet {
  return { sessionId: "ses_test", tapeEventCount: 3, facts };
}

describe("hand labels pass the validator", () => {
  it("accepts payment-retry as partly observed and high-risk", () => {
    const { facts, draft } = draftFromLabels("payment-retry");
    const result = validateStoryFacts(facts, draft);
    expect(result.verdicts.every((verdict) => verdict.valid)).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.story.cards).toHaveLength(1);
    expect(result.story.cards[0]).toMatchObject({
      verification: "partly_observed",
      highRisk: true,
    });
    expect(result.story.cards[0]?.riskReasons.join(" ")).toContain("payments");
    expect(result.story.verifiedCounts).toMatchObject({ partlyObserved: 1, total: 1 });
  });

  it("accepts the routine fold with zero cards", () => {
    const { facts, draft } = draftFromLabels("routine");
    const result = validateStoryFacts(facts, draft);
    expect(result.verdicts.every((verdict) => verdict.valid)).toBe(true);
    expect(result.story.verifiedCounts).toMatchObject({ total: 0 });
  });

  it("accepts the research session with zero cards", () => {
    const { facts, draft } = draftFromLabels("research");
    const result = validateStoryFacts(facts, draft);
    expect(result.verdicts.every((verdict) => verdict.valid)).toBe(true);
    expect(result.story.cards).toHaveLength(0);
  });

  it("accepts failed-deploy as nothing with a production flag", () => {
    const { facts, draft } = draftFromLabels("failed-deploy");
    const result = validateStoryFacts(facts, draft);
    expect(result.verdicts.every((verdict) => verdict.valid)).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.story.cards[0]).toMatchObject({ verification: "nothing", highRisk: true });
    expect(result.story.cards[0]?.riskReasons.join(" ")).toContain("production");
  });

  it("accepts partial-gap as partly observed with a validated blind spot", () => {
    const { facts, draft } = draftFromLabels("partial-gap");
    const result = validateStoryFacts(facts, draft);
    expect(result.verdicts.every((verdict) => verdict.valid)).toBe(true);
    expect(result.story.cards[0]).toMatchObject({
      verification: "partly_observed",
      highRisk: true,
    });
    expect(result.story.cards[0]?.riskReasons.join(" ")).toContain("stored_data");
  });

  it("accepts both multi-topic cards as observed without high risk", () => {
    const { facts, draft } = draftFromLabels("multi-topic");
    const result = validateStoryFacts(facts, draft);
    expect(result.verdicts.every((verdict) => verdict.valid)).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.story.cards.map((card) => card.verification)).toEqual(["observed", "observed"]);
    expect(result.story.cards.map((card) => card.highRisk)).toEqual([false, false]);
    expect(result.story.cards[0]?.riskReasons.join(" ")).toContain("src/home.ts");
    expect(result.story.verifiedCounts).toMatchObject({ observed: 2, total: 2 });
  });

  it("rejects the seeded retry-count contradiction", () => {
    const { facts } = factsFor("payment-retry");
    const run = facts.facts.find((fact): fact is RunFact => fact.kind === "run");
    if (!run) throw new Error("run fact missing");
    const draft = minimalDraft({
      sessionId: facts.sessionId,
      tapeWatermark: { eventCount: facts.tapeEventCount, sha256: "test" },
      shortVersion: [
        {
          text: "The retry loop attempts the charge 3 times",
          label: "observed",
          factIds: [run.id],
        },
      ],
    });
    const result = validateStoryFacts(facts, draft);
    const claims = result.verdicts.filter((verdict) => verdict.location.area === "shortVersion");
    expect(claims).toHaveLength(1);
    expect(claims[0]?.valid).toBe(false);
    expect(claims[0]?.errors.join(" ")).toContain("3");
  });
});

describe("claim checks", () => {
  it("rejects unknown fact ids, paths and quotes", () => {
    const facts = factSet([makeHunkFact({ addedText: "const x = 2;" })]);
    const draft = minimalDraft({
      shortVersion: [
        { text: "Changed `other.ts` twice", label: "observed", factIds: ["F1"] },
        { text: "Ghost evidence", label: "observed", factIds: ["F99"] },
        { text: "Says `const x = 2;`", label: "observed", factIds: ["F1"] },
      ],
    });
    const result = validateStoryFacts(facts, draft);
    const claims = result.verdicts.filter((verdict) => verdict.location.area === "shortVersion");
    expect(claims.map((verdict) => verdict.valid)).toEqual([false, false, true]);
    expect(claims[0]?.errors.join(" ")).toContain("other.ts");
    expect(claims[1]?.errors.join(" ")).toContain("F99");
  });

  it("accepts numbers that appear in the cited evidence", () => {
    const facts = factSet([makeHunkFact({ addedText: "retry 5 times", addedLines: 1 })]);
    const draft = minimalDraft({
      shortVersion: [{ text: "Retries up to 5 times", label: "observed", factIds: ["F1"] }],
    });
    const result = validateStoryFacts(facts, draft);
    expect(result.verdicts[0]?.valid).toBe(true);
  });

  it("does not match a number inside a longer number", () => {
    const facts = factSet([
      makeHunkFact({
        addedText: "delay 100ms",
        oldStart: 2,
        oldLines: 2,
        newStart: 2,
        newLines: 2,
        addedLines: 10,
        removedLines: 2,
      }),
    ]);
    const draft = minimalDraft({
      shortVersion: [{ text: "Waits 10 seconds", label: "observed", factIds: ["F1"] }],
    });
    const result = validateStoryFacts(facts, draft);
    // 10 matches the addedLines count exactly, so this passes; the guard is
    // that "1" alone would not match inside "100".
    expect(result.verdicts[0]?.valid).toBe(true);
    const narrow = minimalDraft({
      shortVersion: [{ text: "Waits 1 second", label: "observed", factIds: ["F1"] }],
    });
    const narrowResult = validateStoryFacts(facts, narrow);
    expect(narrowResult.verdicts[0]?.valid).toBe(false);
  });

  it("marks prompt-only cards agent-stated and uncertain-link cards partial", () => {
    const prompt = {
      id: "F1",
      kind: "prompt",
      eventId: "evt_p",
      tapeSeq: 1,
      text: "Do the thing",
    } as const;
    const facts = factSet([prompt]);
    const agentStated = minimalDraft({
      cards: [
        minimalCard({
          why: [{ text: "Asked to do the thing", label: "agent_stated", factIds: ["F1"] }],
        }),
      ],
    });
    expect(validateStoryFacts(facts, agentStated).story.cards[0]?.verification).toBe(
      "agent_stated",
    );

    const uncertain = factSet([
      makeHunkFact(),
      makeAttemptFact({ id: "F2", status: "uncertain", survivingLines: 0 }),
    ]);
    const partial = minimalDraft({
      cards: [
        minimalCard({
          constituentHunkIds: ["h_aaaaaaaaaaaaaaaa"],
          now: [{ text: "Changed the app", label: "observed", factIds: ["F1", "F2"] }],
        }),
      ],
    });
    expect(validateStoryFacts(uncertain, partial).story.cards[0]?.verification).toBe(
      "partly_observed",
    );
  });

  it("marks claimless cards as nothing", () => {
    const facts = factSet([makeHunkFact()]);
    const draft = minimalDraft({
      cards: [minimalCard({ constituentHunkIds: ["h_aaaaaaaaaaaaaaaa"] })],
    });
    expect(validateStoryFacts(facts, draft).story.cards[0]?.verification).toBe("nothing");
  });
});

describe("structure diagnostics", () => {
  it("reports dangling references and watermark drift", () => {
    const facts = factSet([makeHunkFact()]);
    const draft = minimalDraft({
      sessionId: "ses_other",
      tapeWatermark: { eventCount: 99, sha256: "test" },
      cards: [
        minimalCard({
          id: "h_bbbbbbbbbbbbbbbb",
          constituentHunkIds: ["h_cccccccccccccccc"],
          constituentActionIds: ["call_nope"],
          touches: ["src/missing.ts"],
          moment: {
            eventId: "evt_nope",
            toolCallId: "call_nope",
            ts: null,
            excerpt: "",
            label: "observed",
          },
        }),
      ],
      detours: [
        {
          id: "detour_1",
          headline: "Detour",
          claims: [],
          attemptIds: ["att_nope"],
          costReason: "reverted",
        },
      ],
      looseEnds: [{ id: "le_1", kind: "todo", claims: [], cardId: "h_nope" }],
    });
    const result = validateStoryFacts(facts, draft);
    expect(result.diagnostics.join("\n")).toContain("ses_other");
    expect(result.diagnostics.join("\n")).toContain("99");
    expect(result.diagnostics.join("\n")).toContain("h_cccccccccccccccc");
    expect(result.diagnostics.join("\n")).toContain("call_nope");
    expect(result.diagnostics.join("\n")).toContain("src/missing.ts");
    expect(result.diagnostics.join("\n")).toContain("evt_nope");
    expect(result.diagnostics.join("\n")).toContain("att_nope");
    expect(result.diagnostics.join("\n")).toContain("h_nope");
  });
});

describe("dropFailedClaims", () => {
  it("drops failed claims to gap lines and keeps the rest", () => {
    const facts = factSet([makeHunkFact({ addedText: "const x = 2;" })]);
    const draft = minimalDraft({
      cards: [
        minimalCard({
          constituentHunkIds: ["h_aaaaaaaaaaaaaaaa"],
          now: [
            { text: "Sets x to 2", label: "observed", factIds: ["F1"] },
            { text: "Sets x to 99", label: "observed", factIds: ["F1"] },
          ],
        }),
      ],
      blindSpots: ["Claims 7 files changed"],
    });
    const validation = validateStoryFacts(facts, draft);
    expect(validation.verdicts.filter((verdict) => !verdict.valid)).toHaveLength(2);
    const dropped = dropFailedClaims(validation);
    expect(dropped.dropped).toHaveLength(2);
    expect(dropped.story.cards[0]?.now.map((claim) => claim.text)).toEqual(["Sets x to 2"]);
    expect(dropped.story.blindSpots).toEqual([]);
    expect(dropped.story.gaps).toEqual([
      "Echo couldn't verify this: Sets x to 99",
      "Echo couldn't verify this: Claims 7 files changed",
    ]);
    expect(dropped.diagnostics).toEqual([]);
  });

  it("keeps a failing summary with a diagnostic", () => {
    const facts = factSet([makeHunkFact()]);
    const draft = minimalDraft({ summary: "Changed 99 files." });
    const dropped = dropFailedClaims(validateStoryFacts(facts, draft));
    expect(dropped.story.summary).toBe("Changed 99 files.");
    expect(dropped.dropped).toHaveLength(0);
    expect(dropped.diagnostics.join(" ")).toContain("summary");
  });
});
