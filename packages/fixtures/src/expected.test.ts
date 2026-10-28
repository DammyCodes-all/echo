import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChangeCardSchema, DetourSchema, LooseEndSchema } from "@echo/contracts";
import { describe, expect, it } from "vitest";
import { expectedFactsFor } from "./expected";
import { buildAllStorySessions } from "./sessions";

const here = dirname(fileURLToPath(import.meta.url));
const expectedDir = join(here, "..", "..", "..", "fixtures", "expected");

function factsJson(slug: string): unknown {
  return JSON.parse(readFileSync(join(expectedDir, `${slug}.json`), "utf8"));
}

function factsFor(slug: string) {
  const session = buildAllStorySessions().find((entry) => entry.slug === slug);
  if (!session) throw new Error(`fixture session missing: ${slug}`);
  return expectedFactsFor(session);
}

describe("story expected facts", () => {
  it("conforms every card, detour and loose end to the locked schemas", () => {
    for (const session of buildAllStorySessions()) {
      const facts = expectedFactsFor(session);
      for (const card of facts.cards) {
        expect(() => ChangeCardSchema.parse(card)).not.toThrow();
      }
      for (const detour of facts.detoursIn) {
        expect(() => DetourSchema.parse(detour)).not.toThrow();
      }
      for (const looseEnd of facts.looseEnds) {
        expect(() => LooseEndSchema.parse(looseEnd)).not.toThrow();
      }
    }
  });

  it("pins checked-in JSON copies of the hand labels", () => {
    for (const session of buildAllStorySessions()) {
      expect(factsJson(session.slug)).toEqual(expectedFactsFor(session));
    }
  });

  it("references only real hunks, attempts, runs and events", () => {
    for (const session of buildAllStorySessions()) {
      const facts = expectedFactsFor(session);
      const hunkIds = new Set(session.hunks.map((hunk) => hunk.id));
      const attemptIds = new Set(session.attempts.map((attempt) => attempt.id));
      const toolCallIds = new Set(
        session.tape.map((event) => event.links.tool_call_id).filter((id) => id !== null),
      );
      const eventIds = new Set(session.tape.map((event) => event.event_id));
      const runIds = new Set(session.runs.map((run) => run.runId));
      const runEventIds = new Set(session.runs.flatMap((run) => run.eventIds));
      for (const card of facts.cards) {
        expect(hunkIds.has(card.id)).toBe(true);
        for (const hunkId of card.constituentHunkIds) expect(hunkIds.has(hunkId)).toBe(true);
        for (const actionId of card.constituentActionIds)
          expect(toolCallIds.has(actionId)).toBe(true);
        for (const claim of [...card.why, ...card.before, ...card.now, ...card.checkedBy]) {
          for (const factId of claim.factIds) expect(eventIds.has(factId)).toBe(true);
        }
      }
      for (const detour of facts.detoursIn) {
        for (const attemptId of detour.attemptIds) expect(attemptIds.has(attemptId)).toBe(true);
      }
      for (const id of facts.suppressChecksFor) {
        expect(facts.cards.some((card) => card.id === id)).toBe(true);
      }
      for (const contradiction of facts.seededContradictions) {
        expect(runIds.has(contradiction.evidenceRunId)).toBe(true);
        for (const eventId of runEventIds) expect(eventIds.has(eventId)).toBe(true);
      }
    }
  });

  it("labels the payment retry high-risk, unverified, with a must-drop contradiction", () => {
    const facts = factsFor("payment-retry");
    expect(facts.cards).toHaveLength(1);
    expect(facts.cards[0]).toMatchObject({ highRisk: true, verification: "partly_observed" });
    expect(facts.cards[0]?.riskReasons.join(" ")).toContain("payments");
    expect(facts.seededContradictions).toHaveLength(1);
    const seeded = facts.seededContradictions[0];
    if (!seeded) throw new Error("seeded contradiction missing");
    expect(seeded.disposition).toBe("must-drop");
    expect(seeded.assertedNumber).not.toBe(seeded.observedNumber);
  });

  it("folds the routine session to one line with zero cards", () => {
    const facts = factsFor("routine");
    expect(facts.cards).toEqual([]);
    expect(facts.routineLine).toContain("no behaviour change");
  });

  it("marks the research session no-check-needed with no evidence", () => {
    const facts = factsFor("research");
    expect(facts.noCheckNeeded).toBe(true);
    expect(facts.cards).toEqual([]);
    expect(facts.detoursIn).toEqual([]);
    expect(facts.looseEnds).toEqual([]);
    expect(facts.blindSpots).toEqual([]);
  });

  it("links the failed deploy detour to its side-effect attempt", () => {
    const facts = factsFor("failed-deploy");
    expect(facts.detoursIn).toHaveLength(1);
    expect(facts.detoursIn[0]).toMatchObject({ costReason: "side_effect" });
    expect(facts.cards[0]?.verification).toBe("nothing");
  });

  it("suppresses checks for the partial-capture card and names the blind spot", () => {
    const facts = factsFor("partial-gap");
    expect(facts.blindSpots).toHaveLength(1);
    expect(facts.blindSpots.join(" ")).toContain("5-8");
    expect(facts.suppressChecksFor).toEqual(facts.cards.map((card) => card.id));
  });

  it("keeps the costly multi-topic detour and folds the trivial dead end", () => {
    const facts = factsFor("multi-topic");
    expect(facts.detoursIn).toHaveLength(1);
    expect(facts.detoursIn[0]?.costReason).toBe("reverted");
    expect(facts.detoursOut).toHaveLength(1);
    expect(facts.detoursOut[0]?.toolCallId).toBe("call_lint_triv");
    expect(facts.detoursOut[0]?.foldReason).toContain("no file change");
    expect(facts.cards).toHaveLength(2);
  });
});
