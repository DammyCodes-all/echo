import { runWasm } from "@echo/sandbox";
import { describe, expect, it } from "vitest";
import {
  gradeAnswer,
  type HunkInput,
  makePredictCheck,
  type RunnerResult,
  rankHunks,
  selectChecks,
  verifyCheck,
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

describe("verification gate", () => {
  it("passes a deterministic reference twice", { timeout: 30_000 }, async () => {
    const check = makePredictCheck('console.log("seven");', "seven\n");
    const verification = await verifyCheck(check, wasmRunner);
    expect(verification).toEqual({ verified: true, reason: null });
  });

  it("rejects a reference whose recorded answer is wrong", { timeout: 30_000 }, async () => {
    const check = makePredictCheck('console.log("seven");', "eight\n");
    const verification = await verifyCheck(check, wasmRunner);
    expect(verification.verified).toBe(false);
    expect(verification.reason).toContain("recorded answer");
  });

  it("rejects a reference that times out", { timeout: 30_000 }, async () => {
    const check = makePredictCheck("for (;;) {}", "");
    const verification = await verifyCheck(check, async () => ({
      status: "timeout",
      stdout: "",
    }));
    expect(verification.verified).toBe(false);
    expect(verification.reason).toContain("timeout");
  });
});

describe("grading", () => {
  it("accepts exact stdout and rejects anything else", () => {
    const check = makePredictCheck('console.log("seven");', "seven\n");
    expect(gradeAnswer(check, "seven\n", "ok").correct).toBe(true);
    expect(gradeAnswer(check, "seven", "ok").correct).toBe(false);
    expect(gradeAnswer(check, "", "timeout").correct).toBe(false);
  });
});
