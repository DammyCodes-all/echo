import type { ChangeCard, Detour, SessionStory, StoryClaim } from "@echo/contracts";
import type { AttemptFact, FactSet, GapFact, HunkFact, PromptFact, RunFact } from "./facts";
import { type StoryValidation, validateStoryFacts } from "./validate";

/**
 * Deterministic skeleton fallback (ARCHITECTURE §12, `generate_story`
 * steps 5–6). Assembles a story from facts alone — no model, no invented
 * intent — then runs it through the validator so verification, risk and
 * counts are computed exactly as for model stories. Every skeleton claim
 * self-cites by construction; a failing verdict here is a builder bug.
 */

export const SKELETON_PROMPT_VERSION = "skeleton-v1";

export interface SkeletonMeta {
  generatedAt: string;
  /** Tape sha256, computed by the caller (the builder never sees the tape). */
  tapeSha256: string;
}

export interface SkeletonResult {
  story: SessionStory;
  validation: StoryValidation;
}

const MECHANICAL_WORDS: Record<string, string> = {
  format_only: "formatting",
  rename_only: "renames",
  generated: "generated files",
  comment_only: "comments",
};

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

function hunksOf(facts: FactSet): HunkFact[] {
  return facts.facts.filter((fact): fact is HunkFact => fact.kind === "hunk");
}

function attemptsOf(facts: FactSet): AttemptFact[] {
  return facts.facts.filter((fact): fact is AttemptFact => fact.kind === "attempt");
}

function runsOf(facts: FactSet): RunFact[] {
  return facts.facts.filter((fact): fact is RunFact => fact.kind === "run");
}

function runClaim(run: RunFact): StoryClaim {
  const outcome =
    run.outcome === "ok"
      ? `passed (exit ${run.exitCode})`
      : run.outcome === "failed"
        ? `failed (exit ${run.exitCode ?? "unknown"})`
        : "did not complete";
  return { text: `Ran ${run.command}: ${outcome}`, label: "observed", factIds: [run.id] };
}

function cardFor(hunk: HunkFact, sessionOrder: number, facts: FactSet): ChangeCard {
  const attempts = attemptsOf(facts).filter((attempt) => attempt.path === hunk.path);
  const before: StoryClaim[] =
    hunk.removedLines > 0
      ? [
          {
            text: `Removed ${hunk.removedLines} line(s) from ${hunk.path}`,
            label: "observed",
            factIds: [hunk.id],
          },
        ]
      : [];
  const now: StoryClaim[] =
    hunk.addedLines > 0
      ? [
          {
            text: `Added ${hunk.addedLines} line(s) to ${hunk.path}`,
            label: "observed",
            factIds: [hunk.id],
          },
        ]
      : [];
  // Session-level coarseness, matching the coverage rule: only passing runs
  // count as checks, and any passing run checks every card.
  const checkedBy = runsOf(facts)
    .filter((run) => run.outcome === "ok")
    .map(runClaim);
  const firstAttempt = attempts[0];
  const firstLine = hunk.addedText.split("\n").find((line) => line.trim() !== "") ?? "";
  return {
    id: hunk.hunkId,
    headline: `Change in ${hunk.path} (+${hunk.addedLines}/-${hunk.removedLines})`,
    constituentHunkIds: [hunk.hunkId],
    constituentActionIds: attempts.flatMap((attempt) =>
      attempt.toolCallId === null ? [] : [attempt.toolCallId],
    ),
    rank: 1,
    sessionOrder,
    highRisk: false,
    riskReasons: [],
    verification: "nothing",
    why: [],
    before,
    now,
    checkedBy,
    touches: [hunk.path],
    moment: {
      eventId: firstAttempt?.eventId ?? null,
      toolCallId: firstAttempt?.toolCallId ?? null,
      ts: firstAttempt?.takenAt ?? null,
      excerpt: firstLine.trim().slice(0, 120),
      label: firstAttempt ? "observed" : "uncertain",
    },
    history: { priorSessionIds: [], previousPicture: null, note: null },
  };
}

function riskiness(hunk: HunkFact): [number, number, number] {
  return [hunk.risk.flags.length, hunk.risk.boostReasons.length, hunk.risk.rewriteCount];
}

const DETOUR_STATUSES: ReadonlySet<string> = new Set([
  "reverted",
  "replaced",
  "failed_with_side_effect",
]);

const DETOUR_HEADLINES: Record<string, string> = {
  reverted: "Reverted attempt",
  replaced: "Replaced attempt",
  failed_with_side_effect: "Failed attempt with side effects",
};

export function buildSkeletonStory(facts: FactSet, meta: SkeletonMeta): SkeletonResult {
  const hunks = hunksOf(facts);
  const prompts = facts.facts.filter((fact): fact is PromptFact => fact.kind === "prompt");
  const gaps = facts.facts.filter((fact): fact is GapFact => fact.kind === "gap");

  const shortVersion: StoryClaim[] = prompts.map((prompt) => ({
    text: prompt.text,
    label: "observed",
    factIds: [prompt.id],
  }));
  const behaviorHunks = hunks.filter((hunk) => hunk.mechanical.class === null);
  const mechanicalHunks = hunks.filter((hunk) => hunk.mechanical.class !== null);

  const rankedHunks = [...behaviorHunks].sort((a, b) => {
    const [fa, ba, ra] = riskiness(a);
    const [fb, bb, rb] = riskiness(b);
    return fb - fa || bb - ba || rb - ra || a.hunkId.localeCompare(b.hunkId);
  });
  const rankOf = new Map(rankedHunks.map((hunk, index) => [hunk.hunkId, index + 1]));
  const attempts = attemptsOf(facts);
  const earliestTouch = (path: string): string => {
    const times = attempts
      .filter((attempt) => attempt.path === path)
      .map((attempt) => attempt.takenAt)
      .sort();
    return times[0] ?? "9999";
  };
  const chronoHunks = [...behaviorHunks].sort(
    (a, b) =>
      earliestTouch(a.path).localeCompare(earliestTouch(b.path)) || a.path.localeCompare(b.path),
  );
  const orderOf = new Map(chronoHunks.map((hunk, index) => [hunk.hunkId, index]));
  const cards = behaviorHunks.map((hunk) => {
    const card = cardFor(hunk, orderOf.get(hunk.hunkId) ?? 0, facts);
    card.rank = rankOf.get(hunk.hunkId) ?? 1;
    return card;
  });

  let routineSummary: string | null = null;
  if (mechanicalHunks.length > 0) {
    const kinds = [...new Set(mechanicalHunks.map((hunk) => hunk.mechanical.class))].map(
      (cls) => MECHANICAL_WORDS[cls ?? ""] ?? "mechanical edits",
    );
    const paths = [...new Set(mechanicalHunks.map((hunk) => hunk.path))];
    routineSummary = `${joinWords(kinds)} in ${paths.join(", ")} — no behaviour change.`;
  }

  const detours: Detour[] = attemptsOf(facts)
    .filter((attempt) => DETOUR_STATUSES.has(attempt.status) && attempt.introducedLines > 0)
    .map((attempt) => ({
      id: `detour-${attempt.attemptId}`,
      headline: `${DETOUR_HEADLINES[attempt.status] ?? "Dead-end attempt"} on ${attempt.path}`,
      claims: [
        {
          text: `${attempt.introducedLines} line(s) introduced, ${attempt.survivingLines} surviving`,
          label: "observed",
          factIds: [attempt.id],
        },
      ],
      attemptIds: [attempt.attemptId],
      costReason: attempt.status === "failed_with_side_effect" ? "side_effect" : "reverted",
    }));

  const promptPart = prompts.length > 0 ? "Prompts" : "No prompts recorded";
  const changePart =
    hunks.length === 0
      ? "no file changes recorded"
      : `changes in ${[...new Set(hunks.map((hunk) => hunk.path))].join(", ")}`;
  const draft: SessionStory = {
    schemaVersion: 1,
    sessionId: facts.sessionId,
    generatedAt: meta.generatedAt,
    generator: { kind: "skeleton", model: null, promptVersion: SKELETON_PROMPT_VERSION },
    tapeWatermark: { eventCount: facts.tapeEventCount, sha256: meta.tapeSha256 },
    summary: `${promptPart}, ${changePart}.`,
    skeleton: true,
    shortVersion,
    askVsResult: { asked: [...shortVersion], delivered: [], extras: [], missing: [] },
    cards,
    routineSummary,
    detours,
    looseEnds: [],
    blindSpots: gaps.map((gap) => `Capture gap: ${gap.detail}`),
    gaps: [],
    verifiedCounts: { observed: 0, partlyObserved: 0, agentStated: 0, nothing: 0, total: 0 },
  };
  const validation = validateStoryFacts(facts, draft);
  return { story: validation.story, validation };
}

/** A story is stale when the tape moved past its watermark in either count
 *  or hash. The caller (server finalization) regenerates and, unless a
 *  completed check set shares the watermark, resets check status. */
export function isStoryStale(
  story: SessionStory,
  current: { eventCount: number; sha256: string },
): boolean {
  return (
    story.tapeWatermark.eventCount !== current.eventCount ||
    story.tapeWatermark.sha256 !== current.sha256
  );
}
