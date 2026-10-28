import { createHash } from "node:crypto";
import type { ChangeCard, EngagementTier, PictureBucket } from "@echo/contracts";

export interface HunkInput {
  path: string;
  deletionStart: number;
  deletionLines: number;
  additionStart: number;
  additionLines: number;
  addedText: string;
  removedText: string;
}

export interface RankedHunk {
  hunk: HunkInput;
  score: number;
  reasons: string[];
}

// Small static patterns only (ARCHITECTURE: three similar lines beat an
// early helper — no model call in ranking; the model drafts questions later).
const RISK_PATTERNS: Array<{ id: string; pattern: RegExp; weight: number }> = [
  { id: "error-handling", pattern: /\bcatch\b|\bthrow\b|\.catch\(|onError/i, weight: 30 },
  { id: "auth-secret", pattern: /token|secret|password|api[_-]?key|credential/i, weight: 30 },
  { id: "dynamic-code", pattern: /\beval\(|new Function\(|exec\(|spawn\(/i, weight: 25 },
  { id: "network", pattern: /\bfetch\(|XMLHttpRequest|WebSocket/i, weight: 15 },
  { id: "deletion", pattern: /^[-]/m, weight: 0 },
];

export function rankHunks(hunks: HunkInput[]): RankedHunk[] {
  const ranked = hunks.map((hunk) => {
    const reasons: string[] = [];
    let score = hunk.additionLines + hunk.deletionLines;
    if (hunk.deletionLines > 0) {
      score += 5;
      reasons.push("removes code");
    }
    for (const { id, pattern, weight } of RISK_PATTERNS) {
      if (id === "deletion") continue;
      if (pattern.test(hunk.addedText) || pattern.test(hunk.removedText)) {
        score += weight;
        reasons.push(`mentions ${id}`);
      }
    }
    return { hunk, score, reasons };
  });
  return ranked.sort((a, b) => b.score - a.score || a.hunk.path.localeCompare(b.hunk.path));
}

/** Ownership check kinds, easiest first (ADR 0010). Puzzle kinds were cut:
 *  a model answers them unsupervised, so they prove no ownership. */
export type OwnershipKind = "consequence" | "decision" | "tradeoff" | "blast_radius" | "teach_back";

export const KIND_DIFFICULTY: Record<OwnershipKind, number> = {
  consequence: 1,
  decision: 2,
  tradeoff: 3,
  blast_radius: 4,
  teach_back: 5,
};

export const KIND_DESCRIPTIONS: Record<OwnershipKind, string> = {
  consequence: "What did this change cost or open up?",
  decision: "Why this approach over the reverted alternative?",
  tradeoff: "What price was accepted for this choice?",
  blast_radius: "What breaks if this changes, and why does it break there?",
  teach_back: "Explain it so a new teammate can act on it.",
};

export interface Demonstration {
  /** Self-contained snippet that performs the breakage. */
  code: string;
  /** What the sandbox actually observed (normalized line endings). */
  observedStdout: string;
}

export interface Check {
  id: string;
  kind: OwnershipKind;
  question: string;
  /** Hunk paths this check is grounded in; answers cite them. */
  evidencePaths: string[];
  /** Falsifiable points an answer must hit. Never vibes. */
  rubric: string[];
  /** Blast_radius only: the sandbox-established ground truth behind the rubric. */
  demonstration: Demonstration | null;
}

function checkId(kind: OwnershipKind, question: string): string {
  return `chk_${createHash("sha256").update(`${kind}:${question}`).digest("hex").slice(0, 12)}`;
}

/**
 * All five kinds grade against the rubric — including blast_radius (ADR
 * 0010): the questions are deep and system-level, so no string match can
 * judge them. The sandbox keeps one job: establishing what actually breaks,
 * which grounds the rubric. The model judges whether the user's explanation
 * matches that ground truth.
 */
export function makeCheck(
  kind: OwnershipKind,
  question: string,
  evidencePaths: string[],
  rubric: string[],
  demonstration?: Demonstration,
): Check {
  if (rubric.length === 0) throw new Error("checks require a non-empty rubric");
  const demo =
    demonstration === undefined
      ? null
      : {
          code: demonstration.code,
          observedStdout: demonstration.observedStdout.replace(/\r\n/g, "\n"),
        };
  if (kind === "blast_radius" && demo === null) {
    throw new Error("blast_radius checks require a sandbox demonstration");
  }
  if (kind !== "blast_radius" && demo !== null) {
    throw new Error("only blast_radius checks carry a demonstration");
  }
  return {
    id: checkId(kind, question),
    kind,
    question,
    evidencePaths,
    rubric,
    demonstration: demo,
  };
}

/** Easiest-first session order: concrete and local before systemic. */
export function orderForSession(checks: Check[]): Check[] {
  return [...checks].sort(
    (a, b) => KIND_DIFFICULTY[a.kind] - KIND_DIFFICULTY[b.kind] || a.id.localeCompare(b.id),
  );
}

export interface RunnerResult {
  status: "ok" | "timeout" | "error" | "unavailable";
  stdout: string;
}

export interface Verification {
  verified: boolean;
  reason: string | null;
}

/**
 * Execution still establishes truth (BUILD-PLAN Phase 5): for blast_radius,
 * the demonstration must run twice with byte-identical normalized stdout
 * matching the recorded observation before the check may be asked. A flaky
 * demonstration invalidates the check. Open kinds verify by evidence review
 * (rubric points traceable to the tape) — the ambiguity-review model call
 * lands with question generation in Phase 4/5.
 */
export async function verifyDemonstration(
  check: Check,
  run: (code: string) => Promise<RunnerResult>,
  passes = 2,
): Promise<Verification> {
  if (check.demonstration === null) {
    return {
      verified: check.rubric.length > 0 && check.evidencePaths.length > 0,
      reason:
        check.rubric.length > 0 && check.evidencePaths.length > 0
          ? null
          : "open checks need a rubric and evidence paths",
    };
  }
  const outputs: string[] = [];
  for (let i = 0; i < passes; i++) {
    const result = await run(check.demonstration.code);
    if (result.status !== "ok") {
      return { verified: false, reason: `demonstration ${result.status} on pass ${i + 1}` };
    }
    outputs.push(result.stdout.replace(/\r\n/g, "\n"));
  }
  for (let i = 1; i < outputs.length; i++) {
    if (outputs[i] !== outputs[0]) {
      return { verified: false, reason: "demonstration output diverged between passes" };
    }
  }
  if (outputs[0] !== check.demonstration.observedStdout) {
    return { verified: false, reason: "demonstration does not match the recorded observation" };
  }
  return { verified: true, reason: null };
}

export interface RubricHit {
  point: string;
  hit: boolean;
  /**
   * Passage from the answer supporting the judgment. Must occur in the
   * answer verbatim — the package verifies that mechanically. But it only
   * has to *mean* the point, not restate it: paraphrase counts. This splits
   * the job: code checks the excerpt is real, the model judges the meaning.
   */
  excerpt: string | null;
  /** One line on why the excerpt means the point (or why it misses). */
  why: string | null;
}

export interface Grade {
  correct: boolean;
  reason: string | null;
}

/**
 * Rubric rule, applied to every kind: correct iff every point is hit with
 * a real excerpt from the answer. Meaning counts, wording doesn't — but an
 * unsupported judgment counts for nothing. The model fills the hits later;
 * the package owns the rule so a generous grader cannot pass a partial
 * answer. Wrong-and-certain stays the headline event, so grading never
 * awards partial credit.
 */
export function gradeRubric(check: Check, answerText: string, hits: RubricHit[]): Grade {
  if (hits.length !== check.rubric.length) {
    return {
      correct: false,
      reason: `expected ${check.rubric.length} rubric judgments, got ${hits.length}`,
    };
  }
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    if (hit === undefined || hit.point !== check.rubric[i]) {
      return { correct: false, reason: "rubric judgments do not match the rubric" };
    }
    if (!hit.hit || hit.excerpt === null || hit.excerpt.length === 0) {
      return { correct: false, reason: `rubric point missed: ${hit.point}` };
    }
    if (!answerText.includes(hit.excerpt)) {
      return { correct: false, reason: `supporting passage not found in answer: ${hit.point}` };
    }
  }
  return { correct: true, reason: null };
}

/** Top-N riskiest hunks become check candidates. */
export function selectChecks(ranked: RankedHunk[], limit = 5): RankedHunk[] {
  return ranked.slice(0, Math.max(0, limit));
}

// --- Checks v2: card targeting and answer mapping (pure, no model/db) ---
//
// All five ownership kinds stay eligible as question topics: kind selection
// is a prompt instruction, not a sandbox gate. There are no executable
// demonstrations in v1 — sandbox-run drafting is cut, so every v2 question
// grades against a text rubric (MCQ by key, free-text by rubric hits) and
// `demonstration` is always null.

/**
 * Pick target card ids for a check set: riskiest first (highRisk desc, then
 * rank asc), capped at `limit` — and never padded (small sessions yield
 * fewer targets; zero cards yields none). Then one engaged spot-check: if no
 * pick is `engaged` but some card is, swap the lowest-priority non-highRisk
 * pick for the best-ranked engaged card. Single swap max; all-highRisk picks
 * never swap (risk outranks the nudge).
 */
export function selectTargets(
  cards: ChangeCard[],
  tiers: Record<string, EngagementTier>,
  limit = 5,
): string[] {
  if (cards.length === 0) return [];
  const ordered = [...cards].sort(
    (a, b) =>
      Number(b.highRisk) - Number(a.highRisk) || a.rank - b.rank || a.id.localeCompare(b.id),
  );
  const picked = ordered.slice(0, Math.max(0, Math.min(limit, ordered.length)));
  const hasEngaged = picked.some((card) => tiers[card.id] === "engaged");
  if (!hasEngaged) {
    const engaged = ordered.filter(
      (card) => tiers[card.id] === "engaged" && !picked.some((other) => other.id === card.id),
    );
    const candidate = engaged[0];
    if (candidate !== undefined) {
      // Lowest-priority non-highRisk pick = last in priority order. All
      // highRisk picks means there is no safe swap: keep risk intact.
      const swapIndex = picked.map((card) => card.highRisk).lastIndexOf(false);
      if (swapIndex >= 0) picked[swapIndex] = candidate;
    }
  }
  return picked.map((card) => card.id);
}

/** Map an attempt to its picture bucket. `confident` is `confidence !== "guessing"`. */
export function bucketFor(args: {
  attempted: boolean;
  correct: boolean;
  confident: boolean;
}): PictureBucket {
  if (!args.attempted) return "never_looked";
  if (args.correct && args.confident) return "solid";
  if (args.correct) return "right_but_unsure";
  if (args.confident) return "confident_but_wrong";
  return "wrong_and_knew_it";
}

/** MCQ scoring: strict key equality; null/undefined (no selection) is wrong. */
export function gradeMcq(
  selectedOptionId: string | null | undefined,
  correctOptionId: string,
): boolean {
  if (selectedOptionId === null || selectedOptionId === undefined) return false;
  return selectedOptionId === correctOptionId;
}
