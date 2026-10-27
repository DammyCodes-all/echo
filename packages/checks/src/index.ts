import { createHash } from "node:crypto";

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
// early helper; no model call in ranking — the model drafts questions later).
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

export type CheckKind = "predict_output" | "spot_bug";

export interface Check {
  id: string;
  kind: CheckKind;
  /** Self-contained runnable snippet under test. */
  code: string;
  question: string;
  /** Expected stdout (normalized line endings) when the reference runs. */
  referenceStdout: string;
}

export function makePredictCheck(code: string, referenceStdout: string): Check {
  const id = `chk_${createHash("sha256").update(code).digest("hex").slice(0, 12)}`;
  return {
    id,
    kind: "predict_output",
    code,
    question: "What does this snippet print to stdout?",
    referenceStdout: referenceStdout.replace(/\r\n/g, "\n"),
  };
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
 * The verification gate (BUILD-PLAN Phase 5): the reference must pass twice
 * with byte-identical stdout before a check may be asked. Any divergence or
 * failure invalidates the check — a flaky reference is a product failure, not
 * a question.
 */
export async function verifyCheck(
  check: Check,
  run: (code: string) => Promise<RunnerResult>,
  passes = 2,
): Promise<Verification> {
  const outputs: string[] = [];
  for (let i = 0; i < passes; i++) {
    const result = await run(check.code);
    if (result.status !== "ok") {
      return { verified: false, reason: `reference ${result.status} on pass ${i + 1}` };
    }
    outputs.push(result.stdout.replace(/\r\n/g, "\n"));
  }
  for (let i = 1; i < outputs.length; i++) {
    if (outputs[i] !== outputs[0]) {
      return { verified: false, reason: "reference output diverged between passes" };
    }
  }
  if (outputs[0] !== check.referenceStdout) {
    return { verified: false, reason: "reference output does not match the recorded answer" };
  }
  return { verified: true, reason: null };
}

export interface Grade {
  correct: boolean;
  reason: string | null;
}

/** Exact match on normalized stdout. Wrong-and-certain is the headline event,
 *  so grading never awards partial credit. */
export function gradeAnswer(check: Check, stdout: string, status: string): Grade {
  if (status !== "ok") return { correct: false, reason: `ran ${status}, expected ok` };
  const normalized = stdout.replace(/\r\n/g, "\n");
  if (normalized === check.referenceStdout) return { correct: true, reason: null };
  return { correct: false, reason: "stdout does not match the reference output" };
}

/** Top-N riskiest hunks become check candidates. */
export function selectChecks(ranked: RankedHunk[], limit = 5): RankedHunk[] {
  return ranked.slice(0, Math.max(0, limit));
}
