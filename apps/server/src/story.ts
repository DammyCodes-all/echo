import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ARTIFACT_FILE_NAMES,
  type ChangeCard,
  capStorySummary,
  type Detour,
  type DetourCostReason,
  type LooseEnd,
  type SessionReview,
  SessionReviewSchema,
  type SessionStory,
  SessionStorySchema,
  type StoryClaim,
  type TapeEvent,
  type TapeWatermark,
} from "@echo/contracts";
import {
  type EchoDb,
  getArtifactRef,
  getSession,
  getSessionLastObservedAt,
  getSessionSummary,
  readAllEvents,
  type SessionSummary,
  setSessionCheckStatus,
  setSessionStoryState,
  upsertArtifactRef,
} from "@echo/db";
import {
  type ChatMessage,
  type ModelConfig,
  ModelError,
  modelConfigFromEnv,
  requestJson,
} from "@echo/model";
import { redactJson } from "@echo/redaction";
import {
  type AttemptFact,
  buildNarrationMessages,
  buildSkeletonStory,
  type ClaimVerdict,
  dropFailedClaims,
  extractFacts,
  type FactSet,
  type HunkFact,
  SKELETON_PROMPT_VERSION,
  STORY_PROMPT_VERSION,
  validateStoryFacts,
} from "@echo/story";
import type { FileAttempt, ReviewHunk } from "@echo/tape";
import { storedToTape } from "./ask";
import { buildSessionReview } from "./review-index";

/**
 * Model-shape tolerance, applied before schema validation. The server owns
 * the story envelope (sessionId/generatedAt/generator/tapeWatermark/skeleton)
 * and stamps real values after validation, so server-owned fields are reset
 * to placeholders here instead of failing the whole draft on them. Claim
 * content itself is never normalized — the validator judges every claim.
 * Exported for unit tests; the only caller is narrate's parse step.
 */
export function normalizeDraftShape(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const draft = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...draft };
  normalized.tapeWatermark = { eventCount: 0, sha256: "server-stamped" };
  normalized.generator = {
    kind: "model",
    model: "server-stamped",
    promptVersion: "server-stamped",
  };
  const CLAIM_LABELS = ["observed", "agent_stated", "uncertain"];
  const PICTURE_BUCKETS = [
    "solid",
    "right_but_unsure",
    "confident_but_wrong",
    "wrong_and_knew_it",
    "never_looked",
  ];
  const normalizeMoment = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const copy = value as Record<string, unknown>;
    if (copy.toolCallId === "") copy.toolCallId = null;
    if (copy.ts === "") copy.ts = null;
    if (typeof copy.label !== "string" || !CLAIM_LABELS.includes(copy.label)) {
      copy.label = "uncertain";
    }
  };
  const moment = normalized.moment;
  if (moment !== null && typeof moment === "object" && !Array.isArray(moment)) {
    const copy = { ...(moment as Record<string, unknown>) };
    normalizeMoment(copy);
    if (copy.previousPicture !== null && copy.previousPicture !== undefined) {
      if (!PICTURE_BUCKETS.includes(String(copy.previousPicture))) copy.previousPicture = null;
    }
    normalized.moment = copy;
  }
  if (Array.isArray(normalized.cards)) {
    normalized.cards = (normalized.cards as unknown[]).map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const card = { ...(entry as Record<string, unknown>) };
      for (const field of ["why", "before", "now"]) {
        const claims = card[field];
        if (claims !== undefined && !Array.isArray(claims)) {
          card[field] = claims !== null && typeof claims === "object" ? [claims] : [];
        }
      }
      normalizeMoment(card.moment);
      const history = card.history;
      if (history !== null && typeof history === "object" && !Array.isArray(history)) {
        const copy = { ...(history as Record<string, unknown>) };
        if (copy.previousPicture !== null && copy.previousPicture !== undefined) {
          if (!PICTURE_BUCKETS.includes(String(copy.previousPicture))) copy.previousPicture = null;
        }
        card.history = copy;
      }
      return card;
    });
  }
  return normalized;
}

export interface StoryLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export interface StoryServiceDeps {
  db: EchoDb;
  dataDir: string;
  log: StoryLogger;
}

export interface StoryServiceOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the real redaction gate. */
  redactJsonImpl?: typeof redactJson;
  /** Injected for tests; defaults to the wall clock. */
  clock?: () => Date;
}

export type StoryOutcomeKind =
  | "fresh"
  | "generated"
  | "skeleton"
  | "waiting"
  | "unavailable"
  | "unknown_session";

export interface StoryOutcome {
  outcome: StoryOutcomeKind;
  story: SessionStory | null;
}

/**
 * A session must be event-silent this long before its story may generate.
 * Generating mid-stream narrates half-finished work, then regenerates on
 * every open; waiting for quiet keeps stories stable and the UI calm.
 */
export const STORY_QUIET_MS = 60_000;

/**
 * True when the tape's latest event is old enough (or there are no events at
 * all — nothing recorded means nothing to wait for). Unparseable timestamps
 * fail open toward generating: corrupt clocks shouldn't silence a session.
 */
export function isSessionQuiet(
  lastObservedAt: string | null,
  nowMs: number,
  quietMs: number = STORY_QUIET_MS,
): boolean {
  if (lastObservedAt === null) return true;
  const last = Date.parse(lastObservedAt);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= quietMs;
}

/** Watermark over the ordered tape: event count plus sha256 of event ids. */
export function computeWatermark(events: Array<{ event_id: string }>): TapeWatermark {
  const sha256 = createHash("sha256")
    .update(events.map((event) => event.event_id).join("\n"))
    .digest("hex");
  return { eventCount: events.length, sha256 };
}

function storyArtifactPath(dataDir: string, projectId: string, sessionId: string): string {
  return join(dataDir, "projects", projectId, "sessions", sessionId, ARTIFACT_FILE_NAMES.story);
}

function describeVerdict(verdict: ClaimVerdict): string {
  const at = verdict.location;
  const where = `${at.area}${at.key ? ` ${at.key}` : ""} ${at.field}[${at.index}]`;
  return `${where}: ${verdict.errors.join("; ")}`;
}

const TODO_PATTERN = /\b(TODO|FIXME|XXX|HACK)\b/;

function uniqueId(taken: Set<string>, base: string): string {
  let id = base;
  let suffix = 2;
  while (taken.has(id)) id = `${base}-${suffix++}`;
  taken.add(id);
  return id;
}

/**
 * Server-owned deterministic enrichment, applied BEFORE validation so every
 * added claim is checked like a model claim. The engine skeleton covers
 * reverted/replaced/failed_with_side_effect detours; the repeated-failure
 * rule (a lone `failed` attempt means little, two on one path means a
 * dead end) and the TODO/untested loose ends live here, ported from the
 * pre-merge orchestrator onto the engine FactSet.
 */
function enrichStory(facts: FactSet, story: SessionStory): SessionStory {
  const attempts = facts.facts.filter((fact): fact is AttemptFact => fact.kind === "attempt");
  const hunks = facts.facts.filter((fact): fact is HunkFact => fact.kind === "hunk");

  const detourTaken = new Set(story.detours.flatMap((detour) => detour.attemptIds));
  for (const detour of story.detours) detourTaken.add(detour.id);
  const byPath = new Map<string, AttemptFact[]>();
  for (const attempt of attempts) {
    byPath.set(attempt.path, [...(byPath.get(attempt.path) ?? []), attempt]);
  }
  const detours: Detour[] = [...story.detours];
  for (const [path, group] of byPath) {
    if (group.length < 2) continue;
    for (const attempt of group) {
      if (attempt.status !== "failed") continue;
      if (detourTaken.has(attempt.attemptId)) continue;
      const costReason: DetourCostReason = "repeated_attempt";
      detours.push({
        id: uniqueId(detourTaken, `detour-${attempt.attemptId}`),
        headline: `Repeated failed attempt on ${path}`,
        claims: [
          {
            text: `${attempt.introducedLines} line(s) introduced, ${attempt.survivingLines} surviving`,
            label: "observed",
            factIds: [attempt.id],
          },
        ],
        attemptIds: [attempt.attemptId],
        costReason,
      });
    }
  }

  const cardByHunkId = new Map<string, string>();
  for (const card of story.cards) {
    for (const id of card.constituentHunkIds) cardByHunkId.set(id, card.id);
  }
  const looseTaken = new Set(story.looseEnds.map((end) => end.id));
  const looseEnds: LooseEnd[] = [...story.looseEnds];
  for (const fact of facts.facts) {
    if (fact.kind === "hunk") {
      if (TODO_PATTERN.test(`${fact.addedText}\n${fact.removedText}`)) {
        looseEnds.push({
          id: uniqueId(looseTaken, `le-todo-${fact.hunkId}`),
          kind: "todo",
          claims: [{ text: `TODO marker in ${fact.path}`, label: "observed", factIds: [fact.id] }],
          cardId: cardByHunkId.get(fact.hunkId) ?? null,
        });
      }
    } else if (fact.kind === "prompt" || fact.kind === "agent_text") {
      if (TODO_PATTERN.test(fact.text)) {
        looseEnds.push({
          id: uniqueId(looseTaken, `le-todo-${fact.id}`),
          kind: "todo",
          claims: [{ text: "TODO marker in session text", label: "observed", factIds: [fact.id] }],
          cardId: null,
        });
      }
    }
  }
  if (!facts.facts.some((fact) => fact.kind === "run")) {
    // One end per card, not per hunk: a multi-hunk (folded) card shares a
    // single end so wide sessions don't emit a line per hunk. Hunks with no
    // card keep the old per-hunk orphan ends. Mechanical hunks (formatting,
    // lockfiles) expect no test run, so they are skipped here entirely —
    // the routine summary already names them.
    const hunksById = new Map(hunks.map((hunk) => [hunk.hunkId, hunk]));
    const covered = new Set<string>();
    for (const card of story.cards) {
      const constituents = card.constituentHunkIds.flatMap((id) => {
        const hunk = hunksById.get(id);
        return hunk && hunk.mechanical.class === null ? [hunk] : [];
      });
      if (constituents.length === 0) continue;
      for (const hunk of constituents) covered.add(hunk.hunkId);
      if (constituents.length === 1) {
        const hunk = constituents[0] as HunkFact;
        looseEnds.push({
          id: uniqueId(looseTaken, `le-untested-${hunk.hunkId}`),
          kind: "untested",
          claims: [
            {
              text: `no observed test run covers ${hunk.path}`,
              // The full tape was scanned for runs, so the absence is observed.
              label: "observed",
              factIds: [hunk.id],
            },
          ],
          cardId: card.id,
        });
      } else {
        looseEnds.push({
          id: uniqueId(looseTaken, `le-untested-${card.id}`),
          kind: "untested",
          claims: [
            {
              text: "no observed test run covers these changes",
              // The full tape was scanned for runs, so the absence is observed.
              label: "observed",
              factIds: constituents.map((hunk) => hunk.id),
            },
          ],
          cardId: card.id,
        });
      }
    }
    const orphans = hunks.filter(
      (hunk) => hunk.mechanical.class === null && !covered.has(hunk.hunkId),
    );
    if (orphans.length > 0) {
      looseEnds.push({
        id: uniqueId(looseTaken, "le-untested-uncovered"),
        kind: "untested",
        claims: [
          {
            text: "no observed test run covers these changes",
            // The full tape was scanned for runs, so the absence is observed.
            label: "observed",
            factIds: orphans.slice(0, 1).map((hunk) => hunk.id),
          },
        ],
        cardId: null,
      });
    }
  }

  // Per-hunk import gap, kept card-specific: a hunk whose attempts never
  // survived gets an uncertain note under "What checked it". This is the
  // card-level home for the "no surviving attempt evidence" boost marker now
  // that boost strings stay out of riskReasons. Runs before validation so
  // the claim is checked like any other (the path must be in the cited
  // facts); at most one note per path per card.
  const gapHunksById = new Map(hunks.map((hunk) => [hunk.hunkId, hunk]));
  const notedCards = story.cards.map((card) => {
    const byPath = new Map<string, HunkFact[]>();
    for (const id of card.constituentHunkIds) {
      const hunk = gapHunksById.get(id);
      if (!hunk) continue;
      const marker = `no surviving attempt evidence for ${hunk.path}`;
      if (!hunk.risk.boostReasons.includes(marker)) continue;
      byPath.set(hunk.path, [...(byPath.get(hunk.path) ?? []), hunk]);
    }
    if (byPath.size === 0) return card;
    const notes: StoryClaim[] = [];
    for (const [path, group] of byPath) {
      const text = `No surviving attempt evidence for ${path}`;
      if (card.checkedBy.some((claim) => claim.text === text)) continue;
      notes.push({ text, label: "uncertain", factIds: group.map((hunk) => hunk.id) });
    }
    if (notes.length === 0) return card;
    return { ...card, checkedBy: [...card.checkedBy, ...notes] };
  });

  return { ...story, cards: notedCards, detours, looseEnds };
}

/**
 * Deterministic card ordering: risk rank (high-risk first, then most risk
 * reasons, then id) and chronological sessionOrder (earliest constituent
 * tape position; cards with no resolvable position sort last).
 */
function applyOrdering(facts: FactSet, story: SessionStory, tape: TapeEvent[]): SessionStory {
  const seenIds = new Set<string>();
  const cards = story.cards.map((card, index) => {
    if (seenIds.has(card.id)) return { ...card, id: `${card.id}-c${index}` };
    seenIds.add(card.id);
    return card;
  });
  const ranked = [...cards].sort(
    (a, b) =>
      Number(b.highRisk) - Number(a.highRisk) ||
      b.riskReasons.length - a.riskReasons.length ||
      a.id.localeCompare(b.id),
  );
  const rankOf = new Map(ranked.map((card, index) => [card.id, index + 1]));

  const seqByEvent = new Map(tape.map((event) => [event.event_id, event.tape_seq]));
  const attemptsByPath = new Map<string, AttemptFact[]>();
  for (const fact of facts.facts) {
    if (fact.kind !== "attempt") continue;
    attemptsByPath.set(fact.path, [...(attemptsByPath.get(fact.path) ?? []), fact]);
  }
  const hunksById = new Map(
    facts.facts
      .filter((fact): fact is HunkFact => fact.kind === "hunk")
      .map((fact) => [fact.hunkId, fact]),
  );
  const eventsForToolCall = (toolCallId: string): string[] => {
    const ids: string[] = [];
    for (const fact of facts.facts) {
      if (fact.kind === "run" && fact.toolCallId === toolCallId) ids.push(...fact.eventIds);
      if (fact.kind === "attempt" && fact.toolCallId === toolCallId && fact.eventId !== null) {
        ids.push(fact.eventId);
      }
    }
    return ids;
  };
  const earliestOf = (card: ChangeCard): number => {
    let earliest = Number.POSITIVE_INFINITY;
    const consider = (eventId: string) => {
      const seq = seqByEvent.get(eventId);
      if (seq !== undefined && seq < earliest) earliest = seq;
    };
    for (const hunkId of card.constituentHunkIds) {
      for (const attempt of attemptsByPath.get(hunksById.get(hunkId)?.path ?? "") ?? []) {
        if (attempt.eventId !== null) consider(attempt.eventId);
      }
    }
    for (const toolCallId of card.constituentActionIds) {
      for (const eventId of eventsForToolCall(toolCallId)) consider(eventId);
    }
    return earliest;
  };
  const chrono = [...cards].sort((a, b) => earliestOf(a) - earliestOf(b));
  const orderOf = new Map(chrono.map((card, index) => [card.id, index]));
  return {
    ...story,
    cards: cards.map((card) => ({
      ...card,
      rank: rankOf.get(card.id) ?? card.rank,
      sessionOrder: orderOf.get(card.id) ?? card.sessionOrder,
    })),
  };
}

/**
 * Deterministic post-processing: server-owned enrichment (see enrichStory)
 * and card ordering (see applyOrdering) run BEFORE validation so every
 * added claim is checked like a model claim, then single-regen drop, then
 * the server-owned blind-spot diagnostics (review + capture quality) merged
 * without validation — they describe the pipeline, not the session. The
 * summary headline cap runs last: validation judges the full claims, then
 * the stored headline is cut to one short sentence. A capped summary is a
 * strict substring, so it can only drop tokens, never invent them.
 */
export function finalizeStory(args: {
  facts: FactSet;
  draft: SessionStory;
  tape: TapeEvent[];
  reviewDiagnostics: string[];
  captureQuality: string;
}): SessionStory {
  const ordered = applyOrdering(args.facts, enrichStory(args.facts, args.draft), args.tape);
  const validation = validateStoryFacts(args.facts, ordered);
  const dropped = dropFailedClaims(validation);
  const merged = [...dropped.story.blindSpots];
  for (const line of args.reviewDiagnostics) {
    if (!merged.includes(line)) merged.push(line);
  }
  if (
    (args.captureQuality === "partial" || args.captureQuality === "import_only") &&
    !merged.includes("intermediate states may not be captured")
  ) {
    merged.push("intermediate states may not be captured");
  }
  return SessionStorySchema.parse({
    ...dropped.story,
    summary: capStorySummary(dropped.story.summary),
    blindSpots: merged,
  });
}

/**
 * Whether a session story carries anything worth showing: a model narration
 * always counts, while a deterministic skeleton only counts when it found
 * prompts or changes (cards, asked/delivered prompts, short version).
 * Diagnostics alone (detours, loose ends, blind spots, gaps) are not content.
 */
export function storyHasContent(story: SessionStory): boolean {
  if (!story.skeleton) return true;
  if (story.cards.length > 0) return true;
  if (story.shortVersion.length > 0) return true;
  const asked = story.askVsResult;
  return (
    asked.asked.length > 0 ||
    asked.delivered.length > 0 ||
    asked.extras.length > 0 ||
    asked.missing.length > 0
  );
}

/**
 * Drop sessions whose story is a content-free skeleton ("No prompts
 * recorded, no file changes recorded.") from list responses. Sessions with
 * no story yet (still recording) or an unreadable artifact are kept: absence
 * of evidence is not evidence of emptiness.
 */
export function filterEmptySessions(db: EchoDb, sessions: SessionSummary[]): SessionSummary[] {
  return sessions.filter((session) => {
    const ref = getArtifactRef(db, session.id, "story");
    if (!ref) return true;
    try {
      return storyHasContent(
        SessionStorySchema.parse(JSON.parse(readFileSync(ref.path, "utf8")) as unknown),
      );
    } catch {
      return true;
    }
  });
}

export function createStoryService(deps: StoryServiceDeps, options: StoryServiceOptions = {}) {
  const { db, dataDir, log } = deps;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const redactJsonImpl = options.redactJsonImpl ?? redactJson;
  const clock = options.clock ?? (() => new Date());

  function modelOff(): boolean {
    return env.ECHO_MODEL === "off";
  }

  function persistStory(input: {
    projectId: string;
    sessionId: string;
    story: SessionStory;
    generator: string;
    watermark: TapeWatermark;
    resetStatus: boolean;
  }): SessionStory | null {
    // Session titles are stable: the first persisted summary wins. Regens
    // still refresh cards, risks and gaps, but keep the original title so
    // hierarchy navigation doesn't shift under the user. The one exception
    // is the skeleton-to-model upgrade — a deterministic fallback yields to
    // the first real narration. The headline cap applies to the carried-over
    // title too, so pre-cap long titles shrink to their first sentence on
    // the next persist while the beginning stays stable.
    const prevSummary = getSessionSummary(db, input.sessionId)?.summary ?? null;
    const prevGenerator = getArtifactRef(db, input.sessionId, "story")?.generator ?? null;
    const prevIsSkeleton = prevGenerator?.startsWith("skeleton-") ?? false;
    const nextIsSkeleton = input.generator.startsWith("skeleton-");
    const summary = capStorySummary(
      prevSummary !== null && prevSummary !== "" && (nextIsSkeleton || !prevIsSkeleton)
        ? prevSummary
        : input.story.summary,
    );
    const titled = summary === input.story.summary ? input.story : { ...input.story, summary };
    let scanned: unknown;
    try {
      scanned = redactJsonImpl(titled).value;
    } catch (error) {
      // Content-free diagnostic: never log the payload that failed.
      log.error({ session_id: input.sessionId, err: String(error) }, "story redaction gate failed");
      return null;
    }
    const story = SessionStorySchema.parse(scanned);
    const path = storyArtifactPath(dataDir, input.projectId, input.sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(story, null, 2)}\n`);
    upsertArtifactRef(db, {
      sessionId: input.sessionId,
      kind: "story",
      path,
      tapeWatermark: input.watermark,
      generator: input.generator,
      generatedAt: story.generatedAt,
    });
    setSessionStoryState(db, input.sessionId, {
      summary: story.summary,
      highRiskCount: story.cards.filter((card) => card.highRisk).length,
    });
    if (input.resetStatus) setSessionCheckStatus(db, input.sessionId, "not_checked");
    return story;
  }

  function toReviewInputs(review: SessionReview): { hunks: ReviewHunk[]; attempts: FileAttempt[] } {
    return {
      hunks: review.hunks.map((hunk) => ({
        id: hunk.id,
        path: hunk.path,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        patch: hunk.patch,
        addedText: hunk.addedText,
        removedText: hunk.removedText,
        addedLines: hunk.addedLines,
        removedLines: hunk.removedLines,
      })),
      attempts: review.attempts.map((attempt) => ({
        id: attempt.id,
        path: attempt.path,
        snapshotId: attempt.snapshotId,
        commitOid: attempt.commitOid,
        trigger: attempt.trigger,
        eventId: attempt.eventId,
        takenAt: attempt.takenAt,
        status: attempt.status,
        confidence: attempt.confidence,
        introducedLines: attempt.introducedLines,
        survivingLines: attempt.survivingLines,
        introducedText: attempt.introducedText,
        replacementText: attempt.replacementText,
        finalStart: attempt.finalStart,
        finalEnd: attempt.finalEnd,
        detail: attempt.detail,
        link: attempt.link,
      })),
    };
  }

  async function narrate(
    config: ModelConfig,
    facts: FactSet,
    sessionId: string,
  ): Promise<{ draft: SessionStory; regenerated: boolean }> {
    const messages = buildNarrationMessages(facts, sessionId);
    // The fact set is built from redacted data; the assembled request is
    // re-scanned before it leaves the process.
    const redacted = redactJsonImpl([
      { role: "system", content: messages.system },
      { role: "user", content: messages.user },
    ]).value as ChatMessage[];
    // Very large output budget on the FIRST attempt: reasoning tokens share
    // it with the visible JSON, and a starved model returns length-finish
    // with null content. Reasoning is capped separately (medium effort + env
    // override) so the budget buys draft text, not unbounded thinking.
    // Single attempt at full width: the parse/validate regens below own the
    // retry policy, and a second identical 50k call would double the worst
    // case spend for the same input.
    const wideMaxTokens = Math.max(config.maxTokens * 2, 50000);
    const wideConfig = { ...config, maxTokens: wideMaxTokens };
    const retryMaxTokens = wideMaxTokens;
    const reasoningEffort = env.META_REASONING_EFFORT ?? "medium";
    const parse = (value: unknown): SessionStory =>
      SessionStorySchema.parse(normalizeDraftShape(value));
    const request = (messages: ChatMessage[]) =>
      requestJson(wideConfig, messages, parse, { fetchImpl, retryMaxTokens, reasoningEffort });
    let first: SessionStory;
    try {
      first = (await request(redacted)).value;
    } catch (error) {
      if (error instanceof ModelError && error.code === "invalid_response") {
        // Schema failure, not a dead model: one retry with the errors spelled
        // out, then the normal validate-then-drop path decides the draft.
        const second = await request([
          ...redacted,
          {
            role: "assistant",
            content: "I will return only the corrected JSON story, same shape.",
          },
          {
            role: "user",
            content: `The previous draft failed schema validation: ${error.message.slice(0, 1200)}\nReturn ONLY the full corrected JSON story, same shape.`,
          },
        ]);
        return validateOrRegenerate(second.value, true);
      }
      throw error;
    }
    return validateOrRegenerate(first, false);

    async function validateOrRegenerate(
      draft: SessionStory,
      regenerated: boolean,
    ): Promise<{ draft: SessionStory; regenerated: boolean }> {
      const failures = validateStoryFacts(facts, draft).verdicts.filter((v) => !v.valid);
      if (failures.length === 0) return { draft, regenerated };
      const fixPrompt = [
        "The previous draft failed these checks. Fix every failure and return the full corrected JSON story, same shape:",
        ...failures.map((failure) => `- ${describeVerdict(failure)}`),
      ].join("\n");
      try {
        const second = await requestJson(
          wideConfig,
          [
            ...redacted,
            { role: "assistant", content: JSON.stringify(draft) },
            { role: "user", content: fixPrompt },
          ],
          parse,
          { fetchImpl, retryMaxTokens, reasoningEffort },
        );
        return { draft: second.value, regenerated: true };
      } catch {
        // The regeneration call itself failed; keep the validatable first
        // draft and let the drop step handle its failed claims.
        return { draft, regenerated: true };
      }
    }
  }

  async function maybeGenerateStory(
    sessionId: string,
    opts: { reason?: string } = {},
  ): Promise<StoryOutcome> {
    const session = getSession(db, sessionId);
    if (!session) return { outcome: "unknown_session", story: null };
    // Cheap quiet check first: the finalize hook fires on every poll, and an
    // active session must cost one indexed lookup — not a full tape read and
    // review — to be told "not yet".
    const nowMs = clock().getTime();
    if (!isSessionQuiet(getSessionLastObservedAt(db, sessionId), nowMs)) {
      const ref = getArtifactRef(db, sessionId, "story");
      if (ref && existsSync(ref.path)) {
        try {
          const story = SessionStorySchema.parse(
            JSON.parse(readFileSync(ref.path, "utf8")) as unknown,
          );
          return { outcome: "waiting", story };
        } catch {
          // Corrupt artifact: report waiting with nothing to show.
        }
      }
      return { outcome: "waiting", story: null };
    }
    const stored = readAllEvents(db, sessionId);
    const watermark = computeWatermark(stored);
    const tape = stored.flatMap((event) => {
      const mapped = storedToTape(session.id, session.projectId, event);
      return mapped ? [mapped] : [];
    });

    // Read-through cache: a matching watermark means the artifact is current.
    // The review (Git diffs) is only built when regeneration is needed.
    // A skeleton generator older than the current builder also regenerates,
    // so fallback improvements reach already-cached stories.
    const existing = getArtifactRef(db, sessionId, "story");
    const existingGenerator = existing?.generator;
    const skeletonSuperseded =
      existingGenerator?.startsWith("skeleton-") === true &&
      existingGenerator !== SKELETON_PROMPT_VERSION;
    if (
      existing &&
      !skeletonSuperseded &&
      existing.tapeWatermark.eventCount === watermark.eventCount &&
      existing.tapeWatermark.sha256 === watermark.sha256 &&
      existsSync(existing.path)
    ) {
      try {
        const story = SessionStorySchema.parse(
          JSON.parse(readFileSync(existing.path, "utf8")) as unknown,
        );
        return { outcome: "fresh", story };
      } catch {
        // Corrupt artifact: fall through and regenerate.
      }
    }
    const watermarkChanged =
      existing === null ||
      existing.tapeWatermark.eventCount !== watermark.eventCount ||
      existing.tapeWatermark.sha256 !== watermark.sha256;

    let review: SessionReview;
    try {
      review = await buildSessionReview(db, dataDir, sessionId);
    } catch {
      // Proceed with an empty-hunk review; the failure is surfaced as a
      // content-free diagnostic, never as fabricated hunks.
      review = SessionReviewSchema.parse({
        sessionId,
        baselineCommit: null,
        finalCommit: null,
        hunks: [],
        attempts: [],
        evidenceByHunk: {},
        diagnostics: ["review_build_failed"],
        generatedAt: new Date().toISOString(),
      });
    }
    const { hunks, attempts } = toReviewInputs(review);
    const facts = extractFacts({
      sessionId,
      tape,
      hunks,
      attempts,
      tapeEventCount: stored.length,
    });
    const captureQuality = getSessionSummary(db, sessionId)?.captureQuality ?? "partial";

    const writeSkeleton = (extraGaps: string[] = []): StoryOutcome => {
      const generatedAt = clock().toISOString();
      const skeleton = buildSkeletonStory(facts, { generatedAt, tapeSha256: watermark.sha256 });
      const story = finalizeStory({
        facts,
        draft: { ...skeleton.story, gaps: [...skeleton.story.gaps, ...extraGaps] },
        tape,
        reviewDiagnostics: review.diagnostics,
        captureQuality,
      });
      const persisted = persistStory({
        projectId: session.projectId,
        sessionId,
        story,
        generator: SKELETON_PROMPT_VERSION,
        watermark,
        resetStatus: watermarkChanged,
      });
      if (!persisted) {
        return { outcome: "unavailable", story: null };
      }
      return { outcome: "skeleton", story: persisted };
    };

    if (modelOff()) {
      log.info(
        { session_id: sessionId, reason: opts.reason ?? "finalize" },
        "story skeleton (model off)",
      );
      return writeSkeleton();
    }

    let config: ModelConfig;
    try {
      config = modelConfigFromEnv(env);
    } catch {
      return writeSkeleton();
    }

    let draft: SessionStory;
    try {
      draft = (await narrate(config, facts, sessionId)).draft;
    } catch {
      return writeSkeleton();
    }
    const generatedAt = clock().toISOString();
    const stamped: SessionStory = {
      ...draft,
      sessionId,
      generatedAt,
      generator: { kind: "model", model: config.model, promptVersion: STORY_PROMPT_VERSION },
      tapeWatermark: { eventCount: facts.tapeEventCount, sha256: watermark.sha256 },
      skeleton: false,
    };
    const story = finalizeStory({
      facts,
      draft: stamped,
      tape,
      reviewDiagnostics: review.diagnostics,
      captureQuality,
    });
    const persisted = persistStory({
      projectId: session.projectId,
      sessionId,
      story,
      generator: config.model,
      watermark,
      resetStatus: watermarkChanged,
    });
    if (!persisted) {
      // Model content failed the artifact scan: drop it, keep a skeleton
      // from the (already redacted) facts when possible.
      log.error(
        { session_id: sessionId },
        "story artifact redaction failed; falling back to skeleton",
      );
      return writeSkeleton([
        "story model content failed the redaction gate; showing skeleton instead",
      ]);
    }
    return { outcome: "generated", story: persisted };
  }

  return { maybeGenerateStory };
}

export type StoryService = ReturnType<typeof createStoryService>;
export type { StoryClaim };
