# ADR 0012: Calibration checks v2 (MCQ + free text); Skipped replaces waive

Status: Accepted, 2026-10-28

## Context

ADR 0010 replaced puzzle checks with five free-text ownership kinds graded by rubric, explicitly with no exact-match grading. The built UI adds Brier scores and a correct-total — a grade. The confirmed product decision is that the check exists for private calibration only: a picture, not a grade, gate, or proof.

## Decision

a. Questions mix MCQ (deterministically key-scored) for consequence/decision recognition and free text (rubric-scored against recorded evidence) for why/teach-back; the format is chosen per target, with >=1 free-text question whenever a high-risk change is in the set. This supersedes ADR 0010's no-exact-match position for the MCQ subset only. The five ownership kinds remain the topic source.
b. Flow is question -> confidence (`Guessing` / `Think so` / `Certain`) locked -> answer -> immediate evidence reveal. 3–5 questions or fewer per session; never padded with trivia.
c. The outcome is a picture mapping all change cards to `solid` / `right-but-unsure` / `confident-but-wrong` / `wrong-and-knew-it` / `never-looked`. No numeric score or Brier is displayed; calibration math, if kept, is internal targeting data only.
d. Session status is tri-state: `Not checked` (never finished; abandoning resumes), `Checked` (finished a check, any outcome), `Skipped` (explicit skip at offer or mid-check). Per-hunk "waive" is abolished, and a per-question "I don't know" is an answer, not a skip.
e. Targeting uses risk plus Echo-side engagement tiers (`unseen` / `seen` / `engaged`); signals only nudge ranking. Per-card "Check me on this" asks one question that feeds the session set without changing status alone.
f. Checks generate at start; if the model is unavailable the check is unavailable and status is untouched. No retakes or grade contests in v1.

## Consequences

- The checks package selection/grading and the checks/report UI are replaced: ARCHITECTURE §15 (Hunk selection incl. waive rule 5, Check generation with all-rubric grading, Answer flow and calibration with Brier/overconfidence, Limits) and spec §3 Pipeline steps 7–9 (select/check/summarize with waive, Brier, calibration reading) are superseded by this ADR. ADR 0010's rubric-only grading stands for free text; its no-exact-match rule is narrowed for MCQ keys.
- MCQ needs a question schema with answer keys plus distractor provenance from tape alternatives (reverted attempts, not invented options).
- Wrong-and-certain remains the key event, presented as `confident-but-wrong` in the picture rather than as a score event.
