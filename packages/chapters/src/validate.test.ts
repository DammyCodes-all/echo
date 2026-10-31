import { ChangeSchema } from "@echo/contracts";
import { describe, expect, it } from "vitest";
import {
  buildSkeletonChange,
  type ChangeGroup,
  type SkeletonChange,
  type SnapshotPair,
} from "./changes";
import { validateSkeletonChange } from "./validate";

const PAIR: SnapshotPair = { prevOid: "a".repeat(40), nextOid: "b".repeat(40) };

const LOGIN_DIFF = [
  "diff --git a/src/auth/login.ts b/src/auth/login.ts",
  "--- a/src/auth/login.ts",
  "+++ b/src/auth/login.ts",
  "@@ -10,6 +10,12 @@ export function login(name) {",
  "   const user = findUser(name);",
  "+  if (!user) {",
  '+    throw new Error("unknown user");',
  "+  }",
  "+  const token = signToken(user);",
  "+  auditLog(user);",
  "+  return token;",
  "   return signToken(user);",
  " }",
  "",
].join("\n");

const GROUP: ChangeGroup = {
  kind: "change",
  files: [{ path: "src/auth/login.ts", diff: LOGIN_DIFF }],
  promptRefs: [0],
};

const INPUT = { files: GROUP.files };

function clone(): SkeletonChange {
  return JSON.parse(JSON.stringify(buildSkeletonChange(GROUP, PAIR))) as SkeletonChange;
}

describe("validateSkeletonChange", () => {
  it("accepts a builder-produced change", () => {
    const built = buildSkeletonChange(GROUP, PAIR);
    expect(ChangeSchema.parse(built)).toEqual(built);
    const result = validateSkeletonChange(built, INPUT);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("rejects cap violations one at a time", () => {
    const tooLong = clone();
    tooLong.title = "one two three four five six seven eight nine";
    expect(validateSkeletonChange(tooLong, INPUT).ok).toBe(false);

    const shortSummary = clone();
    shortSummary.summary = "Only one sentence here.";
    expect(validateSkeletonChange(shortSummary, INPUT).ok).toBe(false);

    const manySteps = clone();
    manySteps.howItWorks = ["a", "b", "c", "d", "e", "f"];
    expect(validateSkeletonChange(manySteps, INPUT).ok).toBe(false);

    const badHeadsUp = clone();
    badHeadsUp.headsUp = [
      { type: "not_asked", text: "a" },
      { type: "watch_out", text: "b" },
      { type: "unfinished", text: "c" },
      { type: "not_asked", text: "d" },
    ];
    expect(validateSkeletonChange(badHeadsUp, INPUT).ok).toBe(false);

    const badType = clone();
    badType.headsUp = [{ type: "risky", text: "nope" }] as unknown as SkeletonChange["headsUp"];
    expect(validateSkeletonChange(badType, INPUT).ok).toBe(false);

    const shortDigest = clone();
    shortDigest.digest = "too short";
    expect(validateSkeletonChange(shortDigest, INPUT).ok).toBe(false);

    const longDigest = clone();
    longDigest.digest = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
    expect(validateSkeletonChange(longDigest, INPUT).ok).toBe(false);

    const badId = clone();
    badId.id = "nope";
    expect(validateSkeletonChange(badId, INPUT).ok).toBe(false);
  });

  it("rejects files missing from the input diff", () => {
    const missing = clone();
    missing.files = [{ path: "src/nowhere.ts", note: "note" }];
    const result = validateSkeletonChange(missing, INPUT);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("src/nowhere.ts");
  });

  it("rejects a missing snapshotPair or createdFrom", () => {
    const noPair = clone() as unknown as Record<string, unknown>;
    delete noPair.snapshotPair;
    expect(validateSkeletonChange(noPair, INPUT).ok).toBe(false);
    const noProvenance = clone() as unknown as Record<string, unknown>;
    delete noProvenance.createdFrom;
    expect(validateSkeletonChange(noProvenance, INPUT).ok).toBe(false);
    const badProvenance = clone() as unknown as Record<string, unknown>;
    badProvenance.createdFrom = { kind: "other" };
    expect(validateSkeletonChange(badProvenance, INPUT).ok).toBe(false);
  });

  it("never throws on malformed input", () => {
    const malformed = undefined as unknown as SkeletonChange;
    const noInput = undefined as unknown as { files: { path: string; diff: string }[] };
    expect(() => validateSkeletonChange(malformed, noInput)).not.toThrow();
    expect(validateSkeletonChange(malformed, noInput).ok).toBe(false);
    expect(() => validateSkeletonChange(null, { files: [] })).not.toThrow();
    expect(validateSkeletonChange(null, { files: [] }).ok).toBe(false);
    expect(() => validateSkeletonChange("change", INPUT)).not.toThrow();
    expect(validateSkeletonChange("change", INPUT).ok).toBe(false);
  });
});
