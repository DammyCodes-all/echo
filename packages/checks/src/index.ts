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

// --- Checks v2: card targeting and answer mapping (pure, no model/db) ---
//
// All five ownership kinds stay eligible as question topics: kind selection
// is a prompt instruction, not a sandbox gate. There are no executable
// demonstrations in v1 — sandbox-run drafting is cut, so every v2 question
// grades against a text rubric (MCQ by key, free-text by rubric hits) and
// `demonstration` is always null.

/**
 * Weak picture buckets: the card was answered wrong. Learn's weak-area rule
 * and check targeting share this predicate so display and selection never
 * drift apart.
 */
export function isWeakPictureBucket(bucket: PictureBucket): boolean {
  return bucket === "confident_but_wrong" || bucket === "wrong_and_knew_it";
}

/**
 * Per-file touch counts split by weak picture entries. One entry per
 * pictured card: the card's story touches plus whether its bucket is weak.
 * Weak files are keys with confidentWrong > 0.
 */
export function weakFileCounts(
  entries: Array<{ touches: string[]; weak: boolean }>,
): Map<string, { confidentWrong: number; total: number }> {
  const counts = new Map<string, { confidentWrong: number; total: number }>();
  for (const entry of entries) {
    for (const file of entry.touches) {
      const slot = counts.get(file) ?? { confidentWrong: 0, total: 0 };
      slot.total += 1;
      if (entry.weak) slot.confidentWrong += 1;
      counts.set(file, slot);
    }
  }
  return counts;
}

/** Files with at least one weak picture entry (confidentWrong > 0). */
export function weakFiles(entries: Array<{ touches: string[]; weak: boolean }>): Set<string> {
  const weak = new Set<string>();
  for (const [file, counts] of weakFileCounts(entries)) {
    if (counts.confidentWrong > 0) weak.add(file);
  }
  return weak;
}

/**
 * Pick target card ids for a check set: riskiest first (highRisk desc), then
 * cross-session weak touches (cards touching files the project got wrong
 * before rank above same-risk cards touching only fresh files), then rank
 * asc — capped at `limit`, never padded (small sessions yield fewer targets;
 * zero cards yields none). Then one engaged spot-check: if no pick is
 * `engaged` but some card is, swap the lowest-priority non-highRisk pick for
 * the best-ranked engaged card. Single swap max; all-highRisk picks never
 * swap (risk outranks the nudge). The weak signal never outranks highRisk
 * either: it reorders within a risk tier only.
 */
export function selectTargets(
  cards: ChangeCard[],
  tiers: Record<string, EngagementTier>,
  limit = 5,
  weakFiles?: ReadonlySet<string>,
): string[] {
  if (cards.length === 0) return [];
  const weakTouches = (card: ChangeCard): number =>
    weakFiles === undefined ? 0 : card.touches.filter((file) => weakFiles.has(file)).length;
  const ordered = [...cards].sort(
    (a, b) =>
      Number(b.highRisk) - Number(a.highRisk) ||
      weakTouches(b) - weakTouches(a) ||
      a.rank - b.rank ||
      a.id.localeCompare(b.id),
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
