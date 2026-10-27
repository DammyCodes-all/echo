# ADR 0010: Ownership checks replace puzzle checks

Status: Accepted, 2026-10-28

## Context

The plan called for predict-the-output and spot-the-bug checks. That tests
reading comprehension, which models do unsupervised — it does not test
ownership, and it does not survive the "can a model do this unsupervised"
test from the AI-era skills literature. What is scarce is defending the
system: decisions, trade-offs, blast radius, consequences, teach-back.

## Decision

Cut both puzzle kinds completely — no warm-up round. Every check is one of
five ownership kinds, ordered easy to hard:

1. consequence — what did this change cost or open up (concrete, local)
2. decision — why this approach over the reverted alternative
3. tradeoff — what price was accepted for this choice
4. blast_radius — what breaks if this changes (runnable in the sandbox)
5. teach_back — explain it so a new teammate can act on it (hardest)

Exact-match grading is out entirely: the questions are deep and system-level,
so no string match can judge them. All five kinds grade against a rubric —
the model checks each point and must cite a supporting passage from the
answer, and all points must hit. Meaning counts, wording doesn't: paraphrase
passes as long as the cited passage really occurs in the answer (verified
mechanically — an invented citation fails even when marked a hit). The
sandbox keeps one job for blast_radius: establishing what actually breaks,
which grounds the rubric. The model judges whether the explanation matches
that ground truth. A generous grader cannot pass a partial answer because
the package owns the all-points rule.

## Consequences

- The attempt tree is promoted from visualization to primary question
  source: it is the only artifact recording decisions (dead ends vs landed).
- `packages/checks` carries the five kinds with difficulty ordering and a
  grade-mode split (exact vs rubric).
- BUILD-PLAN cut line ("keep predict-the-output") is superseded by this ADR.
