import type { CheckAttemptV2, PublicCheckQuestion } from "@echo/contracts";

export type ChangeCheckSummary = { answered: number; correct: number; total: number };

/**
 * Join stored check questions to their attempts for one change. Null when
 * the change has no questions (including legacy h_-card checks, which never
 * match a c_ change id) so the reader renders no result line.
 */
export function summarizeChangeChecks(
  questions: readonly PublicCheckQuestion[],
  attempts: readonly CheckAttemptV2[],
  changeId: string,
): ChangeCheckSummary | null {
  const mine = questions.filter((question) => question.cardId === changeId);
  if (mine.length === 0) return null;
  const byQuestion = new Map(attempts.map((attempt) => [attempt.questionId, attempt]));
  let answered = 0;
  let correct = 0;
  for (const question of mine) {
    const attempt = byQuestion.get(question.id);
    if (attempt === undefined) continue;
    answered += 1;
    if (attempt.correct) correct += 1;
  }
  return { answered, correct, total: mine.length };
}
