import type { CheckAttemptV2, PublicCheckQuestion } from "@echo/contracts";
import { describe, expect, it } from "vitest";
import { summarizeChangeChecks } from "./checks-summary";

const CHANGE = "c_aaaaaaaaaaaaaaaa";
const OTHER = "c_bbbbbbbbbbbbbbbb";

function question(id: string, cardId: string): PublicCheckQuestion {
  return {
    id,
    cardId,
    kind: "consequence",
    question: "What happens if this is removed?",
    evidenceFactIds: [],
    evidencePaths: [],
    format: "free_text",
  };
}

function attempt(questionId: string, correct: boolean): CheckAttemptV2 {
  return {
    id: `att_${questionId}`,
    questionId,
    confidence: "certain",
    selectedOptionId: null,
    answerText: "because reasons",
    correct,
    bucket: "solid",
    rubricHits: [],
    evidence: [],
    createdAt: "2026-10-31T00:00:00.000Z",
  };
}

describe("summarizeChangeChecks", () => {
  it("returns null when the change has no questions", () => {
    expect(summarizeChangeChecks([question("q1", OTHER)], [], CHANGE)).toBeNull();
    expect(summarizeChangeChecks([], [], CHANGE)).toBeNull();
  });

  it("ignores legacy h_ cards and other changes", () => {
    const questions = [question("q1", "h_cccccccccccccccc"), question("q2", OTHER)];
    const attempts = [attempt("q1", true), attempt("q2", true)];
    expect(summarizeChangeChecks(questions, attempts, CHANGE)).toBeNull();
  });

  it("counts answered and correct for this change only", () => {
    const questions = [
      question("q1", CHANGE),
      question("q2", CHANGE),
      question("q3", CHANGE),
      question("q4", OTHER),
    ];
    const attempts = [attempt("q1", true), attempt("q2", false), attempt("q4", true)];
    expect(summarizeChangeChecks(questions, attempts, CHANGE)).toEqual({
      answered: 2,
      correct: 1,
      total: 3,
    });
  });
});
