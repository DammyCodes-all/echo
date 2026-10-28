import { runWasm } from "@echo/sandbox";
import type { ChangeCard } from "@echo/contracts";
import { describe, expect, it } from "vitest";
import {
  bucketFor,
  gradeMcq,
  gradeRubric,
  type HunkInput,
  KIND_DIFFICULTY,
  makeCheck,
  orderForSession,
  type RunnerResult,
  rankHunks,
  selectChecks,
  selectTargets,
  verifyDemonstration,
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

async function wasmRunner(code: string): Promise<RunnerResult> {
  const result = await runWasm({ code });
  return { status: result.status, stdout: result.stdout };
}

describe("check targeting", () => {
  it("ranks the risky hunk above the tame one with reasons", () => {
    const ranked = rankHunks([tame, risky]);
    expect(ranked[0]?.hunk.path).toBe("src/auth.ts");
    expect(ranked[0]?.reasons.join(" ")).toContain("error-handling");
    expect(selectChecks(ranked, 1)).toHaveLength(1);
  });

  it("is deterministic for equal scores", () => {
    const first = rankHunks([tame, risky]).map((entry) => entry.hunk.path);
    const second = rankHunks([risky, tame]).map((entry) => entry.hunk.path);
    expect(first).toEqual(second);
  });
});

describe("ownership kinds", () => {
  it("orders easiest first: consequence to teach_back", () => {
    expect(KIND_DIFFICULTY.consequence).toBeLessThan(KIND_DIFFICULTY.decision);
    expect(KIND_DIFFICULTY.decision).toBeLessThan(KIND_DIFFICULTY.tradeoff);
    expect(KIND_DIFFICULTY.tradeoff).toBeLessThan(KIND_DIFFICULTY.blast_radius);
    expect(KIND_DIFFICULTY.blast_radius).toBeLessThan(KIND_DIFFICULTY.teach_back);
    const ordered = orderForSession([
      makeCheck("teach_back", "Explain auth.", ["src/auth.ts"], ["token checked first"]),
      makeCheck(
        "blast_radius",
        "What breaks if the guard is removed, and why there?",
        ["src/auth.ts"],
        ["unauthenticated requests pass through", "the guard was the only check"],
        { code: 'console.log("unguarded");', observedStdout: "unguarded\n" },
      ),
      makeCheck("consequence", "What did this open up?", ["src/auth.ts"], ["null passes through"]),
    ]);
    expect(ordered.map((check) => check.kind)).toEqual([
      "consequence",
      "blast_radius",
      "teach_back",
    ]);
  });

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

describe("demonstration gate", () => {
  it("passes a stable demonstration twice", { timeout: 30_000 }, async () => {
    const check = makeCheck(
      "blast_radius",
      "What breaks if the guard is removed, and why there?",
      ["src/auth.ts"],
      ["unauthenticated requests pass through"],
      { code: 'console.log("unguarded");', observedStdout: "unguarded\n" },
    );
    const verification = await verifyDemonstration(check, wasmRunner);
    expect(verification).toEqual({ verified: true, reason: null });
  });

  it("rejects a demonstration that does not match the observation", {
    timeout: 30_000,
  }, async () => {
    const check = makeCheck("blast_radius", "What breaks?", ["src/auth.ts"], ["it throws"], {
      code: 'console.log("unguarded");',
      observedStdout: "throws\n",
    });
    const verification = await verifyDemonstration(check, wasmRunner);
    expect(verification.verified).toBe(false);
    expect(verification.reason).toContain("recorded observation");
  });

  it("verifies open checks structurally", async () => {
    const check = makeCheck("tradeoff", "What did we pay?", ["a.ts"], ["spawn cost"]);
    const verification = await verifyDemonstration(check, wasmRunner);
    expect(verification).toEqual({ verified: true, reason: null });
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

function v2Card(id: string, highRisk: boolean, rank: number): ChangeCard {
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
    touches: [],
    moment: { eventId: null, toolCallId: null, ts: null, excerpt: `Change ${id}.`, label: "uncertain" },
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
    const cards = [
      v2Card("low2", false, 2),
      v2Card("high", true, 9),
      v2Card("low1", false, 1),
    ];
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
