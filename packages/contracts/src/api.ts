import { z } from "zod";

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

export const ProjectSummarySchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  remoteUrl: z.string().nullable(),
  name: z.string().nullable(),
  sessionCount: z.number().int().nonnegative(),
  lastActivity: z.string().nullable(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const SessionSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().nullable(),
  model: z.string().nullable(),
  directory: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  status: z.string().min(1),
  captureQuality: z.string().min(1),
  eventCount: z.number().int().nonnegative(),
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
  redaction: z.object({ version: z.string(), findings: z.number().int().nonnegative() }),
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
  id: z.string().min(1),
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
  evidenceByHunk: z.record(z.string(), z.array(HunkEvidenceSchema)),
  diagnostics: z.array(z.string()),
  generatedAt: z.string(),
});
export type SessionReview = z.infer<typeof SessionReviewSchema>;

export const AskRequestSchema = z.object({
  question: z.string().min(1).max(2000),
  filePath: z.string().min(1).max(1024).nullable().default(null),
  symbols: z.array(z.string().min(1).max(256)).max(16).default([]),
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

export const GenerateChecksRequestSchema = z.object({
  limit: z.number().int().min(1).max(5).default(3),
  opened: z.array(z.string().min(1)).max(1000).default([]),
  waived: z.array(z.string().min(1)).max(1000).default([]),
});
export type GenerateChecksRequest = z.infer<typeof GenerateChecksRequestSchema>;

export const StoredCheckSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  hunkId: z.string().min(1),
  path: z.string().min(1),
  kind: CheckKindSchema,
  question: z.string().min(1),
  evidencePaths: z.array(z.string()),
  rubric: z.array(z.string()),
  demonstration: z.object({ code: z.string(), observedStdout: z.string() }).nullable(),
  createdAt: z.string().min(1),
});
export type StoredCheck = z.infer<typeof StoredCheckSchema>;

export const GenerateChecksResponseSchema = z.object({
  checks: z.array(StoredCheckSchema),
  dropped: z.array(z.object({ hunkId: z.string(), reason: z.string() })),
  sandboxAvailable: z.boolean(),
});
export type GenerateChecksResponse = z.infer<typeof GenerateChecksResponseSchema>;

export const AnswerConfidenceSchema = z.enum(["guessing", "think_so", "certain"]);
export type AnswerConfidence = z.infer<typeof AnswerConfidenceSchema>;

export const AnswerCheckRequestSchema = z.object({
  confidence: AnswerConfidenceSchema,
  answer: z.string().min(1).max(8000),
});
export type AnswerCheckRequest = z.infer<typeof AnswerCheckRequestSchema>;

export const RubricHitSchema = z.object({
  point: z.string().min(1),
  hit: z.boolean(),
  excerpt: z.string().nullable(),
  why: z.string().nullable(),
});
export type RubricHit = z.infer<typeof RubricHitSchema>;

export const CheckAttemptSchema = z.object({
  id: z.string().min(1),
  checkId: z.string().min(1),
  confidence: AnswerConfidenceSchema,
  confidenceP: z.number().min(0).max(1),
  answer: z.string(),
  correct: z.boolean(),
  reason: z.string().nullable(),
  hits: z.array(RubricHitSchema),
  brier: z.number().min(0).max(1),
  overconfident: z.boolean(),
  underconfident: z.boolean(),
  createdAt: z.string().min(1),
});
export type CheckAttempt = z.infer<typeof CheckAttemptSchema>;

export const AnswerCheckResponseSchema = z.object({
  attempt: CheckAttemptSchema,
  reference: z.object({
    rubric: z.array(z.string()),
    hits: z.array(RubricHitSchema),
  }),
});
export type AnswerCheckResponse = z.infer<typeof AnswerCheckResponseSchema>;

export const SessionChecksResponseSchema = z.object({
  checks: z.array(StoredCheckSchema),
  attempts: z.record(z.string(), z.array(CheckAttemptSchema)),
  waived: z.array(z.string()),
});
export type SessionChecksResponse = z.infer<typeof SessionChecksResponseSchema>;

export const SessionReportSchema = z.object({
  sessionId: z.string().min(1),
  generatedAt: z.string().min(1),
  hunksTotal: z.number().int().nonnegative(),
  checksTotal: z.number().int().nonnegative(),
  answered: z.number().int().nonnegative(),
  correct: z.number().int().nonnegative(),
  waived: z.array(z.string()),
  calibration: z.object({
    meanBrier: z.number().nullable(),
    overconfidenceCount: z.number().int().nonnegative(),
    perConfidence: z.array(
      z.object({
        confidence: AnswerConfidenceSchema,
        answered: z.number().int().nonnegative(),
        correct: z.number().int().nonnegative(),
      }),
    ),
  }),
  gaps: z.array(z.string()),
});
export type SessionReport = z.infer<typeof SessionReportSchema>;
