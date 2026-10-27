import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "invalid_request",
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
