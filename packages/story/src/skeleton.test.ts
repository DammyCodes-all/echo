import { SessionStorySchema } from "@echo/contracts";
import { type FixtureStorySession, buildAllStorySessions } from "@echo/fixtures";
import { describe, expect, it } from "vitest";
import {
  type FactSet,
  buildSkeletonStory,
  extractFacts,
  isStoryStale,
} from "./index";

const META = { generatedAt: "2026-10-28T12:00:00.000Z", tapeSha256: "test-sha" };

function skeletonFor(slug: string): { session: FixtureStorySession; facts: FactSet } {
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

describe("buildSkeletonStory", () => {
  it("self-validates clean on every fixture session", () => {
    for (const session of buildAllStorySessions()) {
      const facts = extractFacts({
        sessionId: session.sessionId,
        tape: session.tape,
        hunks: session.hunks,
        attempts: session.attempts,
      });
      const { story, validation } = buildSkeletonStory(facts, META);
      expect(validation.verdicts.every((verdict) => verdict.valid)).toBe(true);
      expect(validation.diagnostics).toEqual([]);
      // And the skeleton is a schema-valid story artifact.
      expect(SessionStorySchema.safeParse(story).success).toBe(true);
    }
  });

  it("stamps the skeleton generator and the tape watermark", () => {
    const { session, facts } = skeletonFor("payment-retry");
    const { story } = buildSkeletonStory(facts, META);
    expect(story.skeleton).toBe(true);
    expect(story.generator).toEqual({ kind: "skeleton", model: null, promptVersion: "skeleton-v1" });
    expect(story.tapeWatermark).toEqual({ eventCount: session.tape.length, sha256: "test-sha" });
    expect(story.shortVersion).toHaveLength(1);
    expect(story.askVsResult.asked).toHaveLength(1);
  });

  it("builds one card per behavior hunk with intact verification", () => {
    const expectations: Record<string, { cards: number; badges: string[] }> = {
      "payment-retry": { cards: 1, badges: ["partly_observed"] },
      routine: { cards: 0, badges: [] },
      research: { cards: 0, badges: [] },
      "failed-deploy": { cards: 1, badges: ["nothing"] },
      "partial-gap": { cards: 1, badges: ["partly_observed"] },
      "multi-topic": { cards: 2, badges: ["observed", "observed"] },
    };
    for (const [slug, expected] of Object.entries(expectations)) {
      const { facts } = skeletonFor(slug);
      const { story } = buildSkeletonStory(facts, META);
      expect(story.cards).toHaveLength(expected.cards);
      expect(story.cards.map((card) => card.verification)).toEqual(expected.badges);
      expect(story.verifiedCounts.total).toBe(expected.cards);
      // Skeleton never invents intent: no why-lines without a model.
      for (const card of story.cards) expect(card.why).toEqual([]);
    }
  });

  it("folds the routine session to one line with zero cards", () => {
    const { facts } = skeletonFor("routine");
    const { story } = buildSkeletonStory(facts, META);
    expect(story.cards).toEqual([]);
    expect(story.routineSummary).toContain("no behaviour change");
    expect(story.routineSummary).toContain("src/util/format.ts");
  });

  it("derives detours from dead-end attempts only", () => {
    const { facts: deployFacts } = skeletonFor("failed-deploy");
    const deploy = buildSkeletonStory(deployFacts, META).story;
    expect(deploy.detours).toHaveLength(1);
    expect(deploy.detours[0]).toMatchObject({ costReason: "side_effect" });

    const { facts: multiFacts } = skeletonFor("multi-topic");
    const multi = buildSkeletonStory(multiFacts, META).story;
    expect(multi.detours).toHaveLength(1);
    expect(multi.detours[0]).toMatchObject({ costReason: "reverted" });

    const { facts: payFacts } = skeletonFor("payment-retry");
    expect(buildSkeletonStory(payFacts, META).story.detours).toHaveLength(0);
  });

  it("names the partial-capture blind spot and nothing else", () => {
    const { facts } = skeletonFor("partial-gap");
    const { story } = buildSkeletonStory(facts, META);
    expect(story.blindSpots).toHaveLength(1);
    expect(story.blindSpots.join(" ")).toContain("5-8");
    const { facts: payFacts } = skeletonFor("payment-retry");
    expect(buildSkeletonStory(payFacts, META).story.blindSpots).toHaveLength(0);
  });

  it("ranks the riskier card first", () => {
    const { facts } = skeletonFor("multi-topic");
    const { story } = buildSkeletonStory(facts, META);
    const home = story.cards.find((card) => card.touches.includes("src/home.ts"));
    const readme = story.cards.find((card) => card.touches.includes("README.md"));
    // Home has a rewrite signal; the typo fix has none.
    expect(home?.rank).toBe(1);
    expect(readme?.rank).toBe(2);
    expect(home?.sessionOrder).toBe(0);
    expect(readme?.sessionOrder).toBe(1);
  });

  it("handles an empty session without crashing", () => {
    const facts: FactSet = { sessionId: "ses_empty", tapeEventCount: 0, facts: [] };
    const { story, validation } = buildSkeletonStory(facts, META);
    expect(story.cards).toEqual([]);
    expect(story.shortVersion).toEqual([]);
    expect(story.verifiedCounts.total).toBe(0);
    expect(validation.verdicts.every((verdict) => verdict.valid)).toBe(true);
    expect(SessionStorySchema.safeParse(story).success).toBe(true);
  });

  it("is deterministic", () => {
    const { facts } = skeletonFor("multi-topic");
    const first = buildSkeletonStory(facts, META).story;
    const second = buildSkeletonStory(facts, META).story;
    expect(second).toEqual(first);
  });
});

describe("isStoryStale", () => {
  it("spots count and hash drift past the watermark", () => {
    const { facts } = skeletonFor("payment-retry");
    const { story } = buildSkeletonStory(facts, META);
    expect(isStoryStale(story, { eventCount: facts.tapeEventCount, sha256: "test-sha" })).toBe(false);
    expect(isStoryStale(story, { eventCount: facts.tapeEventCount + 1, sha256: "test-sha" })).toBe(true);
    expect(isStoryStale(story, { eventCount: facts.tapeEventCount, sha256: "other" })).toBe(true);
  });
});
