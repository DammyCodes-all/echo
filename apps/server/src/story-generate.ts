import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACT_FILE_NAMES,
  type SessionStory,
  SessionStorySchema,
  type TapeEvent,
} from "@echo/contracts";
import {
  type EchoDb,
  getSession,
  maxTapeSeq,
  readEvents,
  setSessionStoryState,
  upsertArtifactRef,
} from "@echo/db";
import { type ModelConfig, ModelError, modelConfigFromEnv, requestJson } from "@echo/model";
import { redactJson, redactText } from "@echo/redaction";
import {
  buildNarrationMessages,
  buildSkeletonStory,
  type ClaimVerdict,
  dropFailedClaims,
  extractFacts,
  type FactSet,
  SKELETON_PROMPT_VERSION,
  STORY_PROMPT_VERSION,
  validateStoryFacts,
} from "@echo/story";
import type { FileAttempt, ReviewHunk } from "@echo/tape";
import { storedToTape } from "./ask";
import { buildSessionReview } from "./review-index";

/**
 * Story generation (ARCHITECTURE §12, `generate_story` steps 2–7, minus the
 * model client itself). Gathers redacted inputs, narrates with the model when
 * available (one regeneration for failed claims), else falls back to the
 * deterministic skeleton, then writes story.json through the redaction gate
 * and records the artifact ref + inbox columns.
 */

export const MAX_STORY_EVENTS = 25_000;
export const MODEL_ARTIFACT_GENERATOR = "story-v1";

export interface GatheredInputs {
  sessionId: string;
  projectId: string;
  tape: TapeEvent[];
  hunks: ReviewHunk[];
  attempts: FileAttempt[];
  rawEventCount: number;
  tapeSha256: string;
  tapeCapped: boolean;
  tapeMissing: boolean;
}

export type StoryStatus = "generated" | "degraded" | "failed" | "not_found";

export interface StoryOutcome {
  status: StoryStatus;
  story: SessionStory | null;
  path: string | null;
  generator: string | null;
  diagnostics: string[];
}

export interface StoryGenerator {
  generateStory(sessionId: string): Promise<StoryOutcome>;
}

export interface StoryServiceOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  gatherInputs?: (sessionId: string) => Promise<GatheredInputs | null>;
  redactJsonImpl?: typeof redactJson;
  redactTextImpl?: typeof redactText;
}

export function sessionStoryPath(dataDir: string, projectId: string, sessionId: string): string {
  return join(dataDir, "projects", projectId, "sessions", sessionId, ARTIFACT_FILE_NAMES.story);
}

function tapeSha256(tapePath: string): { sha256: string; missing: boolean } {
  try {
    const bytes = readFileSync(tapePath);
    return { sha256: createHash("sha256").update(bytes).digest("hex"), missing: false };
  } catch {
    return { sha256: createHash("sha256").update("").digest("hex"), missing: true };
  }
}

async function defaultGatherInputs(
  db: EchoDb,
  dataDir: string,
  sessionId: string,
): Promise<GatheredInputs | null> {
  const session = getSession(db, sessionId);
  if (!session) return null;
  const stored = readEvents(db, sessionId, 0, MAX_STORY_EVENTS, false, MAX_STORY_EVENTS);
  const tape: TapeEvent[] = [];
  for (const event of stored) {
    const mapped = storedToTape(session.id, session.projectId, event);
    if (mapped) tape.push(mapped);
  }
  const review = await buildSessionReview(db, dataDir, sessionId);
  const hunks: ReviewHunk[] = review.hunks.map((hunk) => ({
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
  }));
  const attempts: FileAttempt[] = review.attempts.map((attempt) => ({
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
  }));
  const tapePath = join(
    dataDir,
    "projects",
    session.projectId,
    "sessions",
    sessionId,
    "tape.jsonl",
  );
  const { sha256, missing } = tapeSha256(tapePath);
  return {
    sessionId: session.id,
    projectId: session.projectId,
    tape,
    hunks,
    attempts,
    rawEventCount: maxTapeSeq(db, sessionId),
    tapeSha256: sha256,
    tapeCapped: stored.length >= MAX_STORY_EVENTS,
    tapeMissing: missing,
  };
}

function describeVerdict(verdict: ClaimVerdict): string {
  const at = verdict.location;
  const where = `${at.area}${at.key ? ` ${at.key}` : ""} ${at.field}[${at.index}]`;
  return `${where}: ${verdict.errors.join("; ")}`;
}

function parseModelStory(value: unknown): SessionStory {
  return SessionStorySchema.parse(value);
}

export function createStoryService(db: EchoDb, options: StoryServiceOptions): StoryGenerator {
  const dataDir = options.dataDir;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const gather =
    options.gatherInputs ?? ((sessionId: string) => defaultGatherInputs(db, dataDir, sessionId));
  const redactJsonImpl = options.redactJsonImpl ?? redactJson;
  const redactTextImpl = options.redactTextImpl ?? redactText;

  function modelOff(): boolean {
    return env.ECHO_MODEL === "off";
  }

  async function narrate(
    config: ModelConfig,
    facts: FactSet,
    sessionId: string,
  ): Promise<{ draft: SessionStory; regenerated: boolean; diagnostics: string[] }> {
    const diagnostics: string[] = [];
    const messages = buildNarrationMessages(facts, sessionId);
    if (messages.truncated) diagnostics.push("prompt_truncated_for_model");
    // The fact set is built from redacted data; the request is re-redacted
    // anyway before it leaves the daemon.
    const user = redactTextImpl(messages.user).value;
    const retryMaxTokens = Math.max(config.maxTokens * 2, 8192);
    const first = await requestJson(
      config,
      [
        { role: "system", content: messages.system },
        { role: "user", content: user },
      ],
      parseModelStory,
      { fetchImpl, retryMaxTokens },
    );
    const validation = validateStoryFacts(facts, first.value);
    const failures = validation.verdicts.filter((verdict) => !verdict.valid);
    if (failures.length === 0) return { draft: first.value, regenerated: false, diagnostics };
    diagnostics.push(`story_claims_failed:${failures.length}`);
    const fixPrompt = [
      "The previous draft failed these checks. Fix every failure and return the full corrected JSON story, same shape:",
      ...failures.map((failure) => `- ${describeVerdict(failure)}`),
    ].join("\n");
    try {
      const second = await requestJson(
        config,
        [
          { role: "system", content: messages.system },
          { role: "user", content: user },
          { role: "assistant", content: JSON.stringify(first.value) },
          { role: "user", content: fixPrompt },
        ],
        parseModelStory,
        { fetchImpl, retryMaxTokens },
      );
      return { draft: second.value, regenerated: true, diagnostics };
    } catch {
      // The regeneration call itself failed; keep the validatable first
      // draft and let the drop step handle its failed claims.
      diagnostics.push("story_regeneration_failed");
      return { draft: first.value, regenerated: true, diagnostics };
    }
  }

  async function generateStory(sessionId: string): Promise<StoryOutcome> {
    const input = await gather(sessionId);
    if (!input) {
      return { status: "not_found", story: null, path: null, generator: null, diagnostics: [] };
    }
    const diagnostics: string[] = [];
    if (input.tapeCapped) diagnostics.push("tape_capped_for_story");
    if (input.tapeMissing) diagnostics.push("tape_file_missing");
    const facts = extractFacts({
      sessionId: input.sessionId,
      tape: input.tape,
      hunks: input.hunks,
      attempts: input.attempts,
      tapeEventCount: input.rawEventCount,
    });
    const generatedAt = clock().toISOString();
    let story: SessionStory;
    let generator: string;
    if (!modelOff()) {
      try {
        const config = modelConfigFromEnv(env);
        const narrated = await narrate(config, facts, input.sessionId);
        diagnostics.push(...narrated.diagnostics);
        const stamped: SessionStory = {
          ...narrated.draft,
          sessionId: input.sessionId,
          generatedAt,
          generator: { kind: "model", model: config.model, promptVersion: STORY_PROMPT_VERSION },
          tapeWatermark: { eventCount: facts.tapeEventCount, sha256: input.tapeSha256 },
          skeleton: false,
        };
        const validation = validateStoryFacts(facts, stamped);
        const dropped = dropFailedClaims(validation);
        if (dropped.dropped.length > 0) {
          diagnostics.push(`story_dropped_claims:${dropped.dropped.length}`);
        }
        diagnostics.push(...dropped.diagnostics);
        story = dropped.story;
        generator = MODEL_ARTIFACT_GENERATOR;
      } catch (error) {
        const code = error instanceof ModelError ? error.code : "model_error";
        diagnostics.push(`model_unavailable_skeleton:${code}`);
        const skeleton = buildSkeletonStory(facts, { generatedAt, tapeSha256: input.tapeSha256 });
        story = dropFailedClaims(skeleton.validation).story;
        generator = SKELETON_PROMPT_VERSION;
      }
    } else {
      diagnostics.push("model_off_skeleton");
      const skeleton = buildSkeletonStory(facts, { generatedAt, tapeSha256: input.tapeSha256 });
      story = dropFailedClaims(skeleton.validation).story;
      generator = SKELETON_PROMPT_VERSION;
    }

    let redacted: unknown;
    try {
      redacted = redactJsonImpl(story).value;
    } catch {
      return {
        status: "failed",
        story: null,
        path: null,
        generator,
        diagnostics: [...diagnostics, "story_redaction_failed"],
      };
    }
    const reparsed = SessionStorySchema.safeParse(redacted);
    if (!reparsed.success) {
      return {
        status: "failed",
        story: null,
        path: null,
        generator,
        diagnostics: [...diagnostics, "story_redacted_shape_invalid"],
      };
    }
    const finalStory = reparsed.data;
    const storyPath = sessionStoryPath(dataDir, input.projectId, input.sessionId);
    mkdirSync(join(dataDir, "projects", input.projectId, "sessions", input.sessionId), {
      recursive: true,
    });
    writeFileSync(storyPath, JSON.stringify(finalStory, null, 2));
    upsertArtifactRef(db, {
      sessionId: input.sessionId,
      kind: "story",
      path: storyPath,
      tapeWatermark: { eventCount: facts.tapeEventCount, sha256: input.tapeSha256 },
      generator,
      generatedAt,
    });
    setSessionStoryState(db, input.sessionId, {
      summary: finalStory.summary,
      highRiskCount: finalStory.cards.filter((card) => card.highRisk).length,
    });
    return {
      status: generator === MODEL_ARTIFACT_GENERATOR ? "generated" : "degraded",
      story: finalStory,
      path: storyPath,
      generator,
      diagnostics,
    };
  }

  return { generateStory };
}
