import {
  type SessionReview,
  SessionReviewSchema,
  SessionStorySchema,
  type StoredEvent,
  type TapeEvent,
} from "@echo/contracts";
import { describe, expect, it } from "vitest";
// Test-only relative import: @echo/fixtures is not a server dependency and the
// slice may not add one, so reach the builders directly instead of via package.
import * as fixtureBuilders from "../../../packages/fixtures/src/index.js";
import { validateDraft } from "./story";
import { buildFacts, computeWatermark, type FactSet, skeletonStory } from "./story-facts";

function toStored(event: TapeEvent): StoredEvent {
  const links = event.links as { tool_call_id?: unknown } | null;
  return {
    event_id: event.event_id,
    tape_seq: event.tape_seq,
    position_seq: 0,
    record_key: event.record_key,
    kind: event.kind,
    ts: event.ts,
    observed_at: event.observed_at,
    tool_call_id: typeof links?.tool_call_id === "string" ? links.tool_call_id : null,
    payload: event.payload,
    redaction: { version: event.redaction.version, findings: event.redaction.findings },
  };
}

// Eval shortcut, documented: production reviews come from shadow-git diffs via
// buildSessionReview. Here each write-requested tape path becomes one hunk, so
// the skeleton pipeline can run over every fixture tape shape without git.
function reviewFromTape(sessionId: string, tape: TapeEvent[]): SessionReview {
  const byPath = new Map<string, TapeEvent[]>();
  for (const event of tape) {
    if (event.kind !== "tool.requested") continue;
    const payload = event.payload as { name?: unknown; input?: unknown } | null;
    if (payload === null || typeof payload !== "object") continue;
    if (payload.name !== "write" && payload.name !== "edit") continue;
    const input = payload.input as { path?: unknown } | null;
    if (input === null || typeof input !== "object" || typeof input.path !== "string") continue;
    byPath.set(input.path, [...(byPath.get(input.path) ?? []), event]);
  }
  const paths = [...byPath.keys()];
  const hunks = paths.map((path, index) => ({
    id: `H${index + 1}`,
    path,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    patch: `@@ -1 +1 @@\n+change to ${path}`,
    addedText: `change to ${path}`,
    removedText: "",
    addedLines: 1,
    removedLines: 0,
    riskScore: 0,
    riskReasons: [],
  }));
  const evidenceByHunk: Record<string, SessionReview["evidenceByHunk"][string]> = {};
  for (const [index, path] of paths.entries()) {
    evidenceByHunk[`H${index + 1}`] = (byPath.get(path) ?? []).map((event) => ({
      relation: "introduced_by" as const,
      confidence: "likely" as const,
      snapshotId: null,
      eventId: event.event_id,
      toolCallId: null,
      detail: "story-eval shortcut: write request without shadow git",
    }));
  }
  return SessionReviewSchema.parse({
    sessionId,
    baselineCommit: null,
    finalCommit: null,
    hunks,
    attempts: [],
    evidenceByHunk,
    diagnostics: ["story-eval: synthetic review without shadow git"],
    generatedAt: new Date(0).toISOString(),
  });
}

interface FixtureTape {
  name: string;
  sessionId: string;
  events: TapeEvent[];
}

function everyFixtureTape(): FixtureTape[] {
  const tapes: FixtureTape[] = [];
  for (const [name, factory] of Object.entries(fixtureBuilders)) {
    if (!name.startsWith("build") || typeof factory !== "function" || factory.length !== 0) {
      continue;
    }
    const built = (factory as () => unknown)();
    if (built === null || typeof built !== "object") continue;
    const { sessionId, events } = built as { sessionId?: unknown; events?: unknown };
    if (typeof sessionId !== "string" || !Array.isArray(events)) continue;
    tapes.push({ name, sessionId, events: events as TapeEvent[] });
  }
  return tapes;
}

describe("skeleton over every fixture tape", () => {
  const tapes = everyFixtureTape();
  expect(tapes.length).toBeGreaterThan(0);

  it.each(tapes)("$name never crashes and stays schema-valid", (tape) => {
    const stored = tape.events.map(toStored);
    const review = reviewFromTape(tape.sessionId, tape.events);
    const facts = buildFacts(review, stored);
    const parsed = SessionStorySchema.parse(
      skeletonStory({
        sessionId: tape.sessionId,
        facts,
        watermark: computeWatermark(stored),
        captureQuality: "full",
      }),
    );
    const liveHunks = facts.facts.filter(
      (fact) => fact.kind === "hunk" && !facts.routineFactIds.includes(fact.id),
    );
    expect(parsed.cards).toHaveLength(liveHunks.length);
    expect(parsed.verifiedCounts.total).toBe(parsed.cards.length);
    const { observed, partlyObserved, agentStated, nothing, total } = parsed.verifiedCounts;
    expect(observed + partlyObserved + agentStated + nothing).toBe(total);
    expect(parsed.summary.length).toBeGreaterThan(0);
  });
});

// Hand-built FactSet: 2 hunks, 1 run, 1 prompt cluster. Summaries and texts are
// digit-free except through known file tokens, so only seeded lies trip the
// integer check (known numbers are just the structural counts 0..3).
function seedFacts(): FactSet {
  return {
    sessionId: "sess_eval",
    promptClusters: [{ id: "P1", promptEventId: "e-prompt", text: "Add a greeting", index: 0 }],
    facts: [
      {
        id: "H1",
        kind: "hunk",
        summary: "greeting change in the app entrypoint",
        eventIds: ["e-h1"],
        files: ["src/app.ts"],
        riskFlags: [],
        riskReasons: [],
        verification: "nothing",
        testedByRunIds: ["R1"],
      },
      {
        id: "H2",
        kind: "hunk",
        summary: "widget change on the secondary screen",
        eventIds: ["e-h2"],
        files: ["src/app2.ts"],
        riskFlags: [],
        riskReasons: [],
        verification: "partly_observed",
        testedByRunIds: ["R1"],
      },
      {
        id: "R1",
        kind: "run",
        summary: "ran the suite with a passing exit",
        eventIds: ["e-run"],
        files: [],
        riskFlags: [],
        riskReasons: [],
        verification: "nothing",
        testedByRunIds: [],
      },
    ],
    routineFactIds: [],
  };
}

function draftCard(
  headline: string,
  hunkIds: string[],
  actionIds: string[],
  why: Array<{ text: string; factIds: string[] }>,
) {
  return {
    headline,
    constituentHunkIds: hunkIds,
    constituentActionIds: actionIds,
    why: why.map((claim) => ({ ...claim, label: "observed" as const })),
    before: [],
    now: [],
  };
}

function draftEnvelope(cards: Array<ReturnType<typeof draftCard>>) {
  return {
    summary: "Polish the greeting in src/app.ts",
    shortVersion: [
      { text: "Session updated src/app.ts", label: "observed" as const, factIds: ["H1"] },
    ],
    askVsResult: {
      asked: [{ text: "Add a greeting", label: "agent_stated" as const, factIds: ["P1"] }],
      delivered: [],
      extras: [],
      missing: [],
    },
    cards,
  };
}

describe("seeded-contradiction battery", () => {
  it("drops invented integers, paths and unknown factIds while valid claims survive", () => {
    const draft = draftEnvelope([
      draftCard(
        "Greet users from src/app.ts",
        ["H1"],
        [],
        [
          { text: "Updated src/app.ts with a greeting", factIds: ["H1"] },
          { text: "Cut p99 latency by 99 percent", factIds: ["H1"] },
          { text: "Also rewrote src/evil.ts for safety", factIds: ["H1"] },
          { text: "Mystery improvement landed", factIds: ["ZZZ"] },
        ],
      ),
    ]);
    const result = validateDraft(draft, seedFacts());
    expect(result.valid).toBe(true);
    expect(result.dropped).toHaveLength(3);
    for (const line of result.dropped) {
      expect(line.startsWith("Echo couldn't verify this:")).toBe(true);
    }
    const card = result.story?.cards.find((entry) => entry.constituentHunkIds.includes("H1"));
    expect(card?.why.map((claim) => claim.text)).toEqual(["Updated src/app.ts with a greeting"]);
  });

  it("drops cards built from wrong-kind constituent ids", () => {
    const valid = draftCard(
      "Greet users from src/app.ts",
      ["H1"],
      [],
      [{ text: "Updated src/app.ts with a greeting", factIds: ["H1"] }],
    );
    const runAsHunk = draftCard(
      "Run card",
      ["R1"],
      [],
      [{ text: "Ran the suite", factIds: ["R1"] }],
    );
    const hunkAsAction = draftCard(
      "Action card",
      ["H1"],
      ["H1"],
      [{ text: "Updated src/app.ts with a greeting", factIds: ["H1"] }],
    );
    const multi = { ...draftEnvelope([valid]), cards: [valid, runAsHunk, hunkAsAction] };
    const result = validateDraft(multi, seedFacts());
    expect(result.valid).toBe(true);
    expect(result.story?.cards).toHaveLength(1);
    expect(result.story?.cards[0]?.constituentHunkIds).toEqual(["H1"]);
    expect(result.errors.some((error) => error.includes("R1"))).toBe(true);
  });

  it("keeps headlines whose only digits live inside a known filename", () => {
    const draft = draftEnvelope([
      draftCard(
        "Polish app2.ts rendering pass",
        ["H2"],
        [],
        [{ text: "Touched src/app2.ts for the widget", factIds: ["H2"] }],
      ),
    ]);
    const result = validateDraft(draft, seedFacts());
    expect(result.valid).toBe(true);
    expect(result.story?.cards).toHaveLength(1);
    expect(result.story?.cards[0]?.headline).toBe("Polish app2.ts rendering pass");
    expect(result.errors.some((error) => error.includes("unknown number"))).toBe(false);
  });

  it("returns valid:false when zero cards survive", () => {
    const draft = draftEnvelope([
      draftCard(
        "Rewrite src/evil.ts from scratch",
        ["H1"],
        [],
        [{ text: "Rewrote src/evil.ts", factIds: ["H1"] }],
      ),
    ]);
    const result = validateDraft(draft, seedFacts());
    expect(result.valid).toBe(false);
    expect(result.story).toBeNull();
    expect(result.dropped.some((line) => line.startsWith("Echo couldn't verify this:"))).toBe(true);
  });
});

describe("watermark determinism", () => {
  it("is stable for the same events and order-sensitive", () => {
    const tape = everyFixtureTape()[0];
    if (!tape) throw new Error("expected at least one fixture tape");
    const stored = tape.events.map(toStored);
    expect(computeWatermark(stored)).toEqual(computeWatermark([...stored]));
    const reversed = [...stored].reverse();
    expect(computeWatermark(reversed).sha256).not.toBe(computeWatermark(stored).sha256);
    expect(computeWatermark(stored).eventCount).toBe(stored.length);
  });
});
