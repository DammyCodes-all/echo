import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AskVsResult,
  type ChangeCard,
  type Detour,
  type DetourCostReason,
  type LooseEnd,
  type SessionReview,
  SessionReviewSchema,
  type SessionStory,
  SessionStorySchema,
  type StoryClaim,
  type TapeWatermark,
  type VerificationBadge,
  type VerifiedCounts,
  z,
} from "@echo/contracts";
import {
  type StoredEvent as DbStoredEvent,
  type EchoDb,
  getArtifactRef,
  getSession,
  getSessionSummary,
  readAllEvents,
  setSessionCheckStatus,
  setSessionStoryState,
  upsertArtifactRef,
} from "@echo/db";
import { type ChatMessage, type ModelConfig, modelConfigFromEnv, requestJson } from "@echo/model";
import { redactJson } from "@echo/redaction";
import { buildSessionReview } from "./review-index";
import {
  buildFacts,
  computeWatermark,
  type FactSet,
  type StoryFact,
  skeletonStory,
} from "./story-facts";

/** Prompt version recorded on model-generated stories. */
export const STORY_PROMPT_VERSION = "story-v1";

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
}

export type StoryOutcomeKind =
  | "fresh"
  | "generated"
  | "skeleton"
  | "unavailable"
  | "unknown_session";

export interface StoryOutcome {
  outcome: StoryOutcomeKind;
  story: SessionStory | null;
}

// --- Model draft schema (local: zod is not a direct server dependency) ---

const DraftClaimSchema = z.object({
  text: z.string(),
  label: z.enum(["observed", "agent_stated", "uncertain"]),
  factIds: z.array(z.string()),
});
export type DraftClaim = z.infer<typeof DraftClaimSchema>;

const DraftCardSchema = z.object({
  headline: z.string(),
  constituentHunkIds: z.array(z.string()),
  constituentActionIds: z.array(z.string()),
  why: z.array(DraftClaimSchema),
  before: z.array(DraftClaimSchema),
  now: z.array(DraftClaimSchema),
});
export type DraftCard = z.infer<typeof DraftCardSchema>;

export const StoryDraftSchema = z.object({
  summary: z.string().min(1).max(280),
  shortVersion: z.array(DraftClaimSchema).min(1).max(6),
  askVsResult: z.object({
    asked: z.array(DraftClaimSchema),
    delivered: z.array(DraftClaimSchema),
    extras: z.array(DraftClaimSchema),
    missing: z.array(DraftClaimSchema),
  }),
  cards: z.array(DraftCardSchema).min(1).max(30),
});
export type StoryDraft = z.infer<typeof StoryDraftSchema>;

// --- Deterministic validator ---

const FILE_TOKEN = /[\w./-]+\.\w+/g;
const INT_TOKEN = /\d+/g;

const BADGE_ORDER: Record<VerificationBadge, number> = {
  nothing: 0,
  agent_stated: 1,
  partly_observed: 2,
  observed: 3,
};

const HIGH_BLAST_FLAGS = new Set([
  "auth",
  "payments",
  "stored_data",
  "destructive",
  "secrets",
  "production",
]);

const RISK_SENTENCES: Record<string, string> = {
  auth: "touches auth code — confirm login and session behavior is unchanged",
  payments: "touches payment code — confirm retry counts and idempotency",
  stored_data: "touches stored data or migrations — confirm rollback is safe",
  destructive: "looks destructive — confirm nothing needed is deleted or revoked",
  secrets: "touches secrets or credentials — confirm no secret leaks into logs or diffs",
  production: "touches production or deploy config — confirm the rollout is intended",
};

const UNVERIFIED_REASON = "no observed test run covers this change";

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

interface KnownSets {
  ids: Set<string>;
  files: Set<string>;
  numbers: Set<string>;
}

function buildKnownSets(facts: FactSet): KnownSets {
  const ids = new Set<string>();
  const files = new Set<string>();
  const numbers = new Set<string>();
  for (const cluster of facts.promptClusters) ids.add(cluster.id);
  for (const fact of facts.facts) {
    ids.add(fact.id);
    for (const file of fact.files) {
      files.add(file);
      const base = file.split("/").pop();
      if (base) files.add(base);
    }
    for (const match of fact.summary.match(INT_TOKEN) ?? []) numbers.add(match);
  }
  const kindCounts = new Map<string, number>();
  for (const fact of facts.facts) {
    kindCounts.set(fact.kind, (kindCounts.get(fact.kind) ?? 0) + 1);
  }
  for (const count of [
    facts.promptClusters.length,
    facts.facts.length,
    facts.routineFactIds.length,
    ...kindCounts.values(),
  ]) {
    numbers.add(String(count));
  }
  return { ids, files, numbers };
}

/** Null when the text is fully grounded; otherwise a short reason. */
function textViolation(text: string, known: KnownSets): string | null {
  const fileTokens = text.match(FILE_TOKEN) ?? [];
  for (const token of fileTokens) {
    if (known.files.has(token)) continue;
    // A directory or path prefix of a known file (e.g. "src" for "src/app.ts").
    let isPrefix = false;
    for (const file of known.files) {
      if (file.startsWith(token)) {
        isPrefix = true;
        break;
      }
    }
    if (!isPrefix) return `unknown file ${token}`;
  }
  // Integers inside file tokens (app2.ts, utf-8) are part of the name, not claims.
  const rest = text.replace(FILE_TOKEN, " ");
  for (const num of rest.match(INT_TOKEN) ?? []) {
    if (!known.numbers.has(num)) return `unknown number ${num}`;
  }
  return null;
}

/** Story fields minus the envelope the orchestrator owns. */
export interface StoryBody {
  summary: string;
  skeleton: false;
  shortVersion: StoryClaim[];
  askVsResult: AskVsResult;
  cards: ChangeCard[];
  routineSummary: string | null;
  detours: Detour[];
  looseEnds: LooseEnd[];
  blindSpots: string[];
  gaps: string[];
  verifiedCounts: VerifiedCounts;
}

export interface ValidatedDraft {
  valid: boolean;
  story: StoryBody | null;
  /** Content-free gap lines for dropped claims. */
  dropped: string[];
  /** Reasons for the single model retry. */
  errors: string[];
}

interface CardBuild {
  card: ChangeCard;
  draftIndex: number;
  highRisk: boolean;
  flagCount: number;
}

function buildCard(
  draft: DraftCard,
  draftIndex: number,
  factsById: Map<string, StoryFact>,
  known: KnownSets,
  dropped: string[],
  errors: string[],
): ChangeCard | null {
  const hunkFacts: StoryFact[] = [];
  for (const id of draft.constituentHunkIds) {
    const fact = factsById.get(id);
    if (fact?.kind !== "hunk") {
      errors.push(`card ${draftIndex}: unknown or non-hunk constituent ${id}`);
      return null;
    }
    hunkFacts.push(fact);
  }
  const actionFacts: StoryFact[] = [];
  for (const id of draft.constituentActionIds) {
    const fact = factsById.get(id);
    if (fact?.kind !== "action") {
      errors.push(`card ${draftIndex}: unknown or non-action constituent ${id}`);
      return null;
    }
    actionFacts.push(fact);
  }
  const headlineViolation = textViolation(draft.headline, known);
  if (headlineViolation) {
    dropped.push(`Echo couldn't verify this: ${truncate(draft.headline, 160)}`);
    errors.push(
      `card ${draftIndex} headline failed (${headlineViolation}): ${truncate(draft.headline, 80)}`,
    );
    return null;
  }

  const keepClaim = (claim: DraftClaim): StoryClaim | null => {
    const unknownRef = claim.factIds.find((id) => !known.ids.has(id));
    if (unknownRef) {
      dropped.push(`Echo couldn't verify this: ${truncate(claim.text, 160)}`);
      errors.push(`dropped claim (unknown fact ${unknownRef}): ${truncate(claim.text, 80)}`);
      return null;
    }
    const violation = textViolation(claim.text, known);
    if (violation) {
      dropped.push(`Echo couldn't verify this: ${truncate(claim.text, 160)}`);
      errors.push(`dropped claim (${violation}): ${truncate(claim.text, 80)}`);
      return null;
    }
    return { text: claim.text, label: claim.label, factIds: [...claim.factIds] };
  };

  const keepClaims = (claims: DraftClaim[]): StoryClaim[] => {
    const kept: StoryClaim[] = [];
    for (const claim of claims) {
      const ok = keepClaim(claim);
      if (ok) kept.push(ok);
    }
    return kept;
  };
  const why = keepClaims(draft.why);
  const before = keepClaims(draft.before);
  const now = keepClaims(draft.now);

  // The server owns verification: weakest constituent hunk badge. Model
  // labels can never upgrade it.
  let verification: VerificationBadge = "nothing";
  if (hunkFacts.length > 0) {
    verification = hunkFacts
      .map((fact) => fact.verification)
      .reduce((weakest, badge) => (BADGE_ORDER[badge] < BADGE_ORDER[weakest] ? badge : weakest));
  }
  const flags = new Set<string>();
  for (const fact of [...hunkFacts, ...actionFacts]) {
    for (const flag of fact.riskFlags) {
      // Attempt-status carrier tokens never enter card risk.
      if (!flag.startsWith("attempt-status:")) flags.add(flag);
    }
  }
  if (verification === "nothing") flags.add("unverified");
  const highRisk = [...flags].some((flag) => HIGH_BLAST_FLAGS.has(flag));
  const riskReasons = [...flags]
    .filter((flag) => flag !== "unverified")
    .map(
      (flag) => RISK_SENTENCES[flag] ?? `flagged ${flag} — confirm before relying on this change`,
    );
  if (flags.has("unverified")) riskReasons.push(UNVERIFIED_REASON);
  const touches = [...new Set([...hunkFacts, ...actionFacts].flatMap((fact) => fact.files))];
  // checkedBy is scoped to runs plausibly covering this card's hunks:
  // a run claim only counts when its fact id is linked from a constituent.
  const allowedRuns = new Set(hunkFacts.flatMap((fact) => fact.testedByRunIds));
  const checkedBy = [...why, ...before, ...now].filter(
    (claim) => claim.factIds.length > 0 && claim.factIds.every((id) => allowedRuns.has(id)),
  );
  const firstHunk = hunkFacts[0];
  return {
    id: firstHunk?.id ?? actionFacts[0]?.id ?? `card-${draftIndex}`,
    headline: draft.headline,
    constituentHunkIds: hunkFacts.map((fact) => fact.id),
    constituentActionIds: actionFacts.map((fact) => fact.id),
    rank: draftIndex + 1,
    sessionOrder: draftIndex,
    highRisk,
    riskReasons,
    verification,
    why,
    before,
    now,
    checkedBy,
    touches,
    moment: {
      eventId: firstHunk?.eventIds[0] ?? null,
      toolCallId: null,
      ts: null,
      excerpt: firstHunk?.summary ?? draft.headline,
      label: "uncertain",
    },
    // Card history is cut-line-deferred: always empty on this slice.
    history: { priorSessionIds: [], previousPicture: null, note: null },
  };
}

function attemptStatusOf(fact: StoryFact): string | null {
  const token = fact.riskFlags.find((flag) => flag.startsWith("attempt-status:"));
  return token ? token.slice("attempt-status:".length) : null;
}

function buildDetours(facts: FactSet): Detour[] {
  const attempts = facts.facts.filter((fact) => fact.kind === "attempt");
  const byPath = new Map<string, StoryFact[]>();
  for (const fact of attempts) {
    const key = fact.files[0] ?? "";
    byPath.set(key, [...(byPath.get(key) ?? []), fact]);
  }
  const detours: Detour[] = [];
  for (const fact of attempts) {
    const status = attemptStatusOf(fact);
    const group = byPath.get(fact.files[0] ?? "") ?? [];
    let costReason: DetourCostReason | null = null;
    if (status === "failed_with_side_effect") costReason = "side_effect";
    else if (status === "reverted" || status === "replaced") costReason = "reverted";
    else if (status === "failed" && group.length >= 2) costReason = "repeated_attempt";
    if (!costReason) continue;
    detours.push({
      id: fact.id,
      headline: fact.summary,
      claims: [{ text: fact.summary, label: "uncertain", factIds: [fact.id] }],
      attemptIds: [fact.id],
      costReason,
    });
  }
  return detours;
}

function buildLooseEnds(facts: FactSet, cards: ChangeCard[]): LooseEnd[] {
  const ends: LooseEnd[] = [];
  const cardByFactId = new Map<string, string>();
  for (const card of cards) {
    for (const id of [...card.constituentHunkIds, ...card.constituentActionIds]) {
      cardByFactId.set(id, card.id);
    }
  }
  for (const fact of facts.facts) {
    if (/\b(TODO|FIXME|XXX|HACK)\b/.test(fact.summary)) {
      ends.push({
        id: `le-todo-${fact.id}`,
        kind: "todo",
        claims: [{ text: fact.summary, label: "observed", factIds: [fact.id] }],
        cardId: cardByFactId.get(fact.id) ?? null,
      });
    }
  }
  const runCount = facts.facts.filter((fact) => fact.kind === "run").length;
  if (runCount === 0) {
    for (const fact of facts.facts) {
      if (fact.kind !== "hunk" || fact.verification !== "nothing") continue;
      const file = fact.files[0] ?? "the changed file";
      ends.push({
        id: `le-untested-${fact.id}`,
        kind: "untested",
        claims: [
          { text: `no observed test run covers ${file}`, label: "uncertain", factIds: [fact.id] },
        ],
        cardId: cardByFactId.get(fact.id) ?? null,
      });
    }
  }
  return ends;
}

/**
 * Chronological card order for the risk ↔ session-order toggle: each card
 * takes the earliest tape position among its constituents' evidence events.
 * Cards with no resolvable position sort last, keeping risk order. Exported
 * for tests; the orchestrator applies it after validation on every path.
 */
export function assignSessionOrder(
  cards: ChangeCard[],
  facts: FactSet,
  events: Array<{ event_id: string; tape_seq: number }>,
): ChangeCard[] {
  const seqByEvent = new Map(events.map((event) => [event.event_id, event.tape_seq]));
  const factsById = new Map(facts.facts.map((fact) => [fact.id, fact]));
  const keyed = cards.map((card) => {
    let earliest = Number.POSITIVE_INFINITY;
    for (const id of [...card.constituentHunkIds, ...card.constituentActionIds]) {
      for (const eventId of factsById.get(id)?.eventIds ?? []) {
        const seq = seqByEvent.get(eventId);
        if (seq !== undefined && seq < earliest) earliest = seq;
      }
    }
    return { card, earliest };
  });
  const ordered = [...keyed].sort((a, b) => a.earliest - b.earliest);
  const position = new Map(ordered.map((entry, index) => [entry.card.id, index]));
  return cards.map((card) => ({
    ...card,
    sessionOrder: position.get(card.id) ?? card.sessionOrder,
  }));
}

/**
 * Pure validator: schema-parse, ground every claim against the fact set,
 * never trust the model for verification or risk. Structural failure or zero
 * surviving cards yields valid:false and the caller falls back to skeleton.
 */
export function validateDraft(draft: unknown, facts: FactSet): ValidatedDraft {
  const parsed = StoryDraftSchema.safeParse(draft);
  if (!parsed.success) {
    return { valid: false, story: null, dropped: [], errors: ["draft schema: invalid structure"] };
  }
  const known = buildKnownSets(facts);
  const factsById = new Map(facts.facts.map((fact) => [fact.id, fact]));
  const dropped: string[] = [];
  const errors: string[] = [];

  const keepClaim = (claim: DraftClaim): StoryClaim | null => {
    const unknownRef = claim.factIds.find((id) => !known.ids.has(id));
    if (unknownRef) {
      dropped.push(`Echo couldn't verify this: ${truncate(claim.text, 160)}`);
      errors.push(`dropped claim (unknown fact ${unknownRef}): ${truncate(claim.text, 80)}`);
      return null;
    }
    const violation = textViolation(claim.text, known);
    if (violation) {
      dropped.push(`Echo couldn't verify this: ${truncate(claim.text, 160)}`);
      errors.push(`dropped claim (${violation}): ${truncate(claim.text, 80)}`);
      return null;
    }
    return { text: claim.text, label: claim.label, factIds: [...claim.factIds] };
  };

  const keepClaims = (claims: DraftClaim[]): StoryClaim[] => {
    const kept: StoryClaim[] = [];
    for (const claim of claims) {
      const ok = keepClaim(claim);
      if (ok) kept.push(ok);
    }
    return kept;
  };

  const builds: CardBuild[] = [];
  const seenIds = new Set<string>();
  parsed.data.cards.forEach((card, index) => {
    const built = buildCard(card, index, factsById, known, dropped, errors);
    if (!built) return;
    if (seenIds.has(built.id)) built.id = `${built.id}-c${index}`;
    seenIds.add(built.id);
    builds.push({
      card: built,
      draftIndex: index,
      highRisk: built.highRisk,
      flagCount: built.constituentHunkIds.length + built.constituentActionIds.length,
    });
  });
  if (builds.length === 0) {
    return { valid: false, story: null, dropped, errors };
  }

  // Deterministic order: high-blast first, then most flags, then draft order.
  builds.sort(
    (a, b) =>
      Number(b.highRisk) - Number(a.highRisk) ||
      b.flagCount - a.flagCount ||
      a.draftIndex - b.draftIndex,
  );
  const cards = builds.map((build, position) => ({
    ...build.card,
    rank: position + 1,
    sessionOrder: position,
  }));

  const hunkCount = facts.facts.filter((fact) => fact.kind === "hunk").length;
  const summaryViolation = textViolation(parsed.data.summary, known);
  const firstPrompt = facts.promptClusters[0];
  const summary =
    summaryViolation || parsed.data.summary.length === 0
      ? firstPrompt
        ? firstPrompt.text.slice(0, 140)
        : `Session with ${hunkCount} changes.`
      : parsed.data.summary;

  const askVsResult: AskVsResult = {
    asked: keepClaims(parsed.data.askVsResult.asked),
    delivered: keepClaims(parsed.data.askVsResult.delivered),
    extras: keepClaims(parsed.data.askVsResult.extras),
    missing: keepClaims(parsed.data.askVsResult.missing),
  };
  const shortVersion = keepClaims(parsed.data.shortVersion);

  const detours = buildDetours(facts);
  const looseEnds = buildLooseEnds(facts, cards);
  const routineSummary =
    facts.routineFactIds.length > 0
      ? `${facts.routineFactIds.length} routine changes (formatting, generated files, lockfiles) folded.`
      : null;

  const verifiedCounts: VerifiedCounts = {
    observed: 0,
    partlyObserved: 0,
    agentStated: 0,
    nothing: 0,
    total: cards.length,
  };
  for (const card of cards) {
    if (card.verification === "observed") verifiedCounts.observed += 1;
    else if (card.verification === "partly_observed") verifiedCounts.partlyObserved += 1;
    else if (card.verification === "agent_stated") verifiedCounts.agentStated += 1;
    else verifiedCounts.nothing += 1;
  }

  return {
    valid: true,
    story: {
      summary,
      skeleton: false,
      shortVersion,
      askVsResult,
      cards,
      routineSummary,
      detours,
      looseEnds,
      blindSpots: [],
      gaps: [...dropped],
      verifiedCounts,
    },
    dropped,
    errors,
  };
}

// --- Model prompt ---

const STORY_SYSTEM_PROMPT = [
  "Narrate a coding session from FACTS ONLY.",
  "Narrate ONLY over the provided facts. Every claim must reference fact IDs.",
  "Never invent files, numbers or names: every file path, number or name in a claim must appear verbatim in the facts.",
  "Group hunks and actions into behaviour cards, riskiest first (each hunk lists its blast flags; order cards by risk).",
  "Routine change IDs are folded into one line — never make cards for them.",
  "Verification badges are assigned by the server; do not assert verification in claims.",
  `Reply with JSON: {"summary": string (<=280 chars), "shortVersion": [claim x1..6], "askVsResult": {"asked": [claim], "delivered": [claim], "extras": [claim], "missing": [claim]}, "cards": [{"headline": string, "constituentHunkIds": [hunk ids], "constituentActionIds": [action ids], "why": [claim], "before": [claim], "now": [claim]} x1..30]}.`,
  'Claim shape: {"text": string, "label": "observed"|"agent_stated"|"uncertain", "factIds": [fact ids]}.',
].join("\n");

function buildStoryPrompt(facts: FactSet): string {
  const serializable = {
    sessionId: facts.sessionId,
    promptClusters: facts.promptClusters,
    facts: facts.facts.map((fact) => ({
      id: fact.id,
      kind: fact.kind,
      summary: fact.summary,
      files: fact.files,
      riskFlags: fact.riskFlags,
      riskReasons: fact.riskReasons,
      verification: fact.verification,
    })),
    routineFactIds: facts.routineFactIds,
  };
  return [
    `FACTS:\n${JSON.stringify(serializable)}`,
    `ROUTINE IDS (fold into one line, never card): ${facts.routineFactIds.join(", ") || "(none)"}`,
  ].join("\n\n");
}

// --- Orchestrator ---

function storyArtifactPath(dataDir: string, projectId: string, sessionId: string): string {
  return join(dataDir, "projects", projectId, "sessions", sessionId, "artifacts", "story.json");
}

/**
 * Boundary normalizer: the db row carries unvalidated JSON in `redaction`.
 * Anything unexpected degrades to an unknown-version marker, never a throw.
 */
function toFactEvent(event: DbStoredEvent): Parameters<typeof buildFacts>[1][number] {
  const redaction = event.redaction;
  const version =
    redaction !== null &&
    typeof redaction === "object" &&
    typeof (redaction as { version?: unknown }).version === "string"
      ? (redaction as { version: string }).version
      : "unknown";
  const findings =
    redaction !== null &&
    typeof redaction === "object" &&
    typeof (redaction as { findings?: unknown }).findings === "number"
      ? (redaction as { findings: number }).findings
      : 0;
  return { ...event, redaction: { version, findings } };
}

export function createStoryService(deps: StoryServiceDeps, options: StoryServiceOptions = {}) {
  const { db, dataDir, log } = deps;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

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
  }): boolean {
    let scanned: unknown;
    try {
      scanned = redactJson(input.story).value;
    } catch (error) {
      // Content-free diagnostic: never log the payload that failed.
      log.error({ session_id: input.sessionId, err: String(error) }, "story redaction gate failed");
      return false;
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
    return true;
  }

  async function maybeGenerateStory(
    sessionId: string,
    opts: { reason?: string } = {},
  ): Promise<StoryOutcome> {
    const session = getSession(db, sessionId);
    if (!session) return { outcome: "unknown_session", story: null };
    const events = readAllEvents(db, sessionId);
    const watermark = computeWatermark(events);

    // Read-through cache: a matching watermark means the artifact is current.
    // The review (Git diffs) is only built when regeneration is needed.
    const existing = getArtifactRef(db, sessionId, "story");
    if (
      existing &&
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
    const facts = buildFacts(review, events.map(toFactEvent));
    const captureQuality = getSessionSummary(db, sessionId)?.captureQuality ?? "partial";

    const blindSpots = (skeleton: string[]): string[] => {
      const merged = [...skeleton];
      for (const line of review.diagnostics) {
        if (!merged.includes(line)) merged.push(line);
      }
      return merged;
    };

    const writeSkeleton = (extraGaps: string[] = []): StoryOutcome => {
      const base = skeletonStory({ sessionId, facts, watermark, captureQuality });
      base.cards = assignSessionOrder(base.cards, facts, events);
      const story = SessionStorySchema.parse({
        ...base,
        blindSpots: blindSpots(base.blindSpots),
        gaps: [...base.gaps, ...extraGaps],
      });
      if (
        !persistStory({
          projectId: session.projectId,
          sessionId,
          story,
          generator: "skeleton-v1",
          watermark,
          resetStatus: watermarkChanged,
        })
      ) {
        return { outcome: "unavailable", story: null };
      }
      return { outcome: "skeleton", story };
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

    const sendDraft = async (extra: ChatMessage | null): Promise<unknown> => {
      const messages: ChatMessage[] = [
        { role: "system", content: STORY_SYSTEM_PROMPT },
        { role: "user", content: buildStoryPrompt(facts) },
      ];
      if (extra) messages.push(extra);
      // Re-redact the model request: facts derive from redacted tape, but the
      // assembled prompt is re-scanned before it leaves the process.
      const redacted = redactJson(messages).value as ChatMessage[];
      const result = await requestJson(config, redacted, (value: unknown) => value, {
        fetchImpl,
        retryMaxTokens: Math.max(config.maxTokens * 2, 8192),
      });
      return result.value;
    };

    let draft: unknown;
    try {
      draft = await sendDraft(null);
    } catch {
      return writeSkeleton();
    }
    let validated = validateDraft(draft, facts);
    if (!validated.valid) {
      const retryNote: ChatMessage = {
        role: "user",
        content: `The previous draft failed validation:\n${validated.errors.slice(0, 12).join("\n")}\nReturn corrected JSON only, grounded in the same facts.`,
      };
      try {
        draft = await sendDraft(retryNote);
      } catch {
        return writeSkeleton();
      }
      validated = validateDraft(draft, facts);
      if (!validated.valid || !validated.story) return writeSkeleton();
    }
    const body = validated.story;
    if (!body) return writeSkeleton();
    body.cards = assignSessionOrder(body.cards, facts, events);

    const story = SessionStorySchema.parse({
      schemaVersion: 1,
      sessionId,
      generatedAt: new Date().toISOString(),
      generator: {
        kind: "model",
        model: config.model,
        promptVersion: STORY_PROMPT_VERSION,
      },
      tapeWatermark: watermark,
      ...body,
      blindSpots: blindSpots(body.blindSpots),
    });
    if (
      !persistStory({
        projectId: session.projectId,
        sessionId,
        story,
        generator: config.model,
        watermark,
        resetStatus: watermarkChanged,
      })
    ) {
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
    return { outcome: "generated", story };
  }

  return { maybeGenerateStory };
}

export type StoryService = ReturnType<typeof createStoryService>;
