import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  bucketFor,
  gradeMcq,
  gradeRubric,
  isWeakPictureBucket,
  makeCheck,
  selectTargets,
  weakFiles,
} from "@echo/checks";
import {
  type AnswerConfidence,
  type AskEvidence,
  type ChangeCard,
  type CheckAttemptV2,
  type CheckKind,
  CheckKindSchema,
  type ChecksV2Artifact,
  ChecksV2ArtifactSchema,
  type ChecksV2Response,
  ChecksV2ResponseSchema,
  type PictureBucket,
  type PublicCheckQuestion,
  type SessionStory,
  SessionStorySchema,
  type StoredCheckQuestion,
  type TapeWatermark,
  z,
} from "@echo/contracts";
import {
  deriveEngagementTiers,
  type EchoDb,
  getArtifactRef,
  getSession,
  listSessions,
  readAllEvents,
  setSessionCheckStatus,
  upsertArtifactRef,
} from "@echo/db";
import {
  type ChatMessage,
  type ChatUsage,
  type ModelConfig,
  ModelError,
  modelConfigFromEnv,
  requestJson,
} from "@echo/model";
import { redactJson } from "@echo/redaction";
import { buildSessionReview } from "./review-index";
import { computeWatermark } from "./story";

/** Prompt version recorded on model-generated check sets. */
export const CHECK_PROMPT_VERSION = "check-v1";

/** Default overall deadline for one check action's model calls (drafts, retries, grading). */
const DEFAULT_CHECK_TIMEOUT_MS = 180_000;

/** Checks carry their own model defaults: short grounded questions need room
 *  for reasoning output but not deep thought. Explicit env always wins. */
const CHECKS_DEFAULT_MAX_TOKENS = 10_000;
const CHECKS_DEFAULT_REASONING_EFFORT = "low";

export interface ChecksV2Logger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export interface ChecksV2ServiceDeps {
  db: EchoDb;
  dataDir: string;
  log: ChecksV2Logger;
}

export interface ChecksV2ServiceOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Overall model-call deadline per user action; defaults to 180s. */
  timeoutMs?: number;
  /**
   * Demo mode: artifacts live in memory seeded from the baked file, and no
   * file, artifact-ref, or check-status write ever happens. Each service
   * instance owns its overlay (one per demo visitor).
   */
  demo?: boolean;
}

export interface ChecksV2Outcome {
  status: number;
  body: unknown;
  /** Token usage of the model call behind this outcome, when one ran. */
  usage?: ChatUsage | null;
}

// --- Local draft schema (zod is re-exported by contracts; not a direct dep) ---

const CheckDraftSchema = z.object({
  cardId: z.string().min(1),
  format: z.enum(["mcq", "free_text"]),
  kind: CheckKindSchema,
  question: z.string().min(1),
  options: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).optional(),
  correctOptionId: z.string().min(1).optional(),
  distractorSources: z.array(z.string()).optional(),
  rubric: z.array(z.string().min(1)).optional(),
  explanation: z.string().min(1),
  evidencePaths: z.array(z.string()),
});
type CheckDraft = z.infer<typeof CheckDraftSchema>;

const CheckDraftSetSchema = z.object({ questions: z.array(CheckDraftSchema) });

// Persisted artifact shape lives in contracts (the demo builder shares it).

// --- Token grounding (small local copy of the story.ts approach) ---
// Importing from story.ts would drag the whole story orchestrator into this
// module (ARCHITECTURE §4: server composes packages; sibling services stay
// decoupled), so the two tiny helpers live here.

const FILE_TOKEN = /[\w./-]+\.\w+/g;
const INT_TOKEN = /\d+/g;

interface KnownSets {
  files: Set<string>;
  numbers: Set<string>;
}

/** Null when the text is fully grounded; otherwise a short reason. */
function textViolation(text: string, known: KnownSets): string | null {
  const fileTokens = text.match(FILE_TOKEN) ?? [];
  for (const token of fileTokens) {
    if (known.files.has(token)) continue;
    let isPrefix = false;
    for (const file of known.files) {
      if (file.startsWith(token)) {
        isPrefix = true;
        break;
      }
    }
    if (!isPrefix) return `unknown file ${token}`;
  }
  const rest = text.replace(FILE_TOKEN, " ");
  for (const num of rest.match(INT_TOKEN) ?? []) {
    if (!known.numbers.has(num)) return `unknown number ${num}`;
  }
  return null;
}

function knownSetsFor(cards: ChangeCard[], patches: Map<string, string>): KnownSets {
  const files = new Set<string>();
  const numbers = new Set<string>();
  const absorbText = (text: string): void => {
    for (const match of text.match(INT_TOKEN) ?? []) numbers.add(match);
  };
  for (const card of cards) {
    for (const file of card.touches) {
      files.add(file);
      const base = file.split("/").pop();
      if (base) files.add(base);
    }
    for (const claim of [...card.why, ...card.before, ...card.now]) absorbText(claim.text);
    absorbText(card.headline);
    for (const id of card.constituentHunkIds) {
      const patch = patches.get(id);
      if (patch) {
        for (const match of patch.match(FILE_TOKEN) ?? []) files.add(match);
        absorbText(patch);
      }
    }
    numbers.add(String(card.rank));
  }
  numbers.add(String(cards.length));
  return { files, numbers };
}

// --- Grading prompt (mirrors checks.ts; same verbatim-excerpt contract) ---

const GRADING_PROMPT = [
  "Judge the user's answer against each rubric point.",
  "For every point output {point, hit, excerpt, why}: hit is true only if the answer makes the point (paraphrase counts, wording does not matter).",
  "excerpt must be a verbatim substring of the user's answer supporting the judgment, or null when the point is missed.",
  "why is one line on why the excerpt means the point (or why it misses).",
  'Reply with JSON only: {"hits": [{"point": string, "hit": boolean, "excerpt": string|null, "why": string|null}]}.',
  "Output one hit per rubric point, in order, with point copied exactly.",
].join("\n");

interface RubricHitInput {
  point: string;
  hit: boolean;
  excerpt: string | null;
  why: string | null;
}

function parseGrading(value: unknown, rubric: string[]): RubricHitInput[] {
  if (value === null || typeof value !== "object") {
    throw new ModelError("invalid_response", "grading reply was not an object");
  }
  const hits = (value as { hits?: unknown }).hits;
  if (!Array.isArray(hits) || hits.length !== rubric.length) {
    throw new ModelError("invalid_response", "grading reply must carry one hit per rubric point");
  }
  return hits.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      throw new ModelError("invalid_response", "grading hit was not an object");
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.point !== "string" ||
      typeof record.hit !== "boolean" ||
      (record.excerpt !== null && typeof record.excerpt !== "string") ||
      (record.why !== null && typeof record.why !== "string")
    ) {
      throw new ModelError("invalid_response", "grading hit has the wrong shape");
    }
    return {
      point: record.point,
      hit: record.hit,
      excerpt: record.excerpt,
      why: record.why,
    };
  });
}

// --- Generation prompt ---

const CHECK_SYSTEM_PROMPT = [
  "Write ownership checks from the session's story cards. Exactly one question per target, grounded ONLY in that target's card block.",
  "Every file path, number or name must appear verbatim in the target card block. Never invent alternatives from outside knowledge.",
  "MCQ distractors must be plausible tape-grounded alternatives (for example the reverted approach from the detour notes); record each distractor's source as a fact or attempt id in distractorSources.",
  'Reply with JSON only: {"questions": [{"cardId": string, "format": "mcq"|"free_text", "kind": "consequence"|"decision"|"tradeoff"|"blast_radius"|"teach_back", "question": string, "options": [{"id": string, "text": string}] (mcq only, min 2), "correctOptionId": string (mcq only, one of the option ids), "distractorSources": [string] (mcq only), "rubric": [string] (free_text only, min 1), "explanation": string, "evidencePaths": [string]}]}.',
].join("\n");

function kindForCard(card: ChangeCard, index: number): CheckKind {
  // High-risk cards always get teach-back (free text): the riskiest change
  // deserves an explanation, not a guess. Otherwise cycle the kinds so a
  // session sees a mix; format follows from kind.
  if (card.highRisk) return "teach_back";
  const cycle: CheckKind[] = ["consequence", "decision", "tradeoff", "blast_radius"];
  return cycle[index % cycle.length] as CheckKind;
}

function formatForKind(kind: CheckKind): "mcq" | "free_text" {
  return kind === "consequence" || kind === "decision" ? "mcq" : "free_text";
}

function claimLines(claims: Array<{ text: string }>): string {
  return claims.length > 0 ? claims.map((claim) => `- ${claim.text}`).join("\n") : "(none)";
}

function targetBlock(
  card: ChangeCard,
  index: number,
  patches: Map<string, string>,
  detours: SessionStory["detours"],
): string {
  const kind = kindForCard(card, index);
  const lines = [
    `TARGET cardId=${card.id} format=${formatForKind(kind)} kind=${kind}`,
    `Headline: ${card.headline}`,
    `Touches: ${card.touches.join(", ") || "(none)"}`,
    `Risk: ${card.riskReasons.join("; ") || "(none)"}`,
    `Why:\n${claimLines(card.why)}`,
    `Before:\n${claimLines(card.before)}`,
    `Now:\n${claimLines(card.now)}`,
  ];
  const cardPatches = card.constituentHunkIds
    .map((id) => patches.get(id))
    .filter((patch): patch is string => typeof patch === "string");
  lines.push(
    cardPatches.length > 0 ? `Patches:\n${cardPatches.join("\n---\n")}` : "Patches: (none)",
  );
  const notes = detours.filter((detour) =>
    detour.claims.some((claim) =>
      claim.factIds.some(
        (id) => card.constituentHunkIds.includes(id) || card.constituentActionIds.includes(id),
      ),
    ),
  );
  lines.push(
    notes.length > 0
      ? `Detour notes:\n${notes.map((detour) => `- ${detour.headline} (${detour.costReason})`).join("\n")}`
      : "Detour notes: (none)",
  );
  return lines.join("\n");
}

function questionIdFor(cardId: string, question: string): string {
  return `chk2_${createHash("sha256").update(`${cardId}:${question}:${randomUUID()}`).digest("hex").slice(0, 12)}`;
}

function attemptIdFor(questionId: string): string {
  return `att2_${createHash("sha256").update(`${questionId}:${randomUUID()}`).digest("hex").slice(0, 12)}`;
}

function toPublicQuestion(question: StoredCheckQuestion): PublicCheckQuestion {
  if (question.format === "mcq") {
    return {
      id: question.id,
      cardId: question.cardId,
      kind: question.kind,
      question: question.question,
      evidenceFactIds: question.evidenceFactIds,
      evidencePaths: question.evidencePaths,
      format: "mcq",
      options: question.options,
    };
  }
  return {
    id: question.id,
    cardId: question.cardId,
    kind: question.kind,
    question: question.question,
    evidenceFactIds: question.evidenceFactIds,
    evidencePaths: question.evidencePaths,
    format: "free_text",
  };
}

export function createChecksV2Service(
  deps: ChecksV2ServiceDeps,
  options: ChecksV2ServiceOptions = {},
) {
  const { db, dataDir, log } = deps;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  function artifactPath(projectId: string, sessionId: string): string {
    return join(
      dataDir,
      "projects",
      projectId,
      "sessions",
      sessionId,
      "artifacts",
      "checks_v2.json",
    );
  }

  function storyArtifactPath(projectId: string, sessionId: string): string {
    return join(dataDir, "projects", projectId, "sessions", sessionId, "artifacts", "story.json");
  }

  function loadStory(projectId: string, sessionId: string): SessionStory | null {
    const ref = getArtifactRef(db, sessionId, "story");
    const candidates =
      ref && typeof ref.path === "string" && ref.path.length > 0
        ? [ref.path, storyArtifactPath(projectId, sessionId)]
        : [storyArtifactPath(projectId, sessionId)];
    const seen = new Set<string>();
    for (const path of candidates) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (!existsSync(path)) continue;
      try {
        const parsed = SessionStorySchema.safeParse(
          JSON.parse(readFileSync(path, "utf8")) as unknown,
        );
        if (parsed.success) return parsed.data;
      } catch {
        // Unusable story counts as no story; the caller reports it.
      }
    }
    return null;
  }

  const demoMemory = new Map<string, ChecksV2Artifact | null>();

  function loadArtifact(projectId: string, sessionId: string): ChecksV2Artifact | null {
    if (options.demo === true) {
      const key = `${projectId}/${sessionId}`;
      if (!demoMemory.has(key)) demoMemory.set(key, loadArtifactFile(projectId, sessionId));
      return demoMemory.get(key) ?? null;
    }
    return loadArtifactFile(projectId, sessionId);
  }

  function loadArtifactFile(projectId: string, sessionId: string): ChecksV2Artifact | null {
    const path = artifactPath(projectId, sessionId);
    if (!existsSync(path)) return null;
    try {
      const parsed = ChecksV2ArtifactSchema.safeParse(
        JSON.parse(readFileSync(path, "utf8")) as unknown,
      );
      // A corrupt artifact reads as no set: gaps are data, and a bad write
      // must not brick the whole check flow.
      if (!parsed.success) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  /** Redaction gate + schema check shared by the file and demo-memory sinks. */
  function scanArtifact(artifact: ChecksV2Artifact): ChecksV2Artifact | null {
    let scanned: unknown;
    try {
      scanned = redactJson(artifact).value;
    } catch (error) {
      // Content-free diagnostic: never log the payload that failed.
      log.error(
        { session_id: artifact.sessionId, err: String(error) },
        "checks-v2 redaction gate failed",
      );
      return null;
    }
    const parsed = ChecksV2ArtifactSchema.safeParse(scanned);
    if (!parsed.success) {
      log.error({ session_id: artifact.sessionId }, "checks-v2 artifact failed schema check");
      return null;
    }
    return parsed.data;
  }

  /** Redacts then writes; false means nothing was persisted (fail closed). */
  function persistArtifact(projectId: string, artifact: ChecksV2Artifact): boolean {
    const parsed = scanArtifact(artifact);
    if (!parsed) return false;
    if (options.demo === true) {
      demoMemory.set(`${projectId}/${artifact.sessionId}`, parsed);
      return true;
    }
    const path = artifactPath(projectId, artifact.sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    upsertArtifactRef(db, {
      sessionId: artifact.sessionId,
      kind: "checks_v2",
      path,
      tapeWatermark: artifact.tapeWatermark,
      generator: CHECK_PROMPT_VERSION,
      generatedAt: artifact.generatedAt,
    });
    return true;
  }

  function toPublic(artifact: ChecksV2Artifact): ChecksV2Response {
    const body: ChecksV2Response = {
      schemaVersion: 1,
      sessionId: artifact.sessionId,
      status: artifact.status,
      generatedAt: artifact.generatedAt,
      tapeWatermark: artifact.tapeWatermark,
      questions: artifact.questions.map(toPublicQuestion),
      attempts: artifact.attempts,
      picture: artifact.picture,
      currentQuestionId: artifact.currentQuestionId,
    };
    // Fail fast if the stored/public shapes ever drift apart.
    return ChecksV2ResponseSchema.parse(body);
  }

  function emptyOffered(sessionId: string, watermark: TapeWatermark): ChecksV2Response {
    return ChecksV2ResponseSchema.parse({
      schemaVersion: 1,
      sessionId,
      status: "offered",
      generatedAt: new Date().toISOString(),
      tapeWatermark: watermark,
      questions: [],
      attempts: [],
      picture: [],
      currentQuestionId: null,
    });
  }

  function resolveConfig(): ModelConfig {
    if (env.ECHO_MODEL === "off") {
      throw new ModelError("model_error", "ECHO_MODEL=off");
    }
    const config = modelConfigFromEnv(env);
    const explicitMax = Number.parseInt(env.META_MAX_TOKENS ?? "", 10);
    return {
      ...config,
      maxTokens:
        Number.isFinite(explicitMax) && explicitMax > 0
          ? config.maxTokens
          : CHECKS_DEFAULT_MAX_TOKENS,
      reasoningEffort: config.reasoningEffort ?? CHECKS_DEFAULT_REASONING_EFFORT,
    };
  }

  function unavailable(error: unknown): ChecksV2Outcome {
    const message = error instanceof Error ? error.message : "model unavailable";
    return { status: 503, body: { error: { code: "check_unavailable", message } } };
  }

  /**
   * Overall deadline for one action's model calls. The race (not just the
   * abort) decides the outcome, so even a fetch that ignores the signal
   * cannot stick the request: the HTTP handler always answers.
   */
  async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const label = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ModelError("model_error", `check timed out after ${label}`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([run(controller.signal), expired]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function loadPatches(sessionId: string, cards: ChangeCard[]): Promise<Map<string, string>> {
    const patches = new Map<string, string>();
    try {
      const review = await buildSessionReview(db, dataDir, sessionId);
      for (const hunk of review.hunks) patches.set(hunk.id, hunk.patch.slice(0, 2000));
    } catch {
      // Review failure tolerates patches omitted: the card text still
      // grounds the questions, and gaps stay visible as missing patches.
    }
    void cards;
    return patches;
  }

  function validateDraft(
    draft: CheckDraft,
    targetsById: Map<string, ChangeCard>,
    known: KnownSets,
  ): { question: StoredCheckQuestion | null; errors: string[] } {
    const errors: string[] = [];
    const card = targetsById.get(draft.cardId);
    if (!card) {
      return { question: null, errors: [`unknown target card ${draft.cardId}`] };
    }
    for (const [label, text] of [
      ["question", draft.question],
      ["explanation", draft.explanation],
    ] as const) {
      const violation = textViolation(text, known);
      if (violation) {
        errors.push(`card ${draft.cardId} ${label} failed grounding (${violation})`);
        return { question: null, errors };
      }
    }
    if (draft.format === "mcq") {
      const options = draft.options ?? [];
      if (options.length < 2) {
        return { question: null, errors: [`card ${draft.cardId}: mcq needs at least 2 options`] };
      }
      const ids = new Set(options.map((option) => option.id));
      if (ids.size !== options.length) {
        return { question: null, errors: [`card ${draft.cardId}: mcq option ids must be unique`] };
      }
      if (!draft.correctOptionId || !ids.has(draft.correctOptionId)) {
        return {
          question: null,
          errors: [`card ${draft.cardId}: mcq key must be one of the option ids`],
        };
      }
      for (const option of options) {
        const violation = textViolation(option.text, known);
        if (violation) {
          return {
            question: null,
            errors: [`card ${draft.cardId} option failed grounding (${violation})`],
          };
        }
      }
      return {
        question: {
          id: questionIdFor(draft.cardId, draft.question),
          cardId: draft.cardId,
          kind: draft.kind,
          question: draft.question,
          evidenceFactIds: [...new Set(draft.distractorSources ?? [])],
          evidencePaths: draft.evidencePaths,
          format: "mcq",
          options: options.map((option) => ({ id: option.id, text: option.text })),
          correctOptionId: draft.correctOptionId,
          distractorSources: draft.distractorSources ?? [],
          explanation: draft.explanation,
        },
        errors,
      };
    }
    const rubric = draft.rubric ?? [];
    if (rubric.length < 1) {
      return { question: null, errors: [`card ${draft.cardId}: free_text needs a rubric`] };
    }
    for (const point of rubric) {
      const violation = textViolation(point, known);
      if (violation) {
        return {
          question: null,
          errors: [`card ${draft.cardId} rubric failed grounding (${violation})`],
        };
      }
    }
    return {
      question: {
        id: questionIdFor(draft.cardId, draft.question),
        cardId: draft.cardId,
        kind: draft.kind,
        question: draft.question,
        evidenceFactIds: [...new Set(draft.distractorSources ?? [])],
        evidencePaths: draft.evidencePaths,
        format: "free_text",
        rubric,
        explanation: draft.explanation,
      },
      errors,
    };
  }

  /**
   * One model call drafts the whole set; invalid drafts get a single retry
   * with the error list. Surviving questions are keyed by card (latest wins).
   */
  async function draftQuestions(
    config: ModelConfig,
    targets: ChangeCard[],
    story: SessionStory,
    patches: Map<string, string>,
    signal: AbortSignal,
  ): Promise<{ questions: StoredCheckQuestion[]; errors: string[] }> {
    const targetsById = new Map(targets.map((card) => [card.id, card]));
    const known = knownSetsFor(targets, patches);
    const orderedBlocks = targets.map((card, index) =>
      targetBlock(card, index, patches, story.detours),
    );
    const sendDraft = async (extra: ChatMessage | null): Promise<unknown> => {
      const messages: ChatMessage[] = [
        { role: "system", content: CHECK_SYSTEM_PROMPT },
        { role: "user", content: `CARDS:\n\n${orderedBlocks.join("\n\n")}` },
      ];
      if (extra) messages.push(extra);
      // Re-redact the model request: card text derives from redacted tape,
      // but the assembled prompt is re-scanned before it leaves the process.
      const redacted = redactJson(messages).value as ChatMessage[];
      const result = await requestJson(config, redacted, (value: unknown) => value, {
        fetchImpl,
        retryMaxTokens: Math.max(config.maxTokens * 2, 8192),
        signal,
      });
      return result.value;
    };

    const collect = (raw: unknown): { questions: StoredCheckQuestion[]; errors: string[] } => {
      const questions: StoredCheckQuestion[] = [];
      const errors: string[] = [];
      const parsed = CheckDraftSetSchema.safeParse(raw);
      if (!parsed.success) {
        return { questions, errors: ["draft set: invalid structure"] };
      }
      for (const draft of parsed.data.questions) {
        const validated = validateDraft(draft, targetsById, known);
        errors.push(...validated.errors);
        if (validated.question) {
          const existing = questions.findIndex(
            (entry) => entry.cardId === validated.question?.cardId,
          );
          if (existing >= 0) questions[existing] = validated.question as StoredCheckQuestion;
          else questions.push(validated.question);
        }
      }
      return { questions, errors };
    };

    let raw: unknown;
    raw = await sendDraft(null);
    let { questions, errors } = collect(raw);
    const missing = targets.filter((card) => !questions.some((entry) => entry.cardId === card.id));
    if (missing.length > 0) {
      const retryNote: ChatMessage = {
        role: "user",
        content: `The previous draft failed validation:\n${errors.slice(0, 12).join("\n")}\nReturn corrected JSON only, grounded in the same cards.`,
      };
      raw = await sendDraft(retryNote);
      const second = collect(raw);
      for (const question of second.questions) {
        const existing = questions.findIndex((entry) => entry.cardId === question.cardId);
        if (existing >= 0) questions[existing] = question;
        else questions.push(question);
      }
      errors = [...errors, ...second.errors];
    }
    return { questions, errors };
  }

  function needsFreeText(targets: ChangeCard[], questions: StoredCheckQuestion[]): boolean {
    return (
      targets.some((card) => card.highRisk) &&
      !questions.some((entry) => entry.format === "free_text")
    );
  }

  /**
   * Enforce the high-risk free-text rule: one follow-up forcing free_text for
   * the highest-risk target. If the model still disobeys, the set ships
   * without it — dropping the whole check over question format would trade a
   * working calibration moment for a formatting veto, so the violation is
   * logged and the gap stays visible in the picture.
   */
  async function enforceFreeText(
    config: ModelConfig,
    targets: ChangeCard[],
    story: SessionStory,
    patches: Map<string, string>,
    questions: StoredCheckQuestion[],
    signal: AbortSignal,
  ): Promise<StoredCheckQuestion[]> {
    if (!needsFreeText(targets, questions)) return questions;
    const highest = [...targets].sort(
      (a, b) => Number(b.highRisk) - Number(a.highRisk) || a.rank - b.rank,
    )[0] as ChangeCard;
    const block = targetBlock(highest, 0, patches, story.detours);
    const messages: ChatMessage[] = [
      { role: "system", content: CHECK_SYSTEM_PROMPT },
      {
        role: "user",
        content: `This session has a high-risk change. Write exactly ONE free_text question (kind teach_back) for this target:\n\n${block}`,
      },
    ];
    try {
      const redacted = redactJson(messages).value as ChatMessage[];
      const result = await requestJson(config, redacted, (value: unknown) => value, {
        fetchImpl,
        retryMaxTokens: Math.max(config.maxTokens * 2, 8192),
        signal,
      });
      const parsed = CheckDraftSetSchema.safeParse(result.value);
      const draft = parsed.success ? parsed.data.questions[0] : undefined;
      if (draft && draft.cardId === highest.id && draft.format === "free_text") {
        const targetsById = new Map(targets.map((card) => [card.id, card]));
        const validated = validateDraft(draft, targetsById, knownSetsFor(targets, patches));
        if (validated.question && validated.question.format === "free_text") {
          const existing = questions.findIndex((entry) => entry.cardId === highest.id);
          if (existing >= 0) questions[existing] = validated.question;
          else questions.push(validated.question);
          return questions;
        }
      }
    } catch {
      // Model failure here is not fatal: fall through to accept + log.
    }
    log.info(
      { session_id: story.sessionId, card_id: highest.id },
      "checks-v2 shipped without the required high-risk free_text question",
    );
    return questions;
  }

  function buildPicture(
    cards: ChangeCard[],
    questions: StoredCheckQuestion[],
    attempts: CheckAttemptV2[],
  ): Array<{ cardId: string; bucket: PictureBucket; questionId: string | null }> {
    const attemptByQuestion = new Map(attempts.map((attempt) => [attempt.questionId, attempt]));
    return cards.map((card) => {
      const question = questions.find((entry) => entry.cardId === card.id) ?? null;
      const attempt = question ? (attemptByQuestion.get(question.id) ?? null) : null;
      return {
        cardId: card.id,
        bucket: attempt ? attempt.bucket : "never_looked",
        questionId: question?.id ?? null,
      };
    });
  }

  /**
   * Evidence entries point back at the story card's paths with the
   * explanation as text — not fresh tape observations, so the honest label
   * is `uncertain`. The one exception: a card the story already marks
   * `observed` has a test run covering it, so those entries read `observed`.
   */
  function buildEvidence(
    card: ChangeCard,
    question: StoredCheckQuestion,
    explanation: string,
    ts: string,
  ): AskEvidence[] {
    const label = card.verification === "observed" ? "observed" : "uncertain";
    return question.evidencePaths.map((path, index) => ({
      evidenceId: `chk2-ev-${createHash("sha256").update(`${question.id}:${path}`).digest("hex").slice(0, 10)}-${index}`,
      eventId: card.moment.eventId ?? "unlinked",
      kind: "story-claim",
      label,
      ts,
      text: explanation,
      filePath: path,
    }));
  }

  /**
   * Files this project got wrong before, excluding the session being
   * checked: weak picture entries in other sessions' artifacts, counted per
   * story-card touch with Learn's weak-area rule (shared helpers from
   * @echo/checks). Corrupt or missing artifacts read as empty — a bad
   * sibling write must not block generating this session's check.
   */
  function crossSessionWeakFiles(projectId: string, excludeSessionId: string): Set<string> {
    const entries: Array<{ touches: string[]; weak: boolean }> = [];
    for (const session of listSessions(db, projectId)) {
      if (session.id === excludeSessionId) continue;
      const story = loadStory(projectId, session.id);
      const artifact = loadArtifact(projectId, session.id);
      if (!story || !artifact) continue;
      const touchesByCard = new Map(story.cards.map((card) => [card.id, card.touches]));
      for (const entry of artifact.picture) {
        entries.push({
          touches: touchesByCard.get(entry.cardId) ?? [],
          weak: isWeakPictureBucket(entry.bucket),
        });
      }
    }
    return weakFiles(entries);
  }

  async function generate(sessionId: string): Promise<ChecksV2Outcome> {
    const session = getSession(db, sessionId);
    if (!session) {
      return { status: 404, body: { error: { code: "not_found", message: "unknown session" } } };
    }
    const story = loadStory(session.projectId, sessionId);
    if (!story) {
      return { status: 400, body: { error: { code: "invalid_request", message: "no story yet" } } };
    }
    const tiers = deriveEngagementTiers(
      db,
      sessionId,
      story.cards.map((card) => card.id),
    );
    const targetIds = selectTargets(
      story.cards,
      tiers,
      5,
      crossSessionWeakFiles(session.projectId, sessionId),
    );
    if (targetIds.length === 0) {
      return {
        status: 400,
        body: { error: { code: "invalid_request", message: "no check needed" } },
      };
    }
    const targets = targetIds
      .map((id) => story.cards.find((card) => card.id === id))
      .filter((card): card is ChangeCard => card !== undefined);

    let config: ModelConfig;
    try {
      config = resolveConfig();
    } catch (error) {
      // Model unavailable: the check is unavailable and session status is untouched.
      return unavailable(error);
    }
    const patches = await loadPatches(sessionId, targets);
    let drafted: StoredCheckQuestion[];
    try {
      const { questions, errors } = await withDeadline(async (signal) => {
        const first = await draftQuestions(config, targets, story, patches, signal);
        const finalQuestions = await enforceFreeText(
          config,
          targets,
          story,
          patches,
          first.questions,
          signal,
        );
        return { questions: finalQuestions, errors: first.errors };
      });
      drafted = questions;
      if (drafted.length === 0) {
        log.error(
          { session_id: sessionId, errors: errors.slice(0, 5) },
          "checks-v2 draft produced no valid questions",
        );
        return {
          status: 502,
          body: { error: { code: "model_error", message: "check draft failed validation" } },
        };
      }
    } catch (error) {
      return unavailable(error);
    }

    const now = new Date().toISOString();
    const watermark = computeWatermark(readAllEvents(db, sessionId));
    const artifact: ChecksV2Artifact = {
      schemaVersion: 1,
      sessionId,
      status: "in_progress",
      generatedAt: now,
      tapeWatermark: watermark,
      questions: drafted,
      attempts: [],
      picture: buildPicture(story.cards, drafted, []),
      currentQuestionId: drafted[0]?.id ?? null,
      origin: "offer",
    };
    // The offer set never touches the session check status: only a completed
    // set (checked) or an explicit skip (skipped) may flip it.
    if (!persistArtifact(session.projectId, artifact)) {
      return {
        status: 500,
        body: { error: { code: "redaction_failed", message: "checks unavailable" } },
      };
    }
    return { status: 200, body: toPublic(artifact) };
  }

  /**
   * Single-card entry: creates a one-question set when no set is active, or
   * appends to the in-progress set. Session-scoped (not a global
   * question-id lookup) so a question id can never leak across sessions: the
   * lookup is always bounded by this session's artifact file.
   */
  async function checkMe(sessionId: string, cardId: string): Promise<ChecksV2Outcome> {
    const session = getSession(db, sessionId);
    if (!session) {
      return { status: 404, body: { error: { code: "not_found", message: "unknown session" } } };
    }
    const story = loadStory(session.projectId, sessionId);
    if (!story) {
      return { status: 400, body: { error: { code: "invalid_request", message: "no story yet" } } };
    }
    const card = story.cards.find((entry) => entry.id === cardId);
    if (!card) {
      return { status: 400, body: { error: { code: "invalid_request", message: "unknown card" } } };
    }
    const existing = loadArtifact(session.projectId, sessionId);
    if (existing && existing.status === "in_progress") {
      const present = existing.questions.find((entry) => entry.cardId === cardId) ?? null;
      if (present) {
        return {
          status: 200,
          body: toPublic({ ...existing, currentQuestionId: present.id }),
        };
      }
      let config: ModelConfig;
      try {
        config = resolveConfig();
      } catch (error) {
        return unavailable(error);
      }
      const patches = await loadPatches(sessionId, [card]);
      try {
        const drafted = await withDeadline((signal) =>
          draftQuestions(config, [card], story, patches, signal),
        );
        if (drafted.questions.length === 0) {
          return {
            status: 502,
            body: { error: { code: "model_error", message: "check draft failed validation" } },
          };
        }
        const next: ChecksV2Artifact = {
          ...existing,
          questions: [...existing.questions, ...drafted.questions],
          picture: buildPicture(
            story.cards,
            [...existing.questions, ...drafted.questions],
            existing.attempts,
          ),
          currentQuestionId: drafted.questions[0]?.id ?? existing.currentQuestionId,
        };
        if (!persistArtifact(session.projectId, next)) {
          return {
            status: 500,
            body: { error: { code: "redaction_failed", message: "checks unavailable" } },
          };
        }
        return { status: 200, body: toPublic(next) };
      } catch (error) {
        return unavailable(error);
      }
    }
    // No active set (none, completed, or skipped): a fresh single-card set.
    let config: ModelConfig;
    try {
      config = resolveConfig();
    } catch (error) {
      return unavailable(error);
    }
    const patches = await loadPatches(sessionId, [card]);
    let drafted: StoredCheckQuestion[];
    try {
      drafted = (
        await withDeadline((signal) => draftQuestions(config, [card], story, patches, signal))
      ).questions;
      if (drafted.length === 0) {
        return {
          status: 502,
          body: { error: { code: "model_error", message: "check draft failed validation" } },
        };
      }
    } catch (error) {
      return unavailable(error);
    }
    const now = new Date().toISOString();
    const artifact: ChecksV2Artifact = {
      schemaVersion: 1,
      sessionId,
      status: "in_progress",
      generatedAt: now,
      tapeWatermark: computeWatermark(readAllEvents(db, sessionId)),
      questions: drafted,
      attempts: [],
      picture: buildPicture(story.cards, drafted, []),
      currentQuestionId: drafted[0]?.id ?? null,
      origin: "check_me",
    };
    if (!persistArtifact(session.projectId, artifact)) {
      return {
        status: 500,
        body: { error: { code: "redaction_failed", message: "checks unavailable" } },
      };
    }
    return { status: 200, body: toPublic(artifact) };
  }

  async function answer(
    sessionId: string,
    body: {
      questionId: string;
      confidence: AnswerConfidence;
      selectedOptionId?: string | null;
      answerText?: string | null;
    },
  ): Promise<ChecksV2Outcome> {
    const session = getSession(db, sessionId);
    if (!session) {
      return { status: 404, body: { error: { code: "not_found", message: "unknown session" } } };
    }
    const artifact = loadArtifact(session.projectId, sessionId);
    if (!artifact) {
      return { status: 404, body: { error: { code: "not_found", message: "unknown question" } } };
    }
    const question = artifact.questions.find((entry) => entry.id === body.questionId) ?? null;
    if (!question) {
      return { status: 404, body: { error: { code: "not_found", message: "unknown question" } } };
    }
    // No retakes: confidence locks once set, so a second answer is rejected.
    if (artifact.attempts.some((attempt) => attempt.questionId === question.id)) {
      return {
        status: 400,
        body: { error: { code: "invalid_request", message: "question already answered" } },
      };
    }
    const trimmed = (body.answerText ?? "").trim();
    if (
      question.format === "mcq" &&
      (body.selectedOptionId === null || body.selectedOptionId === undefined)
    ) {
      return {
        status: 400,
        body: { error: { code: "invalid_request", message: "mcq answer needs selectedOptionId" } },
      };
    }
    if (question.format === "free_text" && trimmed.length === 0) {
      return {
        status: 400,
        body: { error: { code: "invalid_request", message: "free_text answer needs answerText" } },
      };
    }

    const story = loadStory(session.projectId, sessionId);
    const card = story?.cards.find((entry) => entry.id === question.cardId) ?? null;

    let correct: boolean;
    let rubricHits: CheckAttemptV2["rubricHits"] = [];
    let usage: ChatUsage | null = null;
    // The stored question carries the key/rubric/explanation; none of it
    // leaves the server except via the post-answer reveal.
    const explanation = question.explanation;
    if (question.format === "mcq") {
      correct = gradeMcq(body.selectedOptionId, question.correctOptionId);
    } else {
      let config: ModelConfig;
      try {
        config = resolveConfig();
      } catch (error) {
        // Grading unavailable: the attempt is NOT recorded, so the user can
        // retry once the model is back. Nothing persists on this path.
        return unavailable(error);
      }
      let hits: RubricHitInput[];
      try {
        const result = await withDeadline((signal) =>
          requestJson(
            config,
            [
              { role: "system", content: GRADING_PROMPT },
              {
                role: "user",
                content: `Rubric:\n${question.rubric.map((point, index) => `${index + 1}. ${point}`).join("\n")}\n\nUser answer:\n${trimmed}`,
              },
            ],
            (value: unknown) => parseGrading(value, question.rubric),
            { fetchImpl, retryMaxTokens: Math.max(config.maxTokens * 2, 8192), signal },
          ),
        );
        hits = result.value;
        usage = result.usage;
      } catch (error) {
        return unavailable(error);
      }
      const check = makeCheck(
        question.kind,
        question.question,
        question.evidencePaths,
        question.rubric,
      );
      const grade = gradeRubric(check, trimmed, hits);
      correct = grade.correct;
      rubricHits = hits;
    }

    const now = new Date().toISOString();
    const confident = body.confidence !== "guessing";
    const bucket = bucketFor({ attempted: true, correct, confident });
    const evidence = card ? buildEvidence(card, question, explanation, now) : [];
    const attempt: CheckAttemptV2 = {
      id: attemptIdFor(question.id),
      questionId: question.id,
      confidence: body.confidence,
      selectedOptionId: body.selectedOptionId ?? null,
      answerText: question.format === "free_text" ? trimmed : null,
      correct,
      bucket,
      rubricHits,
      evidence,
      createdAt: now,
    };
    const attempts = [...artifact.attempts, attempt];
    const storyCards = story?.cards ?? [];
    const pictureSource = storyCards.length > 0 ? storyCards : [];
    const picture = buildPicture(pictureSource, artifact.questions, attempts);
    const next = artifact.questions.find(
      (entry) => !attempts.some((attempted) => attempted.questionId === entry.id),
    );
    let status = artifact.status;
    if (artifact.origin === "offer" && artifact.questions.length > 0 && next === undefined) {
      status = "completed";
    }
    const nextArtifact: ChecksV2Artifact = {
      ...artifact,
      status,
      attempts,
      picture,
      currentQuestionId: next?.id ?? null,
    };
    // Fail closed: a redaction failure drops the content and records a
    // content-free diagnostic — the attempt is lost, never half-persisted.
    if (!persistArtifact(session.projectId, nextArtifact)) {
      return {
        status: 500,
        body: { error: { code: "redaction_failed", message: "answer not recorded" } },
      };
    }
    if (status === "completed" && artifact.status !== "completed" && options.demo !== true) {
      setSessionCheckStatus(db, sessionId, "checked");
    }
    return {
      status: 200,
      body: { attempt, reveal: { summary: explanation, evidence } },
      usage,
    };
  }

  function skip(sessionId: string): ChecksV2Outcome {
    const session = getSession(db, sessionId);
    if (!session) {
      return { status: 404, body: { error: { code: "not_found", message: "unknown session" } } };
    }
    const existing = loadArtifact(session.projectId, sessionId);
    if (existing && existing.status === "completed") {
      return {
        status: 400,
        body: { error: { code: "invalid_request", message: "check already finished" } },
      };
    }
    const now = new Date().toISOString();
    const watermark = computeWatermark(readAllEvents(db, sessionId));
    // Skip works from the offer (no set yet) and mid-check alike: answers
    // stay on the artifact, only the status flips.
    const next: ChecksV2Artifact = existing
      ? { ...existing, status: "skipped", currentQuestionId: null }
      : {
          schemaVersion: 1,
          sessionId,
          status: "skipped",
          generatedAt: now,
          tapeWatermark: watermark,
          questions: [],
          attempts: [],
          picture: [],
          currentQuestionId: null,
          origin: "offer",
        };
    if (!persistArtifact(session.projectId, next)) {
      return {
        status: 500,
        body: { error: { code: "redaction_failed", message: "checks unavailable" } },
      };
    }
    if (options.demo !== true) setSessionCheckStatus(db, sessionId, "skipped");
    return { status: 200, body: toPublic(next) };
  }

  function state(sessionId: string): ChecksV2Outcome {
    const session = getSession(db, sessionId);
    if (!session) {
      return { status: 404, body: { error: { code: "not_found", message: "unknown session" } } };
    }
    const artifact = loadArtifact(session.projectId, sessionId);
    if (!artifact) {
      return {
        status: 200,
        body: emptyOffered(sessionId, computeWatermark(readAllEvents(db, sessionId))),
      };
    }
    return { status: 200, body: toPublic(artifact) };
  }

  return { generate, checkMe, answer, skip, state };
}

export type ChecksV2Service = ReturnType<typeof createChecksV2Service>;
