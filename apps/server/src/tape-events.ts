import { createHash } from "node:crypto";
import {
  type AgentId,
  type CaptureGapCode,
  TapeEnvelopeSchema,
  type TapeEvent,
} from "@echo/contracts";
import { stableJson } from "@echo/core";
import { redactJson } from "@echo/redaction";
import type { SnapshotResult } from "@echo/snapshots";

function eventIdFor(seed: unknown): string {
  return `evt_${createHash("sha256").update(stableJson(seed)).digest("hex").slice(0, 24)}`;
}

function emptyLinks() {
  return {
    turn_id: null,
    tool_call_id: null,
    batch_id: null,
    parent_session_id: null,
    subagent_id: null,
    snapshot: null,
  };
}

export interface GapEventInput {
  agent: AgentId;
  sessionId: string;
  projectId: string;
  observedAt: string;
  key: string;
  code: CaptureGapCode;
  detail: Record<string, unknown>;
}

export function makeGapEvent(input: GapEventInput): TapeEvent {
  const redacted = redactJson({ code: input.code, ...input.detail });
  return TapeEnvelopeSchema.parse({
    v: 1,
    tape_seq: 0,
    event_id: eventIdFor({
      session_id: input.sessionId,
      kind: "capture.gap",
      key: input.key,
    }),
    record_key: null,
    session_id: input.sessionId,
    project_id: input.projectId,
    kind: "capture.gap",
    ts: input.observedAt,
    observed_at: input.observedAt,
    source: {
      agent: input.agent,
      adapter: "opencode-sqlite",
      adapter_version: "0.2.0",
      build: null,
      schema: "opencode.db/session_v2",
      record_type: "echo_gap",
      payload_type: null,
      sequence: null,
      durability: null,
      origin: "import",
    },
    links: emptyLinks(),
    payload: redacted.value,
    redaction: { version: "r1", findings: redacted.findings.length },
    diagnostics: [input.code],
  });
}

export function makeSnapshotEventId(sessionId: string, trigger: string, key: string): string {
  return eventIdFor({ session_id: sessionId, kind: "file.snapshot", trigger, key });
}

export interface SnapshotEventInput {
  agent: AgentId;
  sessionId: string;
  projectId: string;
  eventId: string;
  observedAt: string;
  result: SnapshotResult;
}

export function makeSnapshotEvent(input: SnapshotEventInput): TapeEvent {
  const result = input.result;
  const redacted = redactJson({
    trigger: result.trigger,
    commit_oid: result.commitOid,
    parent_oid: result.parentOid,
    file_count: result.fileCount,
    total_bytes: result.totalBytes,
    status: result.status,
    diagnostics: result.diagnostics,
    redaction_findings: result.redactionFindings,
  });
  return TapeEnvelopeSchema.parse({
    v: 1,
    tape_seq: 0,
    event_id: input.eventId,
    record_key: null,
    session_id: input.sessionId,
    project_id: input.projectId,
    kind: "file.snapshot",
    ts: result.takenAt,
    observed_at: input.observedAt,
    source: {
      agent: input.agent,
      adapter: "shadow-git",
      adapter_version: "0.1.0",
      build: null,
      schema: null,
      record_type: "echo_snapshot",
      payload_type: null,
      sequence: null,
      durability: null,
      origin: "import",
    },
    links: {
      ...emptyLinks(),
      snapshot: { kind: "shadow", snapshot_id: result.commitOid },
    },
    payload: redacted.value,
    redaction: { version: "r1", findings: redacted.findings.length },
    diagnostics: result.diagnostics.slice(0, 16),
  });
}
