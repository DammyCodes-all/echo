import type { ChangeCard } from "@echo/contracts";
import { describe, expect, it } from "vitest";
import {
  bucketFor,
  gradeMcq,
  gradeRubric,
  type HunkInput,
  isWeakPictureBucket,
  makeCheck,
  rankHunks,
  selectTargets,
  weakFileCounts,
  weakFiles,
} from "./index";

const risky: HunkInput = {
  path: "src/auth.ts",
  deletionStart: 10,
  deletionLines: 4,
  additionStart: 10,
  additionLines: 2,
  addedText: "if (!token) return null;",
  removedText: "try {\n  verify(token);\n} catch (e) {\n  throw new AuthError();\n}",
};

const tame: HunkInput = {
  path: "src/greet.ts",
  deletionStart: 1,
  deletionLines: 0,
  additionStart: 2,
  additionLines: 1,
  addedText: "// friendly comment",
  removedText: "",
};

describe("check targeting", () => {
  it("ranks the risky hunk above the tame one with reasons", () => {
    const ranked = rankHunks([tame, risky]);
    expect(ranked[0]?.hunk.path).toBe("src/auth.ts");
    expect(ranked[0]?.reasons.join(" ")).toContain("error-handling");
  });

  it("is deterministic for equal scores", () => {
    const first = rankHunks([tame, risky]).map((entry) => entry.hunk.path);
    const second = rankHunks([risky, tame]).map((entry) => entry.hunk.path);
    expect(first).toEqual(second);
  });
});

describe("ownership kinds", () => {
  it("refuses checks without a rubric", () => {
    expect(() => makeCheck("decision", "Why?", ["a.ts"], [])).toThrowError(/rubric/);
  });

  it("requires a demonstration for blast_radius and forbids it elsewhere", () => {
    expect(() => makeCheck("blast_radius", "What breaks?", ["a.ts"], ["x breaks"])).toThrowError(
      /demonstration/,
    );
    expect(() =>
      makeCheck("decision", "Why?", ["a.ts"], ["x"], {
        code: 'console.log("x");',
        observedStdout: "x\n",
      }),
    ).toThrowError(/only blast_radius/);
  });
});

describe("rubric grading", () => {
  it("passes on meaning, not wording — but the support must be real", () => {
    const check = makeCheck(
      "consequence",
      "What opened up?",
      ["a.ts"],
      ["null passes", "no throw"],
    );
    const answer = "Null values flow through and nothing raises an error.";
    expect(
      gradeRubric(check, answer, [
        {
          point: "null passes",
          hit: true,
          excerpt: "Null values flow through",
          why: "says nulls pass",
        },
        {
          point: "no throw",
          hit: true,
          excerpt: "nothing raises an error",
          why: "says no error raised",
        },
      ]).correct,
    ).toBe(true);
    // Paraphrase hits; invented support fails even when marked hit.
    expect(
      gradeRubric(check, answer, [
        {
          point: "null passes",
          hit: true,
          excerpt: "Null values flow through",
          why: "ok",
        },
        { point: "no throw", hit: true, excerpt: "it throws loudly", why: "invented" },
      ]),
    ).toEqual({
      correct: false,
      reason: "supporting passage not found in answer: no throw",
    });
    expect(
      gradeRubric(check, answer, [
        {
          point: "null passes",
          hit: true,
          excerpt: "Null values flow through",
          why: "ok",
        },
        { point: "no throw", hit: false, excerpt: null, why: "not mentioned" },
      ]).correct,
    ).toBe(false);
  });
});

function v2Card(id: string, highRisk: boolean, rank: number, touches: string[] = []): ChangeCard {
  return {
    id,
    headline: `Change ${id}.`,
    constituentHunkIds: [],
    constituentActionIds: [],
    rank,
    sessionOrder: rank - 1,
    highRisk,
    riskReasons: [],
    verification: "nothing",
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

describe("checks v2 targeting", () => {
  it("returns [] for no cards and never pads small sessions", () => {
    expect(selectTargets([], {})).toEqual([]);
    const cards = [v2Card("c1", false, 1), v2Card("c2", false, 2)];
    expect(selectTargets(cards, {}, 5)).toEqual(["c1", "c2"]);
  });

  it("ranks highRisk first, then rank asc, capped at the limit", () => {
    const cards = [v2Card("low2", false, 2), v2Card("high", true, 9), v2Card("low1", false, 1)];
    expect(selectTargets(cards, {}, 5)).toEqual(["high", "low1", "low2"]);
    expect(selectTargets(cards, {}, 2)).toEqual(["high", "low1"]);
  });

  it("swaps one low-priority pick for an engaged spot-check", () => {
    const cards = [
      v2Card("c1", false, 1),
      v2Card("c2", false, 2),
      v2Card("c3", false, 3),
      v2Card("engaged", false, 10),
    ];
    const tiers = { engaged: "engaged" } as Record<string, "engaged">;
    expect(selectTargets(cards, tiers, 3)).toEqual(["c1", "c2", "engaged"]);
  });

  it("swaps at most once even with several engaged cards outside the picks", () => {
    const cards = [
      v2Card("c1", false, 1),
      v2Card("c2", false, 2),
      v2Card("c3", false, 3),
      v2Card("e1", false, 10),
      v2Card("e2", false, 11),
    ];
    const tiers = { e1: "engaged", e2: "engaged" } as Record<string, "engaged">;
    expect(selectTargets(cards, tiers, 3)).toEqual(["c1", "c2", "e1"]);
  });

  it("never swaps when every pick is highRisk", () => {
    const cards = [v2Card("h1", true, 1), v2Card("h2", true, 2), v2Card("e", false, 3)];
    const tiers = { e: "engaged" } as Record<string, "engaged">;
    expect(selectTargets(cards, tiers, 2)).toEqual(["h1", "h2"]);
  });

  it("never swaps when a pick is already engaged", () => {
    const cards = [v2Card("c1", false, 1), v2Card("e", false, 2), v2Card("c3", false, 3)];
    const tiers = { e: "engaged" } as Record<string, "engaged">;
    expect(selectTargets(cards, tiers, 2)).toEqual(["c1", "e"]);
  });

  it("prefers cards touching files the project got wrong before, within a risk tier", () => {
    const cards = [
      v2Card("fresh", false, 1, ["docs/fresh.md"]),
      v2Card("weak", false, 2, ["db/store.ts"]),
    ];
    expect(selectTargets(cards, {}, 5, new Set(["db/store.ts"]))).toEqual(["weak", "fresh"]);
  });

  it("counts multiple weak touches above single ones, deterministically", () => {
    const cards = [
      v2Card("one", false, 1, ["db/a.ts"]),
      v2Card("two", false, 2, ["db/a.ts", "db/b.ts"]),
    ];
    const weak = new Set(["db/a.ts", "db/b.ts"]);
    expect(selectTargets(cards, {}, 5, weak)).toEqual(["two", "one"]);
    expect(selectTargets([...cards].reverse(), {}, 5, weak)).toEqual(["two", "one"]);
  });

  it("never lets the weak signal outrank highRisk", () => {
    const cards = [
      v2Card("risky", true, 9, ["docs/plain.md"]),
      v2Card("weak", false, 1, ["db/store.ts"]),
    ];
    expect(selectTargets(cards, {}, 5, new Set(["db/store.ts"]))).toEqual(["risky", "weak"]);
  });

  it("ignores an empty weak set exactly like no signal", () => {
    const cards = [v2Card("c1", false, 1), v2Card("c2", false, 2)];
    expect(selectTargets(cards, {}, 5, new Set())).toEqual(["c1", "c2"]);
  });
});

describe("weak-file signal", () => {
  it("splits weak buckets from the rest", () => {
    expect(isWeakPictureBucket("confident_but_wrong")).toBe(true);
    expect(isWeakPictureBucket("wrong_and_knew_it")).toBe(true);
    expect(isWeakPictureBucket("solid")).toBe(false);
    expect(isWeakPictureBucket("right_but_unsure")).toBe(false);
    expect(isWeakPictureBucket("never_looked")).toBe(false);
  });

  it("counts touches per file and keeps only confident-wrong files as weak", () => {
    const counts = weakFileCounts([
      { touches: ["db/store.ts", "db/index.ts"], weak: true },
      { touches: ["db/store.ts"], weak: false },
      { touches: ["docs/readme.md"], weak: false },
    ]);
    expect(counts.get("db/store.ts")).toEqual({ confidentWrong: 1, total: 2 });
    expect(counts.get("db/index.ts")).toEqual({ confidentWrong: 1, total: 1 });
    expect(counts.get("docs/readme.md")).toEqual({ confidentWrong: 0, total: 1 });
    expect(weakFiles([])).toEqual(new Set());
    expect(
      weakFiles([
        { touches: ["db/store.ts"], weak: true },
        { touches: ["docs/readme.md"], weak: false },
      ]),
    ).toEqual(new Set(["db/store.ts"]));
  });
});

describe("checks v2 buckets and keys", () => {
  it("maps attempts to the five picture buckets", () => {
    expect(bucketFor({ attempted: true, correct: true, confident: true })).toBe("solid");
    expect(bucketFor({ attempted: true, correct: true, confident: false })).toBe(
      "right_but_unsure",
    );
    expect(bucketFor({ attempted: true, correct: false, confident: true })).toBe(
      "confident_but_wrong",
    );
    expect(bucketFor({ attempted: true, correct: false, confident: false })).toBe(
      "wrong_and_knew_it",
    );
    expect(bucketFor({ attempted: false, correct: false, confident: false })).toBe("never_looked");
  });

  it("scores mcq by strict key equality", () => {
    expect(gradeMcq("a", "a")).toBe(true);
    expect(gradeMcq("b", "a")).toBe(false);
    expect(gradeMcq(null, "a")).toBe(false);
    expect(gradeMcq(undefined, "a")).toBe(false);
  });
});
