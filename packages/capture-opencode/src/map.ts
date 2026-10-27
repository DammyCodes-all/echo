import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type CaptureQuality,
  type SnapshotRef,
  SnapshotRefSchema,
  TapeEnvelopeSchema,
  type TapeEvent,
  type TapeEventKind,
  type TapeLinks,
} from "@echo/contracts";
import { stableJson } from "@echo/core";
import { redactJson } from "@echo/redaction";
import {
  type OpenCodeMessageRow,
  type OpenCodeSessionSummary,
  type OpenCodeSkippedRow,
  projectIdForDirectory,
  readOpenCodeMessages,
  sessionModelLabel,
} from "./store";

const ADAPTER_VERSION = "0.2.0";
const ADAPTER_SCHEMA = "opencode.db/session_v2";
const MAX_ERROR_CHARS = 500;

export interface SessionImport {
  session: OpenCodeSessionSummary;
  projectId: string;
  events: TapeEvent[];
  quality: CaptureQuality;
  baselineOid: string | null;
}

interface PushInput {
  kind: TapeEventKind;
  payload: unknown;
  recordType: string;
  sequence: number | null;
  ts: string | null;
  recordKey: string;
  links?: TapeLinks;
  diagnostics?: string[];
}

function emptyLinks(): TapeLinks {
  return {
    turn_id: null,
    tool_call_id: null,
    batch_id: null,
    parent_session_id: null,
    subagent_id: null,
    snapshot: null,
  };
}

function isoFromMs(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

type GitOidSnapshot = Extract<SnapshotRef, { kind: "git_oids" }>;

function snapshotFrom(value: unknown): GitOidSnapshot | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as { start?: unknown; end?: unknown };
  const parsed = SnapshotRefSchema.safeParse({
    kind: "git_oids",
    start_oid: typeof raw.start === "string" ? raw.start : "",
    end_oid: typeof raw.end === "string" ? raw.end : null,
  });
  return parsed.success && parsed.data.kind === "git_oids" ? parsed.data : null;
}

function summarizeError(
  value: unknown,
): { type: string | null; message: string | null; status: number | null } | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    type: typeof raw.type === "string" ? raw.type : null,
    message: typeof raw.message === "string" ? raw.message.slice(0, MAX_ERROR_CHARS) : null,
    status: typeof raw.status === "number" ? raw.status : null,
  };
}

function createdMs(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  const time = (value as { time?: unknown }).time;
  if (time === null || typeof time !== "object") return null;
  const created = (time as { created?: unknown }).created;
  return typeof created === "number" ? created : null;
}

function messageTimeMs(message: OpenCodeMessageRow): number | null {
  const time = message.data.time as { created?: unknown } | undefined;
  return typeof time?.created === "number" ? time.created : message.timeCreated;
}

function partsOf(message: OpenCodeMessageRow): Array<Record<string, unknown>> {
  const content = message.data.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is Record<string, unknown> => part !== null && typeof part === "object",
  );
}

function toolKind(status: unknown): TapeEventKind {
  if (status === "error") return "tool.failed";
  if (status === "completed") return "tool.completed";
  return "tool.requested";
}

function sanitizeEvidence(value: unknown): unknown {
  // Encrypted reasoning is opaque: excluded from the tape (ARCHITECTURE
  // §13) and dead weight in bundles — ~1.5 kB of unmatchable ciphertext
  // per blob that can even win word-overlap. It hides in two places:
  // reasoning parts, and tool-result content that embeds the preceding
  // conversation. Readable rationale stays as agent-stated evidence.
  if (Array.isArray(value)) {
    const cleaned: unknown[] = [];
    for (const entry of value) {
      const out = sanitizeEvidence(entry);
      if (out !== undefined) cleaned.push(out);
    }
    return cleaned;
  }
  if (typeof value === "string") {
    // Tool results sometimes embed serialized conversations as text, not
    // structure. Scrub the ciphertext value in place so the string stays
    // valid for any downstream JSON.parse.
    return value.replace(
      /"reasoningEncryptedContent"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
      '"reasoningEncryptedContent":"[withheld]"',
    );
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "reasoning") {
      return typeof record.text === "string" && record.text.length > 0
        ? { type: "reasoning", text: record.text }
        : undefined;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (key === "reasoningEncryptedContent") continue;
      const cleaned = sanitizeEvidence(entry);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

export function importOpenCodeSession(
  db: DatabaseSync,
  session: OpenCodeSessionSummary,
  observedAt: Date = new Date(),
): SessionImport {
  const projectId = projectIdForDirectory(session.directory ?? "unknown");
  const observedIso = observedAt.toISOString();
  const events: TapeEvent[] = [];
  let tapeSeq = 0;
  let baselineOid: string | null = null;
  let degraded = false;

  const recordKeyFor = (suffix: string): string => `opencode:${session.id}:${suffix}`;

  const push = (input: PushInput): void => {
    let payload: unknown = input.payload;
    let findings = 0;
    const diagnostics = [...(input.diagnostics ?? [])];
    try {
      const redacted = redactJson(input.payload);
      payload = redacted.value;
      findings = redacted.findings.length;
    } catch {
      payload = { redaction_failed: true, kind: input.kind };
      diagnostics.push("redaction_failed");
      degraded = true;
    }

    const eventId = `evt_${createHash("sha256")
      .update(
        stableJson({
          session_id: session.id,
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

    events.push(
      TapeEnvelopeSchema.parse({
        v: 1,
        tape_seq: tapeSeq++,
        event_id: eventId,
        record_key: input.recordKey,
        session_id: session.id,
        project_id: projectId,
        kind: input.kind,
        ts: input.ts ?? observedIso,
        observed_at: observedIso,
        source: {
          agent: "opencode",
          adapter: "opencode-sqlite",
          adapter_version: ADAPTER_VERSION,
          build: null,
          schema: ADAPTER_SCHEMA,
          record_type: input.recordType,
          payload_type: null,
          sequence: input.sequence,
          durability: null,
          origin: "import",
        },
        links: input.links ?? emptyLinks(),
        payload,
        redaction: { version: "r1", findings },
        diagnostics,
      }),
    );
  };

  push({
    kind: "session.started",
    payload: {
      title: session.title,
      directory: session.directory,
      model: session.model,
      model_label: sessionModelLabel(session.model),
      agent: session.agent,
      time_created: session.timeCreated,
      time_updated: session.timeUpdated,
    },
    recordType: "session_v2",
    sequence: null,
    ts: isoFromMs(session.timeCreated),
    recordKey: recordKeyFor("session"),
  });

  const read = readOpenCodeMessages(db, session.id);
  type OrderedRow =
    | { kind: "message"; message: OpenCodeMessageRow }
    | { kind: "skipped"; skipped: OpenCodeSkippedRow };
  const ordered: OrderedRow[] = [
    ...read.messages.map((message): OrderedRow => ({ kind: "message", message })),
    ...read.skipped.map((skipped): OrderedRow => ({ kind: "skipped", skipped })),
  ].sort((a, b) => {
    const left = a.kind === "message" ? a.message.seq : a.skipped.seq;
    const right = b.kind === "message" ? b.message.seq : b.skipped.seq;
    return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
  });

  for (const row of ordered) {
    if (row.kind === "skipped") {
      const skipped = row.skipped;
      degraded = true;
      push({
        kind: "capture.gap",
        payload: {
          code: "schema_drift",
          record_id: skipped.id,
          source_sequence: skipped.seq,
          detail: skipped.reason,
        },
        recordType: "session_message",
        sequence: skipped.seq,
        ts: null,
        recordKey: recordKeyFor(`msg:${skipped.id}`),
        diagnostics: ["skipped_source_record"],
      });
      continue;
    }

    const message = row.message;
    const time = message.data.time as { created?: unknown } | undefined;
    const ts = isoFromMs(typeof time?.created === "number" ? time.created : message.timeCreated);
    const messageKey = recordKeyFor(`msg:${message.id}`);

    if (message.type === "user") {
      push({
        kind: "prompt.submitted",
        payload: { text: message.data.text ?? null, files: message.data.files ?? null },
        recordType: message.type,
        sequence: message.seq,
        ts,
        recordKey: messageKey,
      });
      continue;
    }

    if (message.type === "system") {
      push({
        kind: "notification",
        payload: {
          text: message.data.text ?? null,
          description: message.data.description ?? null,
        },
        recordType: message.type,
        sequence: message.seq,
        ts,
        recordKey: messageKey,
      });
      continue;
    }

    if (message.type === "idle") {
      const outcome = typeof message.data.outcome === "string" ? message.data.outcome : "unknown";
      const diagnostics = outcome === "unknown" ? ["unknown_idle_outcome"] : [];
      if (outcome === "unknown") degraded = true;
      push({
        kind: outcome === "failed" ? "turn.failed" : "turn.ended",
        payload: { outcome, error: summarizeError(message.data.error) },
        recordType: message.type,
        sequence: message.seq,
        ts,
        recordKey: messageKey,
        diagnostics,
      });
      continue;
    }

    if (message.type === "assistant") {
      const parts = partsOf(message);
      const toolParts = parts.filter((part) => part.type === "tool");
      const textParts = parts
        .filter((part) => part.type !== "tool")
        .map((part) => sanitizeEvidence(part))
        .filter(
          (part): part is Record<string, unknown> => part !== null && typeof part === "object",
        );
      const snapshot = snapshotFrom(message.data.snapshot);
      if (baselineOid === null && snapshot) baselineOid = snapshot.start_oid;
      const firstTextTs = textParts
        .map((part) => createdMs(part))
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b)[0];
      push({
        kind: "model.response",
        payload: {
          parts: textParts,
          model: message.data.model ?? null,
          finish: message.data.finish ?? null,
          error: summarizeError(message.data.error),
        },
        recordType: message.type,
        sequence: message.seq,
        ts: isoFromMs(firstTextTs ?? messageTimeMs(message)),
        recordKey: messageKey,
        links: { ...emptyLinks(), snapshot },
      });
      for (const [index, part] of toolParts.entries()) {
        const state = (part.state ?? {}) as Record<string, unknown>;
        const partId = part.id ? String(part.id) : `index:${index}`;
        const status = state.status;
        const pending = status !== "completed" && status !== "error";
        push({
          kind: toolKind(status),
          payload: {
            name: part.name ?? null,
            status: status ?? null,
            input: state.input == null ? null : sanitizeEvidence(state.input),
            content: state.content == null ? null : sanitizeEvidence(state.content),
            executed: part.executed ?? null,
            native: part.native ?? null,
          },
          recordType: message.type,
          sequence: message.seq,
          ts: isoFromMs(createdMs(part) ?? messageTimeMs(message)),
          recordKey: `${messageKey}:tool:${partId}`,
          links: {
            ...emptyLinks(),
            tool_call_id: part.id ? partId : null,
            snapshot,
          },
          diagnostics: pending ? ["tool_pending"] : [],
        });
      }
      continue;
    }

    degraded = true;
    push({
      kind: "agent.unknown",
      payload: { message_type: message.type, data: message.data },
      recordType: message.type,
      sequence: message.seq,
      ts,
      recordKey: messageKey,
      diagnostics: ["unknown_message_type"],
    });
  }

  return {
    session,
    projectId,
    events,
    quality: degraded ? "partial" : "import_only",
    baselineOid,
  };
}
