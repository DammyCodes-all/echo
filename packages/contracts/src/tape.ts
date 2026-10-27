import { z } from "zod";
import { EvidenceLabelSchema } from "./evidence";
import { SnapshotRefSchema } from "./snapshot";
import { TapeSourceSchema } from "./source";

export const CaptureQualitySchema = z.enum(["full", "partial", "degraded", "import_only"]);
export type CaptureQuality = z.infer<typeof CaptureQualitySchema>;

export const CaptureGapCodeSchema = z.enum([
  "sequence_jump",
  "sequence_reset",
  "source_truncated",
  "source_replaced",
  "frame_embedded",
  "checkpoint_trim",
  "redaction_failed",
  "truncation",
  "hook_failure",
  "export_unavailable",
  "concurrent_sessions",
  "unstable_file",
  "unknown_payload_type",
  "schema_drift",
]);
export type CaptureGapCode = z.infer<typeof CaptureGapCodeSchema>;

export const TapeEventKindSchema = z.enum([
  "session.started",
  "prompt.submitted",
  "model.call",
  "model.response",
  "approval.requested",
  "approval.decided",
  "tool.requested",
  "tool.completed",
  "tool.failed",
  "tool.batch",
  "file.snapshot",
  "capture.compaction",
  "capture.gap",
  "capture.reconciled",
  "subagent.started",
  "subagent.stopped",
  "turn.ended",
  "turn.failed",
  "session.ended",
  "notification",
  "agent.unknown",
  "review.hunk_opened",
  "review.answer",
  "check.generated",
  "check.answered",
  "report.generated",
]);
export type TapeEventKind = z.infer<typeof TapeEventKindSchema>;

export const TapeLinksSchema = z.object({
  turn_id: z.string().nullable().default(null),
  tool_call_id: z.string().nullable().default(null),
  batch_id: z.string().nullable().default(null),
  parent_session_id: z.string().nullable().default(null),
  subagent_id: z.string().nullable().default(null),
  snapshot: SnapshotRefSchema.nullable().default(null),
});
export type TapeLinks = z.infer<typeof TapeLinksSchema>;

export const TapeEnvelopeSchema = z.object({
  v: z.literal(1),
  tape_seq: z.number().int().nonnegative(),
  event_id: z.string().min(1),
  session_id: z.string().min(1),
  project_id: z.string().min(1),
  kind: TapeEventKindSchema,
  ts: z.string().min(1),
  observed_at: z.string().min(1),
  source: TapeSourceSchema,
  links: TapeLinksSchema,
  payload: z.unknown(),
  redaction: z.object({
    version: z.string().min(1),
    findings: z.number().int().nonnegative(),
  }),
  diagnostics: z.array(z.string()).max(16),
});
export type TapeEvent = z.infer<typeof TapeEnvelopeSchema>;

export const SessionMetaSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  agent: z.string().min(1),
  agent_version: z.string().nullable(),
  capture_quality: CaptureQualitySchema,
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const EvidenceRefSchema = z.object({
  evidence_id: z.string().min(1),
  kind: EvidenceLabelSchema,
  event_id: z.string().nullable(),
  snapshot: SnapshotRefSchema.nullable(),
  ts: z.string().nullable(),
  quote: z.string().nullable(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
