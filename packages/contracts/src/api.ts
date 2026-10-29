import { z } from "zod";
import { EvidenceLabelSchema } from "./evidence";

export const ErrorCodeSchema = z.enum([
  "invalid_request",
  "not_found",
  "not_on_tape",
  "insufficient_evidence",
  "ambiguous_question",
  "model_error",
  "budget_exhausted",
  "redaction_failed",
  "sandbox_unavailable",
  "check_gate_failed",
  "daemon_unavailable",
  "readonly_demo",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).nullable().default(null),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// Canonical card ID (ARCHITECTURE §12): the hunk ID, `h_` + 16 lowercase hex,
// used end to end for cards and hunks. One schema object under two names so
// hunk-typed and card-typed fields each read naturally without drifting.
export const CardIdSchema = z.string().regex(/^h_[0-9a-f]{16}$/);
export type CardId = z.infer<typeof CardIdSchema>;
export const HunkIdSchema = CardIdSchema;
export type HunkId = z.infer<typeof HunkIdSchema>;

export const ProjectSummarySchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  remoteUrl: z.string().nullable(),
  name: z.string().nullable(),
  sessionCount: z.number().int().nonnegative(),
  lastActivity: z.string().nullable(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const ProjectFileTouchSchema = z.object({
  path: z.string().min(1),
  sessionCount: z.number().int().nonnegative(),
  lastTouched: z.string(),
});
export type ProjectFileTouch = z.infer<typeof ProjectFileTouchSchema>;

export const ProjectFilesResponseSchema = z.object({
  projectId: z.string().min(1),
  files: z.array(ProjectFileTouchSchema),
  truncated: z.boolean(),
});
export type ProjectFilesResponse = z.infer<typeof ProjectFilesResponseSchema>;

export const ProjectTechStackKindSchema = z.enum([
  "language",
  "framework",
  "build",
  "data",
  "infra",
]);
export type ProjectTechStackKind = z.infer<typeof ProjectTechStackKindSchema>;

export const ProjectTechStackItemSchema = z.object({
  name: z.string().min(1).max(40),
  kind: ProjectTechStackKindSchema,
});
export type ProjectTechStackItem = z.infer<typeof ProjectTechStackItemSchema>;

export const ProjectTechStackSchema = z.object({
  projectId: z.string().min(1),
  purpose: z.string().min(1).max(280),
  items: z.array(ProjectTechStackItemSchema).max(8),
  generator: z.enum(["model", "skeleton"]),
  generatedAt: z.string().min(1),
});
export type ProjectTechStack = z.infer<typeof ProjectTechStackSchema>;

export const SessionCheckStatusSchema = z.enum(["not_checked", "checked", "skipped"]);
export type SessionCheckStatus = z.infer<typeof SessionCheckStatusSchema>;

export const CaptureStateSchema = z.enum([
  "recording",
  "ready",
  "partial",
  "degraded",
  "import_only",
]);
export type CaptureState = z.infer<typeof CaptureStateSchema>;

export const SessionSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().nullable(),
  model: z.string().nullable(),
  directory: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  lastActivity: z.string(),
  status: z.string().min(1),
  captureQuality: z.string().min(1),
  eventCount: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  /** True when the summary came from the deterministic skeleton fallback. */
  summarySkeleton: z.boolean(),
  checkStatus: SessionCheckStatusSchema,
  highRiskCount: z.number().int().nonnegative(),
  captureState: CaptureStateSchema,
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const StoredEventSchema = z.object({
  event_id: z.string().min(1),
  tape_seq: z.number().int().nonnegative(),
  position_seq: z.number().int().nonnegative(),
  record_key: z.string().nullable(),
  kind: z.string().min(1),
  ts: z.string().min(1),
  observed_at: z.string().min(1),
  tool_call_id: z.string().nullable(),
  payload: z.unknown(),
  redaction: z.object({
    version: z.string(),
    findings: z.number().int().nonnegative(),
  }),
});
export type StoredEvent = z.infer<typeof StoredEventSchema>;

export const SnapshotSummarySchema = z.object({
  commitOid: z.string().min(1),
  trigger: z.string().min(1),
  eventId: z.string().nullable(),
  takenAt: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  status: z.string().min(1),
  diagnostics: z.array(z.string()),
});
export type SnapshotSummary = z.infer<typeof SnapshotSummarySchema>;

export const SnapshotFileSchema = z.object({
  path: z.string().min(1),
  mode: z.string().nullable(),
  blobOid: z.string().nullable(),
  size: z.number().nullable(),
  sha256: z.string().nullable(),
  captured: z.boolean(),
  reason: z.string().nullable(),
});
export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;

export const SnapshotFileContentSchema = z.object({
  path: z.string().min(1),
  blobOid: z.string().min(1),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
  content: z.string(),
});
export type SnapshotFileContent = z.infer<typeof SnapshotFileContentSchema>;

export const ReviewHunkSchema = z.object({
  id: HunkIdSchema,
  path: z.string().min(1),
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  patch: z.string(),
  addedText: z.string(),
  removedText: z.string(),
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
  riskScore: z.number().int().nonnegative(),
  riskReasons: z.array(z.string()),
});
export type ReviewHunk = z.infer<typeof ReviewHunkSchema>;

export const AttemptStatusSchema = z.enum([
  "landed",
  "partially_landed",
  "reverted",
  "replaced",
  "failed",
  "failed_with_side_effect",
  "uncertain",
  "baseline",
]);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

export const FileAttemptSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  snapshotId: z.string().min(1),
  commitOid: z.string().min(1),
  trigger: z.string().min(1),
  eventId: z.string().nullable(),
  takenAt: z.string(),
  status: AttemptStatusSchema,
  confidence: z.enum(["exact", "likely", "uncertain"]),
  introducedLines: z.number().int().nonnegative(),
  survivingLines: z.number().int().nonnegative(),
  introducedText: z.array(z.string()),
  replacementText: z.array(z.string()),
  finalStart: z.number().int().nonnegative().nullable(),
  finalEnd: z.number().int().nullable(),
  detail: z.string(),
  link: z.object({
    eventId: z.string().nullable(),
    toolCallId: z.string().nullable(),
    toolOutcome: z.enum(["completed", "failed", "requested"]).nullable(),
    turnId: z.string().nullable(),
    batchId: z.string().nullable(),
  }),
});
export type FileAttempt = z.infer<typeof FileAttemptSchema>;

export const HunkEvidenceSchema = z.object({
  relation: z.enum([
    "introduced_by",
    "touched_by",
    "reverted_attempt",
    "related_event",
    "baseline",
  ]),
  confidence: z.enum(["exact", "likely", "uncertain"]),
  snapshotId: z.string().nullable(),
  eventId: z.string().nullable(),
  toolCallId: z.string().nullable(),
  detail: z.string(),
});
export type HunkEvidence = z.infer<typeof HunkEvidenceSchema>;

export const SessionReviewSchema = z.object({
  sessionId: z.string().min(1),
  baselineCommit: z.string().nullable(),
  finalCommit: z.string().nullable(),
  hunks: z.array(ReviewHunkSchema),
  attempts: z.array(FileAttemptSchema),
  evidenceByHunk: z.record(HunkIdSchema, z.array(HunkEvidenceSchema)),
  diagnostics: z.array(z.string()),
  generatedAt: z.string(),
});
export type SessionReview = z.infer<typeof SessionReviewSchema>;

export const AskRequestSchema = z.object({
  question: z.string().min(1).max(2000),
  filePath: z.string().min(1).max(1024).nullable().default(null),
  symbols: z.array(z.string().min(1).max(256)).max(16).default([]),
  cardId: z.string().min(1).max(128).nullable().default(null),
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

export const AskEvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  eventId: z.string().min(1),
  kind: z.string().min(1),
  label: z.enum(["observed", "agent_stated", "uncertain"]),
  ts: z.string().min(1),
  text: z.string(),
  filePath: z.string().nullable(),
});
export type AskEvidence = z.infer<typeof AskEvidenceSchema>;

export const AskClaimSchema = z.object({
  text: z.string(),
  evidenceIds: z.array(z.string()),
  quote: z.string().nullable(),
  weak: z.boolean(),
});
export type AskClaim = z.infer<typeof AskClaimSchema>;

export const AskResponseSchema = z.object({
  status: z.enum(["answered", "partial", "refused"]),
  answer: z.string(),
  claims: z.array(AskClaimSchema),
  refusalReason: z.string().nullable(),
  uncertainty: z.enum(["low", "medium", "high"]),
  bundleHash: z.string(),
  searchedScope: z.object({
    eventCount: z.number().int().nonnegative(),
    filePath: z.string().nullable(),
  }),
  evidence: z.array(AskEvidenceSchema),
  cached: z.boolean(),
});
export type AskResponse = z.infer<typeof AskResponseSchema>;

export const CheckKindSchema = z.enum([
  "consequence",
  "decision",
  "tradeoff",
  "blast_radius",
  "teach_back",
]);
export type CheckKind = z.infer<typeof CheckKindSchema>;

export const AnswerConfidenceSchema = z.enum(["guessing", "think_so", "certain"]);
export type AnswerConfidence = z.infer<typeof AnswerConfidenceSchema>;

export const RubricHitSchema = z.object({
  point: z.string().min(1),
  hit: z.boolean(),
  excerpt: z.string().nullable(),
  why: z.string().nullable(),
});
export type RubricHit = z.infer<typeof RubricHitSchema>;

// --- Story-first surface (ADR 0011) and calibration checks v2 (ADR 0012) ---

export const VerificationBadgeSchema = z.enum([
  "observed",
  "partly_observed",
  "agent_stated",
  "nothing",
]);
export type VerificationBadge = z.infer<typeof VerificationBadgeSchema>;

export const TapeWatermarkSchema = z.object({
  eventCount: z.number().int().nonnegative(),
  sha256: z.string().min(1),
});
export type TapeWatermark = z.infer<typeof TapeWatermarkSchema>;

export const StoryClaimSchema = z.object({
  text: z.string().min(1),
  label: EvidenceLabelSchema,
  factIds: z.array(z.string()),
});
export type StoryClaim = z.infer<typeof StoryClaimSchema>;

export const PictureBucketSchema = z.enum([
  "solid",
  "right_but_unsure",
  "confident_but_wrong",
  "wrong_and_knew_it",
  "never_looked",
]);
export type PictureBucket = z.infer<typeof PictureBucketSchema>;

const ChangeCardMomentSchema = z.object({
  eventId: z.string().min(1).nullable(),
  toolCallId: z.string().min(1).nullable(),
  ts: z.string().min(1).nullable(),
  excerpt: z.string(),
  label: EvidenceLabelSchema,
});
export type ChangeCardMoment = z.infer<typeof ChangeCardMomentSchema>;

const ChangeCardHistorySchema = z.object({
  priorSessionIds: z.array(z.string()),
  previousPicture: PictureBucketSchema.nullable(),
  note: z.string().nullable(),
});
export type ChangeCardHistory = z.infer<typeof ChangeCardHistorySchema>;

export const ChangeCardSchema = z.object({
  id: CardIdSchema,
  headline: z.string().min(1),
  constituentHunkIds: z.array(HunkIdSchema),
  constituentActionIds: z.array(z.string()),
  rank: z.number().int().min(1),
  sessionOrder: z.number().int().nonnegative(),
  highRisk: z.boolean(),
  riskReasons: z.array(z.string()),
  verification: VerificationBadgeSchema,
  why: z.array(StoryClaimSchema),
  before: z.array(StoryClaimSchema),
  now: z.array(StoryClaimSchema),
  checkedBy: z.array(StoryClaimSchema),
  touches: z.array(z.string()),
  moment: ChangeCardMomentSchema,
  history: ChangeCardHistorySchema,
});
export type ChangeCard = z.infer<typeof ChangeCardSchema>;

export const DetourCostReasonSchema = z.enum(["reverted", "side_effect", "repeated_attempt"]);
export type DetourCostReason = z.infer<typeof DetourCostReasonSchema>;

export const DetourSchema = z.object({
  id: z.string().min(1),
  headline: z.string().min(1),
  claims: z.array(StoryClaimSchema),
  attemptIds: z.array(z.string()),
  costReason: DetourCostReasonSchema,
});
export type Detour = z.infer<typeof DetourSchema>;

export const LooseEndKindSchema = z.enum(["assumption", "todo", "untested"]);
export type LooseEndKind = z.infer<typeof LooseEndKindSchema>;

export const LooseEndSchema = z.object({
  id: z.string().min(1),
  kind: LooseEndKindSchema,
  claims: z.array(StoryClaimSchema),
  cardId: CardIdSchema.nullable(),
});
export type LooseEnd = z.infer<typeof LooseEndSchema>;

export const StoryGeneratorSchema = z.object({
  kind: z.enum(["model", "skeleton"]),
  model: z.string().nullable(),
  promptVersion: z.string(),
});
export type StoryGenerator = z.infer<typeof StoryGeneratorSchema>;

export const AskVsResultSchema = z.object({
  asked: z.array(StoryClaimSchema),
  delivered: z.array(StoryClaimSchema),
  extras: z.array(StoryClaimSchema),
  missing: z.array(StoryClaimSchema),
});
export type AskVsResult = z.infer<typeof AskVsResultSchema>;

export const VerifiedCountsSchema = z.object({
  observed: z.number().int().nonnegative(),
  partlyObserved: z.number().int().nonnegative(),
  agentStated: z.number().int().nonnegative(),
  nothing: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type VerifiedCounts = z.infer<typeof VerifiedCountsSchema>;

export const SessionStorySchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  generatedAt: z.string().min(1),
  generator: StoryGeneratorSchema,
  tapeWatermark: TapeWatermarkSchema,
  summary: z.string().min(1),
  skeleton: z.boolean(),
  shortVersion: z.array(StoryClaimSchema),
  askVsResult: AskVsResultSchema,
  cards: z.array(ChangeCardSchema),
  routineSummary: z.string().nullable(),
  detours: z.array(DetourSchema),
  looseEnds: z.array(LooseEndSchema),
  blindSpots: z.array(z.string()),
  gaps: z.array(z.string()),
  verifiedCounts: VerifiedCountsSchema,
});
export type SessionStory = z.infer<typeof SessionStorySchema>;

export const EngagementKindSchema = z.enum([
  "story_opened",
  "card_seen",
  "card_expanded",
  "code_shown",
  "ask_opened",
]);
export type EngagementKind = z.infer<typeof EngagementKindSchema>;

export const EngagementTierSchema = z.enum(["unseen", "seen", "engaged"]);
export type EngagementTier = z.infer<typeof EngagementTierSchema>;

export const EngagementEventSchema = z.object({
  id: z.string().min(1),
  cardId: CardIdSchema.nullable(),
  kind: EngagementKindSchema,
  occurredAt: z.string().min(1),
});
export type EngagementEvent = z.infer<typeof EngagementEventSchema>;

export const RecordEngagementRequestSchema = z.object({
  events: z.array(EngagementEventSchema).min(1).max(100),
});
export type RecordEngagementRequest = z.infer<typeof RecordEngagementRequestSchema>;

export const EngagementStateSchema = z.object({
  sessionId: z.string().min(1),
  tiers: z.record(CardIdSchema, EngagementTierSchema),
});
export type EngagementState = z.infer<typeof EngagementStateSchema>;

const StoredCheckQuestionBaseSchema = z.object({
  id: z.string().min(1),
  cardId: CardIdSchema,
  kind: CheckKindSchema,
  question: z.string().min(1),
  evidenceFactIds: z.array(z.string()),
  evidencePaths: z.array(z.string()),
});

export const StoredCheckMcqQuestionSchema = StoredCheckQuestionBaseSchema.extend({
  format: z.literal("mcq"),
  options: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).min(2),
  correctOptionId: z.string().min(1),
  distractorSources: z.array(z.string()),
  explanation: z.string().min(1),
});
export type StoredCheckMcqQuestion = z.infer<typeof StoredCheckMcqQuestionSchema>;

export const StoredCheckFreeTextQuestionSchema = StoredCheckQuestionBaseSchema.extend({
  format: z.literal("free_text"),
  rubric: z.array(z.string().min(1)).min(1),
  explanation: z.string().min(1),
});
export type StoredCheckFreeTextQuestion = z.infer<typeof StoredCheckFreeTextQuestionSchema>;

export const StoredCheckQuestionSchema = z.discriminatedUnion("format", [
  StoredCheckMcqQuestionSchema,
  StoredCheckFreeTextQuestionSchema,
]);
export type StoredCheckQuestion = z.infer<typeof StoredCheckQuestionSchema>;

export const PublicCheckMcqQuestionSchema = StoredCheckQuestionBaseSchema.extend({
  format: z.literal("mcq"),
  options: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).min(2),
});
export type PublicCheckMcqQuestion = z.infer<typeof PublicCheckMcqQuestionSchema>;

export const PublicCheckFreeTextQuestionSchema = StoredCheckQuestionBaseSchema.extend({
  format: z.literal("free_text"),
});
export type PublicCheckFreeTextQuestion = z.infer<typeof PublicCheckFreeTextQuestionSchema>;

export const PublicCheckQuestionSchema = z.discriminatedUnion("format", [
  PublicCheckMcqQuestionSchema,
  PublicCheckFreeTextQuestionSchema,
]);
export type PublicCheckQuestion = z.infer<typeof PublicCheckQuestionSchema>;

export const CheckAttemptV2Schema = z.object({
  id: z.string().min(1),
  questionId: z.string().min(1),
  confidence: AnswerConfidenceSchema,
  selectedOptionId: z.string().min(1).nullable(),
  answerText: z.string().nullable(),
  correct: z.boolean(),
  bucket: PictureBucketSchema,
  rubricHits: z.array(RubricHitSchema),
  evidence: z.array(AskEvidenceSchema),
  createdAt: z.string().min(1),
});
export type CheckAttemptV2 = z.infer<typeof CheckAttemptV2Schema>;

export const CardPictureSchema = z.object({
  cardId: CardIdSchema,
  bucket: PictureBucketSchema,
  questionId: z.string().min(1).nullable(),
});
export type CardPicture = z.infer<typeof CardPictureSchema>;

export const ChecksV2StatusSchema = z.enum(["offered", "in_progress", "completed", "skipped"]);
export type ChecksV2Status = z.infer<typeof ChecksV2StatusSchema>;

export const ChecksV2StateSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  status: ChecksV2StatusSchema,
  generatedAt: z.string().min(1),
  tapeWatermark: TapeWatermarkSchema,
  questions: z.array(StoredCheckQuestionSchema),
  attempts: z.array(CheckAttemptV2Schema),
  picture: z.array(CardPictureSchema),
  currentQuestionId: z.string().min(1).nullable(),
});
export type ChecksV2State = z.infer<typeof ChecksV2StateSchema>;

export const ChecksV2ResponseSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  status: ChecksV2StatusSchema,
  generatedAt: z.string().min(1),
  tapeWatermark: TapeWatermarkSchema,
  questions: z.array(PublicCheckQuestionSchema),
  attempts: z.array(CheckAttemptV2Schema),
  picture: z.array(CardPictureSchema),
  currentQuestionId: z.string().min(1).nullable(),
});
export type ChecksV2Response = z.infer<typeof ChecksV2ResponseSchema>;

export const AskThreadMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1),
  cardId: CardIdSchema.nullable(),
  response: AskResponseSchema.nullable(),
  createdAt: z.string().min(1),
});
export type AskThreadMessage = z.infer<typeof AskThreadMessageSchema>;

export const AskThreadSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  updatedAt: z.string().min(1),
  messages: z.array(AskThreadMessageSchema),
});
export type AskThread = z.infer<typeof AskThreadSchema>;

// Card history (Phase 3 slice A): touch-overlap entries across same-project
// sessions. previousPicture is ALWAYS null on this slice (checks v2 lands
// Phase 5); the field stays so the shape is forward-compatible.
export const HistoryEntrySchema = z.object({
  sessionId: z.string().min(1),
  summary: z.string().nullable(),
  endedAt: z.string().nullable(),
  sharedFiles: z.array(z.string()),
  matchNote: z.string().min(1),
  previousPicture: PictureBucketSchema.nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const SessionHistoryResponseSchema = z.object({
  sessionId: z.string().min(1),
  entries: z.array(HistoryEntrySchema),
});
export type SessionHistoryResponse = z.infer<typeof SessionHistoryResponseSchema>;

export const ArtifactKindSchema = z.enum(["story", "checks_v2", "ask_thread"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

// --- Checks v2 request/response shapes (additive; stored vs public already above) ---

export const CheckMeRequestSchema = z.object({
  cardId: z.string().min(1),
});
export type CheckMeRequest = z.infer<typeof CheckMeRequestSchema>;

export const CheckV2AnswerRequestSchema = z.object({
  confidence: AnswerConfidenceSchema,
  questionId: z.string().min(1),
  selectedOptionId: z.string().min(1).nullable().default(null),
  answerText: z.string().max(8000).nullable().default(null),
});
export type CheckV2AnswerRequest = z.infer<typeof CheckV2AnswerRequestSchema>;

export const CheckV2AnswerResponseSchema = z.object({
  attempt: CheckAttemptV2Schema,
  reveal: z.object({
    summary: z.string().min(1),
    evidence: z.array(AskEvidenceSchema),
  }),
});
export type CheckV2AnswerResponse = z.infer<typeof CheckV2AnswerResponseSchema>;
// File layout for generated artifacts under the session dir (ARCHITECTURE §6).
export const ARTIFACT_FILE_NAMES: Record<ArtifactKind, string> = {
  story: "story.json",
  checks_v2: "checks_v2.json",
  ask_thread: "ask_thread.json",
};

export const ArtifactRefSchema = z.object({
  sessionId: z.string().min(1),
  kind: ArtifactKindSchema,
  path: z.string().min(1),
  tapeWatermark: TapeWatermarkSchema,
  generator: z.string().min(1),
  generatedAt: z.string().min(1),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
