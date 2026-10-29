import type { Fact, FactSet } from "./facts";

/**
 * Model narration prompt (ARCHITECTURE §12, `generate_story` step 2). Pure
 * rendering: facts in, messages out. The server re-redacts the rendered
 * prompt before sending and records this prompt version on the story.
 */
export const STORY_PROMPT_VERSION = "story-v1";

/** Per-field render caps. Truncation is marked so silence never poses as
 *  absence; the validator still checks claims against the full facts. */
const PROMPT_CAP = 2000;
const AGENT_TEXT_CAP = 1000;
const CODE_CAP = 4000;
const RUN_OUTPUT_CAP = 2000;

/** Whole-prompt cap. Past it, facts are dropped from the tail with a marker
 *  (validator checks still run against the full set, so dropped facts can
 *  only fail claims, never pass them). */
export const MAX_PROMPT_CHARS = 100_000;

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…(+${text.length - limit} chars)`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function renderFact(fact: Fact): string {
  switch (fact.kind) {
    case "prompt":
      return `[${fact.id}] prompt (evt ${fact.eventId}, seq ${fact.tapeSeq}): ${cap(oneLine(fact.text), PROMPT_CAP)}`;
    case "agent_text":
      return `[${fact.id}] agent_text (evt ${fact.eventId}, seq ${fact.tapeSeq}): ${cap(oneLine(fact.text), AGENT_TEXT_CAP)}`;
    case "hunk": {
      const flags = fact.risk.flags.map((flag) => flag.flag).join(",") || "none";
      const boost = fact.risk.unverifiedBoost
        ? ` boost=[${fact.risk.boostReasons.join("; ")}]`
        : "";
      const mechanical = fact.mechanical.class ? ` mechanical=${fact.mechanical.class}` : "";
      return (
        `[${fact.id}] hunk ${fact.hunkId} ${fact.path} ` +
        `old=${fact.oldStart}+${fact.oldLines} new=${fact.newStart}+${fact.newLines} ` +
        `added=${fact.addedLines} removed=${fact.removedLines} flags=[${flags}]${mechanical}${boost} ` +
        `rewrite=${fact.risk.rewriteCount}\n` +
        `--- added\n${cap(fact.addedText, CODE_CAP)}\n` +
        `--- removed\n${cap(fact.removedText, CODE_CAP)}`
      );
    }
    case "attempt":
      return (
        `[${fact.id}] attempt ${fact.attemptId} ${fact.path} ${fact.status} (${fact.confidence}) ` +
        `introduced=${fact.introducedLines} surviving=${fact.survivingLines} ` +
        `tool=${fact.toolCallId ?? "none"} trigger=${fact.trigger}`
      );
    case "run":
      return (
        `[${fact.id}] run ${fact.outcome} \`${fact.command}\` ` +
        `exit=${fact.exitCode ?? "unknown"} tool=${fact.toolCallId}\n` +
        `${fact.outputText === null ? "(no output)" : cap(fact.outputText, RUN_OUTPUT_CAP)}`
      );
    case "action":
      return `[${fact.id}] action ${fact.toolCallId} ${fact.name} ${fact.outcome}${fact.command ? ` \`${fact.command}\`` : ""}`;
    case "gap":
      return `[${fact.id}] gap ${fact.detail} (evt ${fact.eventId}, seq ${fact.tapeSeq})`;
  }
}

const SYSTEM_PROMPT = [
  "You write Echo session stories from deterministic facts. Reply with JSON only, no prose.",
  "Every claim MUST cite fact IDs (F1, F2, …). Never invent file paths, numbers or names:",
  "each number, path and quoted span in a claim must appear in the cited facts.",
  "Group final-diff hunks into behaviour cards: one behaviour per card, consequential",
  "non-file actions included. Detours cover abandoned attempts only; blindSpots cover",
  "capture gaps only; routineSummary is set only when every hunk is mechanical, else null.",
  "Set verification to nothing, highRisk to false, riskReasons to [] and verifiedCounts",
  "to zeros — the server recomputes them deterministically. Set skeleton to false and echo",
  "the session id and watermark; the server restamps them. shortVersion holds 2-3",
  "delivered outcomes only (what changed or shipped), never prompt echoes; leave it",
  "empty when no delivery is evidenced.",
  "Shape: {schemaVersion: 1, sessionId, generatedAt, generator: {kind: model, model,",
  "promptVersion}, tapeWatermark: {eventCount, sha256}, summary, skeleton, shortVersion:",
  "claim[], askVsResult: {asked, delivered, extras, missing}, cards: [{id, headline,",
  "constituentHunkIds, constituentActionIds, rank, sessionOrder, highRisk, riskReasons,",
  "verification, why, before, now, checkedBy, touches, moment: {eventId, toolCallId, ts,",
  "excerpt, label}, history: {priorSessionIds, previousPicture, note}}], routineSummary,",
  "detours: [{id, headline, claims, attemptIds, costReason}], looseEnds: [{id, kind, claims,",
  "cardId}], blindSpots: string[], gaps: string[], verifiedCounts: {observed, partlyObserved,",
  "agentStated, nothing, total}}. claim = {text, label: observed|agent_stated|uncertain,",
  "factIds: string[]}. Card ids are the canonical h_ hunk ids from the facts.",
].join("\n");

export interface NarrationMessages {
  system: string;
  user: string;
  /** True when facts were dropped to fit the cap; the marker names the count. */
  truncated: boolean;
}

export function buildNarrationMessages(facts: FactSet, sessionId: string): NarrationMessages {
  const head = [
    `prompt_version: ${STORY_PROMPT_VERSION}`,
    `session: ${sessionId}`,
    `tape events: ${facts.tapeEventCount}`,
    "",
    "Facts:",
  ].join("\n");
  const rendered = facts.facts.map(renderFact);
  let user = `${head}\n${rendered.join("\n\n")}`;
  let truncated = false;
  if (user.length > MAX_PROMPT_CHARS) {
    truncated = true;
    const kept: string[] = [];
    let length = head.length;
    for (const block of rendered) {
      if (length + 1 + block.length > MAX_PROMPT_CHARS) break;
      kept.push(block);
      length += 1 + block.length;
    }
    const dropped = rendered.length - kept.length;
    user = `${head}\n${kept.join("\n\n")}\n\n…(${dropped} more facts omitted over the prompt cap)`;
  }
  return { system: SYSTEM_PROMPT, user, truncated };
}
