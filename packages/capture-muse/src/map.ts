import { createHash } from "node:crypto";
import type { CaptureQuality, TapeEvent, TapeEventKind, TapeLinks } from "@echo/contracts";
import { TapeEnvelopeSchema } from "@echo/contracts";
import { stableJson } from "@echo/core";
import { redactJson } from "@echo/redaction";
import type { ParsedMuseEvent, ParsedMuseMarker } from "./reader";

export const ADAPTER_VERSION = "0.1.0";
export const ADAPTER_SCHEMA = "session-jsonl/frame1";

// Single-choke-point bound for Muse-derived payloads: the live tailer, the
// import path and the export recovery all funnel through buildTapeEvent, so a
// cap here covers every path uniformly. Oversized payloads are replaced with
// a content-free marker (byte size + sha256, no raw bytes) and tagged.
export const MAX_PAYLOAD_BYTES = 256 * 1024;

export interface MuseMapContext {
  sessionId: string;
  projectId: string;
  build: string | null;
  observedAt?: Date;
}

export interface MuseMapResult {
  events: TapeEvent[];
  quality: CaptureQuality;
}

export function emptyLinks(): TapeLinks {
  return {
    turn_id: null,
    tool_call_id: null,
    batch_id: null,
    parent_session_id: null,
    subagent_id: null,
    snapshot: null,
  };
}

export function isoFromUs(microseconds: number | null): string | null {
  if (microseconds === null) return null;
  return new Date(Math.floor(microseconds / 1000)).toISOString();
}

function innerKindOf(payloadType: string, payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const candidates: unknown[] = [record.event, record.record, record];
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      const kind = (candidate as Record<string, unknown>).kind;
      if (typeof kind === "string" && kind.length > 0) return kind;
    }
  }
  // Family-level fallthrough: payload_type itself selects when no inner kind exists.
  void payloadType;
  return null;
}

function firstArrayId(value: unknown, keys: string[]): string | null {
  if (!Array.isArray(value)) return null;
  const first = value[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) return null;
  const record = first as Record<string, unknown>;
  for (const key of keys) {
    const id = record[key];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function toolCallIdFrom(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const direct = record.tool_call_id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  // Spike shapes: assistant_tool_calls_committed.tool_calls[].call_id,
  // tool_result_batch_committed.results[].tool_call_id.
  const fromCalls = firstArrayId(record.tool_calls, ["call_id", "tool_call_id"]);
  if (fromCalls) return fromCalls;
  const fromResults = firstArrayId(record.results, ["tool_call_id", "call_id"]);
  if (fromResults) return fromResults;
  for (const key of ["event", "record"]) {
    const nested = record[key];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedRecord = nested as Record<string, unknown>;
      const id = nestedRecord.tool_call_id;
      if (typeof id === "string" && id.length > 0) return id;
      const callId = nestedRecord.call_id;
      if (typeof callId === "string" && callId.length > 0) return callId;
      const nestedCalls = firstArrayId(nestedRecord.tool_calls, ["call_id", "tool_call_id"]);
      if (nestedCalls) return nestedCalls;
      const nestedResults = firstArrayId(nestedRecord.results, ["tool_call_id", "call_id"]);
      if (nestedResults) return nestedResults;
    }
  }
  return null;
}

// Conservative v1 mapping: well-understood families map precisely,
// everything else is preserved as agent.unknown rather than dropped.
function canonicalKind(payloadType: string, innerKind: string | null): TapeEventKind {
  if (payloadType === "tool_batch.effect.started") return "tool.requested";
  if (payloadType === "tool_batch.effect.terminal") return "tool.completed";
  if (payloadType === "approval_wait.effect.started") return "approval.requested";
  if (payloadType === "approval_wait.effect.terminal") return "approval.decided";
  if (
    payloadType === "runtime.user_intent.accepted" ||
    payloadType === "runtime.user_intent.materialized"
  ) {
    return "prompt.submitted";
  }
  if (payloadType === "runtime.command_intake.received") return "prompt.submitted";
  if (payloadType === "run.model.configured" || payloadType === "model_input_trace_recorded") {
    return "model.call";
  }
  if (payloadType.startsWith("reminder.cleanup_effect")) return "notification";
  // Session lifecycle lines observed live (e2e Oct 27): fork/side records
  // omit recorded_at and carry no inner kind. Map them instead of
  // preserving as unknown — lineage is understood, not drift.
  if (payloadType === "session.end") return "session.ended";
  if (payloadType === "session.resumed") return "session.started";
  if (payloadType === "session.fork.created" || payloadType === "session.fork.turn") {
    return "session.started";
  }
  if (payloadType === "session.side.started") return "subagent.started";
  if (payloadType === "session.side.boundary") return "notification";

  switch (innerKind) {
    case "requested":
      return "approval.requested";
    case "decision_applied":
      return "approval.decided";
    case "proposed":
    case "accepted":
    case "scheduled":
    case "side_effect_intent":
    case "assistant_tool_calls_committed":
      return "tool.requested";
    case "completed":
    case "tool_result_batch_committed":
      return "tool.completed";
    case "failed":
      return "tool.failed";
    case "terminal":
      return "turn.ended";
    case "cancelled":
    case "rejected":
      return "tool.failed";
    case "model_response_created":
    case "model_completed":
    case "assistant_message_committed":
    case "output":
    case "reasoning_committed":
    case "reasoning_summary_delta":
    case "reasoning_summary_committed":
      return "model.response";
    case "task_stream_linked":
    case "memory_reminder_child_session_linked":
      return "subagent.started";
    case "status":
    case "context_block_diagnostic":
    case "goal_usage_attribution":
    case "resource_usage_sampled":
    case "model_request_configured":
    case "provider_request_options_configured":
      return "notification";
    default:
      break;
  }

  if (
    payloadType === "runtime.session" ||
    payloadType === "metadata" ||
    payloadType === "session.started" ||
    payloadType === "session_start.intake_v3" ||
    payloadType === "session.opened.observed"
  ) {
    return "session.started";
  }
  return "agent.unknown";
}

interface PushInput {
  kind: TapeEventKind;
  payload: unknown;
  payloadType: string | null;
  recordType: string;
  sequence: number | null;
  ts: string | null;
  recordKey: string;
  links?: TapeLinks;
  diagnostics?: string[];
}

export interface TapeEventInput extends PushInput {
  sessionId: string;
  projectId: string;
  build: string | null;
  observedAt: string;
  tapeSeq: number;
  adapterVersion?: string;
  schema?: string | null;
  origin?: "live" | "export" | "import";
}

// Single construction site for Muse-derived tape events: redact at the
// boundary, hash the redacted content for a stable id, validate the envelope.
// Shared by the live mapper and export recovery so both produce identical shapes.
// Encrypted payloads are opaque by design and must never reach the tape
// (observed as "encrypted_content" alongside readable "text"; field names
// vary by build, so match loosely — over-stripping is acceptable because
// every removal is recorded in diagnostics below).
function stripEncryptedFields(value: unknown): { cleaned: unknown; removed: boolean } {
  if (Array.isArray(value)) {
    let removed = false;
    const cleaned = value.map((entry) => {
      const stripped = stripEncryptedFields(entry);
      removed = removed || stripped.removed;
      return stripped.cleaned;
    });
    return { cleaned, removed };
  }
  if (value !== null && typeof value === "object") {
    let removed = false;
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/encrypt/i.test(key)) {
        removed = true;
        continue;
      }
      const stripped = stripEncryptedFields(entry);
      removed = removed || stripped.removed;
      cleaned[key] = stripped.cleaned;
    }
    return { cleaned, removed };
  }
  return { cleaned: value, removed: false };
}

function boundPayload(payload: unknown): { value: unknown; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? "null";
  } catch {
    return { value: { unserializable: true }, truncated: true };
  }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_PAYLOAD_BYTES) {
    return { value: payload, truncated: false };
  }
  return {
    value: {
      truncated: true,
      bytes: Buffer.byteLength(serialized, "utf8"),
      sha256: createHash("sha256").update(serialized).digest("hex"),
    },
    truncated: true,
  };
}

export function buildTapeEvent(input: TapeEventInput): {
  event: TapeEvent;
  redactionFailed: boolean;
} {
  let payload: unknown = input.payload;
  let findings = 0;
  const diagnostics = [...(input.diagnostics ?? [])];
  const stripped = stripEncryptedFields(payload);
  if (stripped.removed) diagnostics.push("encrypted_content_removed");
  payload = stripped.cleaned;
  const bounded = boundPayload(payload);
  payload = bounded.value;
  if (bounded.truncated) diagnostics.push("truncation");
  let redactionFailed = false;
  try {
    const redacted = redactJson(payload);
    payload = redacted.value;
    findings = redacted.findings.length;
  } catch {
    payload = { redaction_failed: true, kind: input.kind };
    diagnostics.push("redaction_failed");
    redactionFailed = true;
  }
  const eventId = `evt_${createHash("sha256")
    .update(
      stableJson({
        session_id: input.sessionId,
        record_key: input.recordKey,
        kind: input.kind,
        source_ts: input.ts,
        sequence: input.sequence,
        links: input.links ?? null,
        payload,
        diagnostics,
      }),
    )
    .digest("hex")
    .slice(0, 24)}`;
  const event = TapeEnvelopeSchema.parse({
    v: 1,
    tape_seq: input.tapeSeq,
    event_id: eventId,
    record_key: input.recordKey,
    session_id: input.sessionId,
    project_id: input.projectId,
    kind: input.kind,
    ts: input.ts ?? input.observedAt,
    observed_at: input.observedAt,
    source: {
      agent: "muse",
      adapter: "muse-native",
      adapter_version: input.adapterVersion ?? ADAPTER_VERSION,
      build: input.build,
      schema: input.schema ?? ADAPTER_SCHEMA,
      record_type: input.recordType,
      payload_type: input.payloadType,
      sequence: input.sequence,
      durability: null,
      origin: input.origin ?? "live",
    },
    links: input.links ?? emptyLinks(),
    payload,
    redaction: { version: "r1", findings },
    diagnostics,
  });
  return { event, redactionFailed };
}

export function mapMuseToTape(
  parsedEvents: ParsedMuseEvent[],
  markers: ParsedMuseMarker[],
  invalidLines: number,
  ctx: MuseMapContext,
  options?: {
    // Incremental tailing resumes mid-log: a session.started already emitted
    // by an earlier chunk must not repeat as session.started again.
    sessionStartedEmitted?: boolean;
    // Chunk marker indices continue the lane counter so keys stay stable
    // across polls (parent lane matches a full read; child lanes are scoped
    // per lane to avoid cross-lane index collisions).
    markerIndexOffset?: number;
    markerLane?: string;
  },
): MuseMapResult {
  const observedIso = (ctx.observedAt ?? new Date()).toISOString();
  const events: TapeEvent[] = [];
  let tapeSeq = 0;
  let degraded = invalidLines > 0 || markers.length > 0;
  const recordKeyFor = (suffix: string): string => `muse:${ctx.sessionId}:${suffix}`;

  const push = (input: PushInput): void => {
    const { event, redactionFailed } = buildTapeEvent({
      ...input,
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      build: ctx.build,
      observedAt: observedIso,
      tapeSeq: tapeSeq++,
    });
    if (redactionFailed) degraded = true;
    events.push(event);
  };

  let sessionStartedEmitted = options?.sessionStartedEmitted ?? false;
  for (const record of parsedEvents) {
    const innerKind = innerKindOf(record.payloadType, record.payload);
    let kind = canonicalKind(record.payloadType, innerKind);
    // Only the first session-family line opens the session; the rest are hints.
    if (kind === "session.started") {
      if (sessionStartedEmitted) kind = "notification";
      else sessionStartedEmitted = true;
    }
    const diagnostics: string[] = [];
    if (kind === "agent.unknown") {
      diagnostics.push("unknown_payload_type");
      degraded = true;
    }
    // Fork/side lines omit recorded_at; the event is kept with an
    // observed_at fallback so lineage survives, but quality stays partial.
    if (record.recordedAtUs === null) {
      diagnostics.push("missing_source_timestamp");
      degraded = true;
    }
    const links = emptyLinks();
    // Child lane: a stream id that is not the parent session id.
    if (record.stream.id !== ctx.sessionId) {
      links.subagent_id = record.stream.id;
      links.parent_session_id = ctx.sessionId;
    }
    // v1 limit: a batch links only its first call id. The full batch stays in
    // the redacted payload, but the other calls are unlinkable for hunk
    // evidence until per-part expansion (as the OpenCode adapter does).
    const toolCallId = toolCallIdFrom(record.payload);
    if (
      toolCallId &&
      (kind === "tool.requested" || kind === "tool.completed" || kind === "tool.failed")
    ) {
      links.tool_call_id = toolCallId;
    }
    push({
      kind,
      payload: record.payload,
      payloadType: record.payloadType,
      recordType: "event",
      sequence: record.sequence,
      ts: isoFromUs(record.recordedAtUs),
      recordKey: recordKeyFor(`${record.stream.id}:${record.sequence}`),
      links,
      diagnostics,
    });
  }

  for (const marker of markers) {
    push({
      kind: "capture.compaction",
      payload: { omission_class: marker.omissionClass },
      payloadType: "retained_marker",
      recordType: "marker",
      sequence: null,
      ts: null,
      recordKey: recordKeyFor(
        `marker:${options?.markerLane ? `${options.markerLane}:` : ""}${(options?.markerIndexOffset ?? 0) + markers.indexOf(marker)}`,
      ),
      diagnostics: [],
    });
  }

  if (invalidLines > 0) {
    degraded = true;
    push({
      kind: "capture.gap",
      payload: { code: "schema_drift", invalid_lines: invalidLines },
      payloadType: null,
      recordType: "parse",
      sequence: null,
      ts: null,
      recordKey: recordKeyFor("parse:invalid"),
      diagnostics: ["skipped_source_record"],
    });
  }

  return { events, quality: degraded ? "partial" : "full" };
}
