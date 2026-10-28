import type { CaptureQuality, TapeEvent } from "@echo/contracts";
import { collectReferencedChildIds } from "./finalize";
import { buildTapeEvent, emptyLinks, isoFromUs, mapMuseToTape } from "./map";
import {
  detectSequenceGaps,
  isRecord,
  parseMuseLines,
  tryParseEvent,
  tryParseMarker,
} from "./reader";

// Lines past this size are skipped, never parsed: a single runaway line must
// not pin memory or the poll. Each skip is a visible truncation gap keyed by
// its byte offset, so retries dedupe instead of duplicating.
export const MAX_TAIL_LINE_BYTES = 8 * 1024 * 1024;

// Resume state for one lane (parent log or one child log). In-memory
// quiescence stays in the daemon; only this resume state persists in SQLite,
// so a restart re-reads at most one poll of bytes and re-establishes
// quiescence within two polls.
export interface LaneCursor {
  lastSequence: number | null;
  lastEventTs: string | null;
  trailingMarkerAfter: number | null;
  markerCount: number;
  sessionStarted: boolean;
}

export function freshLaneCursor(): LaneCursor {
  return {
    lastSequence: null,
    lastEventTs: null,
    trailingMarkerAfter: null,
    markerCount: 0,
    sessionStarted: false,
  };
}

export interface TailChunkInput {
  sessionId: string;
  projectId: string;
  build: string | null;
  // '' for the parent log, child dir name for child logs.
  lane: string;
  // New bytes since cursor offset, decoded as UTF-8. May end mid-line.
  chunk: string;
  // Byte offset the chunk starts at; anchors offset-keyed gap recordKeys.
  baseOffset: number;
  observedAt: Date;
  cursor: LaneCursor;
}

export interface TailChunkResult {
  events: TapeEvent[];
  diagnostics: string[];
  // Per-chunk floor signal only: full unless this chunk saw gaps, skipped
  // lines, or unknown payloads. Not the session verdict — the wiring layer
  // must reconcile chunk diagnostics with export reconciliation and snapshot
  // reports through finalizeMuseSession, which remains the single quality
  // decider.
  quality: CaptureQuality;
  next: LaneCursor;
  // Bytes of the chunk up to the last complete newline; the caller advances
  // the checkpoint by this and re-reads the torn remainder next poll.
  consumedBytes: number;
  hasNew: boolean;
  referencedChildIds: Map<string, number | null>;
  oversizedLines: number;
  invalidLines: number;
  truncatedTail: boolean;
  schemaVersion: number | null;
  // Any new event at or below the persisted cursor: the file was rewritten in
  // place (same inode, size not shrunk). The caller resets to the beginning,
  // re-reads, dedupes, and emits a sequence_reset gap.
  nonMonotonic: boolean;
}

// Absolute byte offset of the first line parseMuseLines would count
// invalid. Keying the parse-invalid gap by it (not by chunk base offset)
// survives re-chunking: same line, same key, whatever the poll split.
// Mirrors the reader's acceptance rules exactly — blank lines ignored,
// header frames kept, marker/event classification via the shared
// classifiers — so keep the two in sync.
function firstInvalidOffset(
  kept: string[],
  keptOffsets: number[],
  cursorLastSequence: number | null,
): number | null {
  let lastSequence = cursorLastSequence;
  for (let index = 0; index < kept.length; index++) {
    const line = kept[index] as string;
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return keptOffsets[index] as number;
    }
    if (!isRecord(parsed)) return keptOffsets[index] as number;
    if (!("stream" in parsed) || !("sequence" in parsed)) continue;
    if (tryParseMarker(parsed, lastSequence)) continue;
    const event = tryParseEvent(parsed);
    if (event) {
      lastSequence = event.sequence;
      continue;
    }
    return keptOffsets[index] as number;
  }
  return null;
}

// Pure chunk parser: split, skip oversized lines, parse, map, and emit gaps
// with the same recordKey shapes as a full finalize so event ids stay
// deterministic and DB dedupe keeps working. All fs/DB work stays in ingest.
export function tailChunk(input: TailChunkInput): TailChunkResult {
  const observedIso = input.observedAt.toISOString();
  const ctx = {
    sessionId: input.sessionId,
    projectId: input.projectId,
    build: input.build,
    observedAt: input.observedAt,
  };

  const endsWithNewline = input.chunk === "" || input.chunk.endsWith("\n");
  const segments = input.chunk.split("\n");
  const remainder = endsWithNewline ? "" : (segments.pop() ?? "");
  if (endsWithNewline) segments.pop();
  let offset = input.baseOffset;
  const kept: string[] = [];
  const keptOffsets: number[] = [];
  const oversizedOffsets: Array<{ offset: number; bytes: number }> = [];
  for (const line of segments) {
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (Buffer.byteLength(line, "utf8") > MAX_TAIL_LINE_BYTES) {
      oversizedOffsets.push({ offset, bytes: bytes - 1 });
      offset += bytes;
      continue;
    }
    kept.push(line);
    keptOffsets.push(offset);
    offset += bytes;
  }
  const consumedBytes = offset - input.baseOffset;

  const parsed = parseMuseLines(kept);
  // Chunk-leading markers carry null afterSequence (no event seen yet in this
  // chunk). For gap purposes they inherit the persisted cursor: a marker run
  // continued across the chunk boundary still explains the jump.
  const adjustedMarkers = parsed.markers.map((marker) =>
    marker.afterSequence === null && input.cursor.lastSequence !== null
      ? { ...marker, afterSequence: input.cursor.lastSequence }
      : marker,
  );

  const sequencesByStream = new Map<string, number[]>();
  const tsByStreamSeq = new Map<string, string>();
  for (const event of parsed.events) {
    const list = sequencesByStream.get(event.stream.id) ?? [];
    list.push(event.sequence);
    sequencesByStream.set(event.stream.id, list);
    tsByStreamSeq.set(`${event.stream.id}:${event.sequence}`, isoFromUs(event.recordedAtUs));
  }
  const markersByStream = new Map<string, typeof adjustedMarkers>();
  for (const marker of adjustedMarkers) {
    const list = markersByStream.get(marker.stream.id) ?? [];
    list.push(marker);
    markersByStream.set(marker.stream.id, list);
  }

  const gaps: Array<{ streamId: string; from: number; to: number }> = [];
  for (const [streamId, sequences] of sequencesByStream) {
    for (const gap of detectSequenceGaps(sequences, markersByStream.get(streamId) ?? [])) {
      gaps.push({ streamId, from: gap.fromSequence, to: gap.toSequence });
    }
    // Boundary jump against the persisted cursor. Single-stream lanes are
    // the norm; a mixed-stream file may over-flag here, which stays visible
    // as a gap rather than silently passing.
    // No spread: a catch-up chunk can hold far more sequences than an
    // argument list can take.
    let first = Number.POSITIVE_INFINITY;
    for (const sequence of sequences) if (sequence < first) first = sequence;
    const prev = input.cursor.lastSequence;
    if (prev !== null && first > prev + 1) {
      const explained =
        (input.cursor.trailingMarkerAfter !== null &&
          input.cursor.trailingMarkerAfter >= prev &&
          input.cursor.trailingMarkerAfter < first) ||
        (markersByStream.get(streamId) ?? []).some(
          (marker) =>
            marker.afterSequence !== null &&
            marker.afterSequence >= prev &&
            marker.afterSequence < first,
        );
      if (!explained) gaps.unshift({ streamId, from: prev, to: first });
    }
  }

  const mapped = mapMuseToTape(parsed.events, parsed.markers, 0, ctx, {
    sessionStartedEmitted: input.cursor.sessionStarted,
    markerIndexOffset: input.cursor.markerCount,
    markerLane: input.lane === "" ? undefined : input.lane,
  });
  const events = [...mapped.events];
  const diagnostics: string[] = [];
  if (gaps.length > 0) diagnostics.push("sequence_jump");
  if (oversizedOffsets.length > 0) diagnostics.push("truncation");
  if (parsed.invalidLines > 0) diagnostics.push("skipped_source_record");
  // Torn tails stay diagnostics-only and transient: the partial line is held
  // for the next poll, never ingested, and — unlike persistent gaps — never
  // feeds the sticky session quality below (a mid-write poll must not stain
  // the session partial forever; a full re-read clears it the same way).
  if (remainder !== "") diagnostics.push("truncated_tail");

  for (const gap of gaps) {
    const { event } = buildTapeEvent({
      kind: "capture.gap",
      payload: {
        code: "sequence_jump",
        stream_id: gap.streamId,
        from_sequence: gap.from,
        to_sequence: gap.to,
      },
      payloadType: null,
      recordType: "gap",
      sequence: null,
      ts:
        tsByStreamSeq.get(`${gap.streamId}:${gap.from}`) ?? input.cursor.lastEventTs ?? observedIso,
      recordKey: `muse:${input.sessionId}:gap:${gap.streamId}:${gap.from}-${gap.to}`,
      links: emptyLinks(),
      diagnostics: ["sequence_jump"],
      sessionId: input.sessionId,
      projectId: input.projectId,
      build: input.build,
      observedAt: observedIso,
      tapeSeq: events.length,
      schema: null,
      origin: "live",
    });
    events.push(event);
  }
  for (const skipped of oversizedOffsets) {
    const { event } = buildTapeEvent({
      kind: "capture.gap",
      payload: {
        code: "truncation",
        lane: input.lane === "" ? null : input.lane,
        offset: skipped.offset,
        bytes: skipped.bytes,
      },
      payloadType: null,
      recordType: "gap",
      sequence: null,
      ts: observedIso,
      recordKey: `muse:${input.sessionId}:gap:truncation:${skipped.offset}`,
      links: emptyLinks(),
      diagnostics: ["truncation"],
      sessionId: input.sessionId,
      projectId: input.projectId,
      build: input.build,
      observedAt: observedIso,
      tapeSeq: events.length,
      schema: null,
      origin: "live",
    });
    events.push(event);
  }
  if (parsed.invalidLines > 0) {
    // Key by the offending line's absolute offset, not the chunk start, so
    // the same line re-chunked on a later poll dedupes instead of duplicating.
    const invalidAt = firstInvalidOffset(kept, keptOffsets, input.cursor.lastSequence);
    const { event } = buildTapeEvent({
      kind: "capture.gap",
      payload: { code: "schema_drift", invalid_lines: parsed.invalidLines },
      payloadType: null,
      recordType: "parse",
      sequence: null,
      ts: observedIso,
      recordKey: `muse:${input.sessionId}:gap:parse-invalid:${invalidAt ?? input.baseOffset}`,
      links: emptyLinks(),
      diagnostics: ["skipped_source_record"],
      sessionId: input.sessionId,
      projectId: input.projectId,
      build: input.build,
      observedAt: observedIso,
      tapeSeq: events.length,
      schema: null,
      origin: "live",
    });
    events.push(event);
  }

  let maxSequence = input.cursor.lastSequence;
  let maxTs = input.cursor.lastEventTs;
  let nonMonotonic = false;
  for (const event of parsed.events) {
    if (input.cursor.lastSequence !== null && event.sequence <= input.cursor.lastSequence) {
      nonMonotonic = true;
    }
    if (maxSequence === null || event.sequence > maxSequence) {
      maxSequence = event.sequence;
      maxTs = isoFromUs(event.recordedAtUs);
    }
  }
  let trailingMarkerAfter = input.cursor.trailingMarkerAfter;
  if (parsed.markers.length > 0) {
    trailingMarkerAfter = adjustedMarkers[adjustedMarkers.length - 1]?.afterSequence ?? null;
  } else if (parsed.events.length > 0) {
    trailingMarkerAfter = null;
  }
  const next: LaneCursor = {
    lastSequence: maxSequence,
    lastEventTs: maxTs,
    trailingMarkerAfter,
    markerCount: input.cursor.markerCount + parsed.markers.length,
    sessionStarted:
      input.cursor.sessionStarted ||
      mapped.events.some((event) => event.kind === "session.started"),
  };

  const quality: CaptureQuality =
    gaps.length > 0 ||
    oversizedOffsets.length > 0 ||
    parsed.invalidLines > 0 ||
    mapped.quality !== "full"
      ? "partial"
      : "full";

  return {
    events,
    diagnostics,
    quality,
    next,
    consumedBytes,
    hasNew: events.length > 0,
    referencedChildIds: collectReferencedChildIds(parsed.events, input.sessionId),
    oversizedLines: oversizedOffsets.length,
    invalidLines: parsed.invalidLines,
    truncatedTail: remainder !== "",
    schemaVersion: parsed.schemaVersion,
    nonMonotonic,
  };
}
