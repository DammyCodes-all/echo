import type { ChangeCard, SessionStory, StoryClaim, VerificationBadge } from "@echo/contracts";
import type { AttemptFact, Fact, FactSet, HunkFact, RunFact } from "./facts";

/**
 * Deterministic story validator (ARCHITECTURE §12, `generate_story` step 3).
 * Checks every claim's numbers, file paths and quoted spans against the cited
 * facts, then overwrites verification and risk from the fact set — never
 * trusted from the model. Claims stay in place with verdicts; the server
 * regenerates once per failed claim and calls {@link dropFailedClaims} for
 * whatever still fails.
 */

export interface ClaimLocation {
  area: "card" | "detour" | "looseEnd" | "shortVersion" | "askVsResult" | "storyText";
  /** Card, detour or loose-end id; null outside those areas. */
  key: string | null;
  /** Claim field, or bare-string field name for storyText. */
  field: string;
  /** Claim index, or -1 for singular bare strings. */
  index: number;
}

export interface ClaimVerdict {
  location: ClaimLocation;
  claimText: string;
  factIds: string[];
  valid: boolean;
  errors: string[];
}

export interface StoryValidation {
  story: SessionStory;
  verdicts: ClaimVerdict[];
  diagnostics: string[];
}

const NUMBER_TOKEN = /\d+/g;
// A path token starts with a letter (so `1.3` stays a number) and either has
// a dotted extension or contains a slash next to a letter (so `3/9` stays a
// number pair).
const PATH_TOKEN =
  /[A-Za-z@_][A-Za-z0-9_@./-]*\.[a-z0-9]{1,10}\b|[A-Za-z0-9_@.-]*[A-Za-z][A-Za-z0-9_@.-]*\/[A-Za-z0-9_@./-]+/g;
const QUOTE_TOKEN = /`([^`]+)`/g;

function tokens(text: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  const found: string[] = [];
  let match = pattern.exec(text);
  while (match) {
    found.push(match[0]);
    match = pattern.exec(text);
  }
  return found;
}

function quotesIn(text: string): string[] {
  QUOTE_TOKEN.lastIndex = 0;
  const found: string[] = [];
  let match = QUOTE_TOKEN.exec(text);
  while (match) {
    if (match[1]) found.push(match[1]);
    match = QUOTE_TOKEN.exec(text);
  }
  return found;
}

interface FactSurface {
  texts: string[];
  numbers: Set<string>;
  paths: Set<string>;
}

function surfaceOf(fact: Fact): FactSurface {
  switch (fact.kind) {
    case "prompt":
    case "agent_text":
      return { texts: [fact.text], numbers: new Set(), paths: new Set() };
    case "hunk":
      return {
        texts: [fact.path, fact.addedText, fact.removedText],
        numbers: new Set(
          [
            fact.oldStart,
            fact.oldLines,
            fact.newStart,
            fact.newLines,
            fact.addedLines,
            fact.removedLines,
          ].map(String),
        ),
        paths: new Set([fact.path]),
      };
    case "attempt":
      return {
        texts: [fact.path, fact.trigger, fact.status],
        numbers: new Set([fact.introducedLines, fact.survivingLines].map(String)),
        paths: new Set([fact.path]),
      };
    case "run":
      return {
        texts: fact.outputText === null ? [fact.command] : [fact.command, fact.outputText],
        numbers: new Set(fact.exitCode === null ? [] : [String(fact.exitCode)]),
        paths: new Set(),
      };
    case "action":
      return {
        texts: fact.command === null ? [fact.name] : [fact.name, fact.command],
        numbers: new Set(),
        paths: new Set(),
      };
    case "gap":
      return {
        texts: [fact.code, fact.detail],
        numbers: new Set(
          [fact.fromSequence, fact.toSequence].filter((n): n is number => n !== null).map(String),
        ),
        paths: new Set(),
      };
  }
}

/** Evidence linkage: a cited attempt also brings its path's hunks (and vice
 *  versa); a cited run brings its action (and vice versa). A claim citing the
 *  edit event can then quote the hunk code it produced. */
function linkedFacts(cited: Fact[], all: Fact[]): Fact[] {
  const extra: Fact[] = [];
  for (const fact of cited) {
    if (fact.kind === "attempt" || fact.kind === "hunk") {
      for (const other of all) {
        if (
          (other.kind === "attempt" || other.kind === "hunk") &&
          other.path === fact.path &&
          other.id !== fact.id
        ) {
          extra.push(other);
        }
      }
    }
    if (fact.kind === "run" || fact.kind === "action") {
      for (const other of all) {
        if (
          (other.kind === "run" || other.kind === "action") &&
          other.toolCallId === fact.toolCallId &&
          other.id !== fact.id
        ) {
          extra.push(other);
        }
      }
    }
  }
  return extra;
}

function standaloneNumber(text: string, number: string): boolean {
  return new RegExp(`(?:^|\\D)${number}(?=\\D|$)`).test(text);
}

function checkClaim(text: string, factIds: string[], facts: FactSet): string[] {
  const errors: string[] = [];
  const byId = new Map(facts.facts.map((fact) => [fact.id, fact]));
  const cited: Fact[] = [];
  for (const id of factIds) {
    const fact = byId.get(id);
    if (!fact) errors.push(`unknown fact id ${id}`);
    else cited.push(fact);
  }
  const surfaceFacts = [...cited, ...linkedFacts(cited, facts.facts)];
  const texts = surfaceFacts.flatMap((fact) => surfaceOf(fact).texts);
  const numbers = new Set(surfaceFacts.flatMap((fact) => [...surfaceOf(fact).numbers]));
  const paths = new Set(surfaceFacts.flatMap((fact) => [...surfaceOf(fact).paths]));
  for (const text of texts) {
    for (const token of tokens(text, PATH_TOKEN)) paths.add(token);
  }
  for (const number of tokens(text, NUMBER_TOKEN)) {
    if (!numbers.has(number) && !texts.some((entry) => standaloneNumber(entry, number))) {
      errors.push(`number ${number} not in cited evidence`);
    }
  }
  for (const token of tokens(text, PATH_TOKEN)) {
    if (!paths.has(token)) errors.push(`path ${token} not in cited evidence`);
  }
  const joined = texts.join("\n");
  for (const quote of quotesIn(text)) {
    if (!joined.includes(quote))
      errors.push(`quote ${JSON.stringify(quote)} not in cited evidence`);
  }
  return errors;
}

interface LocatedClaim {
  location: ClaimLocation;
  text: string;
  factIds: string[];
  /** Bare story strings validate loosely against the whole fact set. */
  wholeSet: boolean;
}

function collectClaims(story: SessionStory): LocatedClaim[] {
  const found: LocatedClaim[] = [];
  const claim = (
    area: ClaimLocation["area"],
    key: string | null,
    field: string,
    list: StoryClaim[],
  ) => {
    list.forEach((entry, index) => {
      found.push({
        location: { area, key, field, index },
        text: entry.text,
        factIds: entry.factIds,
        wholeSet: false,
      });
    });
  };
  claim("shortVersion", null, "shortVersion", story.shortVersion);
  claim("askVsResult", null, "asked", story.askVsResult.asked);
  claim("askVsResult", null, "delivered", story.askVsResult.delivered);
  claim("askVsResult", null, "extras", story.askVsResult.extras);
  claim("askVsResult", null, "missing", story.askVsResult.missing);
  for (const card of story.cards) {
    claim("card", card.id, "why", card.why);
    claim("card", card.id, "before", card.before);
    claim("card", card.id, "now", card.now);
    claim("card", card.id, "checkedBy", card.checkedBy);
  }
  for (const detour of story.detours) {
    claim("detour", detour.id, "claims", detour.claims);
  }
  for (const looseEnd of story.looseEnds) {
    claim("looseEnd", looseEnd.id, "claims", looseEnd.claims);
  }
  const bare = (field: string, text: string | null, index: number) => {
    if (text !== null) {
      found.push({
        location: { area: "storyText", key: null, field, index },
        text,
        factIds: [],
        wholeSet: true,
      });
    }
  };
  bare("summary", story.summary, -1);
  bare("routineSummary", story.routineSummary, -1);
  story.blindSpots.forEach((text, index) => {
    bare("blindSpots", text, index);
  });
  story.gaps.forEach((text, index) => {
    bare("gaps", text, index);
  });
  return found;
}

function checkWholeSet(text: string, facts: FactSet): string[] {
  const all = facts.facts;
  const texts = all.flatMap((fact) => surfaceOf(fact).texts);
  const numbers = new Set(all.flatMap((fact) => [...surfaceOf(fact).numbers]));
  const paths = new Set(all.flatMap((fact) => [...surfaceOf(fact).paths]));
  for (const entry of texts) {
    for (const token of tokens(entry, PATH_TOKEN)) paths.add(token);
  }
  const errors: string[] = [];
  for (const number of tokens(text, NUMBER_TOKEN)) {
    if (!numbers.has(number) && !texts.some((entry) => standaloneNumber(entry, number))) {
      errors.push(`number ${number} not in session evidence`);
    }
  }
  for (const token of tokens(text, PATH_TOKEN)) {
    if (!paths.has(token)) errors.push(`path ${token} not in session evidence`);
  }
  return errors;
}

const FAILED_STATUSES: ReadonlySet<string> = new Set(["failed", "failed_with_side_effect"]);

function cardVerification(
  card: ChangeCard,
  hunks: HunkFact[],
  attempts: AttemptFact[],
  passingRun: boolean,
  byId: Map<string, Fact>,
): VerificationBadge {
  const cited: Fact[] = [];
  for (const list of [card.why, card.before, card.now, card.checkedBy]) {
    for (const claim of list) {
      for (const id of claim.factIds) {
        const fact = byId.get(id);
        if (fact) cited.push(fact);
      }
    }
  }
  if (cited.length === 0) return "nothing";
  const behavior = cited.filter(
    (fact) =>
      fact.kind === "hunk" ||
      fact.kind === "attempt" ||
      fact.kind === "run" ||
      fact.kind === "action",
  );
  if (behavior.length === 0) return "agent_stated";
  if (
    attempts.length > 0 &&
    attempts.every((attempt) => FAILED_STATUSES.has(attempt.status)) &&
    !passingRun
  ) {
    return "nothing";
  }
  if (hunks.some((hunk) => hunk.risk.unverifiedBoost)) return "partly_observed";
  if (attempts.some((attempt) => attempt.status === "uncertain")) return "partly_observed";
  return "observed";
}

function rollUpRisk(hunks: HunkFact[]): { highRisk: boolean; riskReasons: string[] } {
  const reasons: string[] = [];
  const seen = new Set<string>();
  const push = (reason: string) => {
    if (!seen.has(reason)) {
      seen.add(reason);
      reasons.push(reason);
    }
  };
  for (const hunk of hunks) {
    for (const flag of hunk.risk.flags) push(flag.reason);
    for (const reason of hunk.risk.boostReasons) push(reason);
    if (hunk.risk.rewriteCount > 0) {
      push(
        `rewrite: ${hunk.risk.rewriteCount} earlier attempt(s) on ${hunk.path} reverted or replaced before landing`,
      );
    }
  }
  const highRisk = hunks.some((hunk) => hunk.risk.flags.length > 0 || hunk.risk.unverifiedBoost);
  return { highRisk, riskReasons: reasons };
}

function knownEvents(facts: FactSet): Set<string> {
  const ids = new Set<string>();
  for (const fact of facts.facts) {
    if (fact.kind === "prompt" || fact.kind === "agent_text" || fact.kind === "gap")
      ids.add(fact.eventId);
    if (fact.kind === "attempt" && fact.eventId !== null) ids.add(fact.eventId);
    if (fact.kind === "run") for (const id of fact.eventIds) ids.add(id);
  }
  return ids;
}

function knownToolCalls(facts: FactSet): Set<string> {
  const ids = new Set<string>();
  for (const fact of facts.facts) {
    if (fact.kind === "attempt" && fact.toolCallId !== null) ids.add(fact.toolCallId);
    if (fact.kind === "run" || fact.kind === "action") ids.add(fact.toolCallId);
  }
  return ids;
}

function validateStructure(story: SessionStory, facts: FactSet): string[] {
  const diagnostics: string[] = [];
  if (story.sessionId !== facts.sessionId) {
    diagnostics.push(
      `story session ${story.sessionId} does not match facts session ${facts.sessionId}`,
    );
  }
  if (story.tapeWatermark.eventCount !== facts.tapeEventCount) {
    diagnostics.push(
      `story watermark counts ${story.tapeWatermark.eventCount} tape events, tape now has ${facts.tapeEventCount}`,
    );
  }
  const hunkIds = new Set(
    facts.facts.filter((fact): fact is HunkFact => fact.kind === "hunk").map((fact) => fact.hunkId),
  );
  const attemptIds = new Set(
    facts.facts
      .filter((fact): fact is AttemptFact => fact.kind === "attempt")
      .map((fact) => fact.attemptId),
  );
  const filePaths = new Set(
    facts.facts
      .filter(
        (fact): fact is HunkFact | AttemptFact => fact.kind === "hunk" || fact.kind === "attempt",
      )
      .map((fact) => fact.path),
  );
  const toolCalls = knownToolCalls(facts);
  const eventIds = knownEvents(facts);
  const cardIds = new Set(story.cards.map((card) => card.id));
  for (const card of story.cards) {
    for (const id of card.constituentHunkIds) {
      if (!hunkIds.has(id)) diagnostics.push(`card ${card.id}: unknown constituent hunk ${id}`);
    }
    for (const id of card.constituentActionIds) {
      if (!toolCalls.has(id)) diagnostics.push(`card ${card.id}: unknown constituent action ${id}`);
    }
    for (const path of card.touches) {
      if (!filePaths.has(path)) diagnostics.push(`card ${card.id}: touches unknown path ${path}`);
    }
    if (card.moment.eventId !== null && !eventIds.has(card.moment.eventId)) {
      diagnostics.push(`card ${card.id}: moment references unknown event ${card.moment.eventId}`);
    }
    if (card.moment.toolCallId !== null && !toolCalls.has(card.moment.toolCallId)) {
      diagnostics.push(
        `card ${card.id}: moment references unknown tool call ${card.moment.toolCallId}`,
      );
    }
  }
  for (const detour of story.detours) {
    for (const id of detour.attemptIds) {
      if (!attemptIds.has(id)) diagnostics.push(`detour ${detour.id}: unknown attempt ${id}`);
    }
  }
  for (const looseEnd of story.looseEnds) {
    if (looseEnd.cardId !== null && !cardIds.has(looseEnd.cardId)) {
      diagnostics.push(`loose end ${looseEnd.id}: unknown card ${looseEnd.cardId}`);
    }
  }
  return diagnostics;
}

export function validateStoryFacts(facts: FactSet, draft: SessionStory): StoryValidation {
  const verdicts: ClaimVerdict[] = collectClaims(draft).map((entry) => {
    const errors = entry.wholeSet
      ? checkWholeSet(entry.text, facts)
      : checkClaim(entry.text, entry.factIds, facts);
    return {
      location: entry.location,
      claimText: entry.text,
      factIds: entry.factIds,
      valid: errors.length === 0,
      errors,
    };
  });
  const diagnostics = validateStructure(draft, facts);
  const byId = new Map(facts.facts.map((fact) => [fact.id, fact]));
  const hunksById = new Map(
    facts.facts
      .filter((fact): fact is HunkFact => fact.kind === "hunk")
      .map((fact) => [fact.hunkId, fact]),
  );
  const attemptsByPath = new Map<string, AttemptFact[]>();
  for (const fact of facts.facts) {
    if (fact.kind !== "attempt") continue;
    const list = attemptsByPath.get(fact.path) ?? [];
    list.push(fact);
    attemptsByPath.set(fact.path, list);
  }
  const passingRun = facts.facts.some(
    (fact): fact is RunFact => fact.kind === "run" && fact.outcome === "ok",
  );
  const cards = draft.cards.map((card) => {
    const hunks = card.constituentHunkIds.flatMap((id) => {
      const hunk = hunksById.get(id);
      return hunk ? [hunk] : [];
    });
    const paths = new Set(hunks.map((hunk) => hunk.path));
    const attempts = [...paths].flatMap((path) => attemptsByPath.get(path) ?? []);
    const verification = cardVerification(card, hunks, attempts, passingRun, byId);
    const { highRisk, riskReasons } = rollUpRisk(hunks);
    return { ...card, verification, highRisk, riskReasons };
  });
  const verifiedCounts = {
    observed: cards.filter((card) => card.verification === "observed").length,
    partlyObserved: cards.filter((card) => card.verification === "partly_observed").length,
    agentStated: cards.filter((card) => card.verification === "agent_stated").length,
    nothing: cards.filter((card) => card.verification === "nothing").length,
    total: cards.length,
  };
  return { story: { ...draft, cards, verifiedCounts }, verdicts, diagnostics };
}

function dropFromList(list: StoryClaim[], doomed: Set<number>): StoryClaim[] {
  return list.filter((_, index) => !doomed.has(index));
}

/**
 * Removes failed claims after regeneration is exhausted. Each dropped claim
 * becomes an "Echo couldn't verify this" gap line; gaps are data, never
 * silent. Summaries are kept (a story needs its headline) with a diagnostic.
 */
export function dropFailedClaims(validation: StoryValidation): {
  story: SessionStory;
  dropped: ClaimVerdict[];
  diagnostics: string[];
} {
  const failed = validation.verdicts.filter((verdict) => !verdict.valid);
  const byKey = (area: ClaimLocation["area"], key: string | null, field: string): Set<number> => {
    const doomed = new Set<number>();
    for (const verdict of failed) {
      const at = verdict.location;
      if (at.area === area && at.key === key && at.field === field && at.index >= 0) {
        doomed.add(at.index);
      }
    }
    return doomed;
  };
  const story = validation.story;
  const cards = story.cards.map((card) => ({
    ...card,
    why: dropFromList(card.why, byKey("card", card.id, "why")),
    before: dropFromList(card.before, byKey("card", card.id, "before")),
    now: dropFromList(card.now, byKey("card", card.id, "now")),
    checkedBy: dropFromList(card.checkedBy, byKey("card", card.id, "checkedBy")),
  }));
  const detours = story.detours.map((detour) => ({
    ...detour,
    claims: dropFromList(detour.claims, byKey("detour", detour.id, "claims")),
  }));
  const looseEnds = story.looseEnds.map((looseEnd) => ({
    ...looseEnd,
    claims: dropFromList(looseEnd.claims, byKey("looseEnd", looseEnd.id, "claims")),
  }));
  const gaps = [...story.gaps];
  const blindSpots = story.blindSpots.filter(
    (_, index) => !byKey("storyText", null, "blindSpots").has(index),
  );
  const keptGaps = gaps.filter((_, index) => !byKey("storyText", null, "gaps").has(index));
  const dropped: ClaimVerdict[] = [];
  const diagnostics: string[] = [];
  for (const verdict of failed) {
    const at = verdict.location;
    const isKeptSummary =
      at.area === "storyText" && (at.field === "summary" || at.field === "routineSummary");
    if (isKeptSummary) {
      diagnostics.push(`${at.field} failed validation but is kept: ${verdict.errors.join("; ")}`);
      continue;
    }
    dropped.push(verdict);
    keptGaps.push(`Echo couldn't verify this: ${verdict.claimText}`);
  }
  return {
    story: { ...story, cards, detours, looseEnds, blindSpots, gaps: keptGaps },
    dropped,
    diagnostics,
  };
}
