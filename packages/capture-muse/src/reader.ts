export interface MuseStream {
  kind: string;
  id: string;
}

export interface ParsedMuseEvent {
  id: string;
  stream: MuseStream;
  sequence: number;
  // Null when the source line carries no recorded_at (observed on
  // session.fork.* / session.side.* lines). The mapper falls back to the
  // daemon clock and labels the event, rather than dropping evidence.
  recordedAtUs: number | null;
  payloadType: string;
  payload: unknown;
  causationId: string | null;
  durability: string | null;
}

export interface ParsedMuseMarker {
  stream: MuseStream;
  omissionClass: string | null;
  // Last event sequence seen in file order before this marker. Lets gap
  // detection tell marker-adjacent jumps (checkpoint trimming) apart from
  // genuine loss elsewhere in the stream.
  afterSequence: number | null;
  raw: unknown;
}

export interface ParseResult {
  events: ParsedMuseEvent[];
  markers: ParsedMuseMarker[];
  headerFrames: number;
  invalidLines: number;
  truncatedTail: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asStream(value: unknown): MuseStream | null {
  if (!isRecord(value)) return null;
  if (typeof value.kind !== "string" || typeof value.id !== "string") return null;
  return { kind: value.kind, id: value.id };
}

// Marker lines carry omission evidence, never a sequence number.
function tryParseMarker(
  parsed: Record<string, unknown>,
  afterSequence: number | null,
): ParsedMuseMarker | null {
  if (!("retained_marker" in parsed || "omitted_record" in parsed || "omission_class" in parsed)) {
    return null;
  }
  const stream = asStream(parsed.stream);
  if (!stream) return null;
  const omissionClass =
    typeof parsed.omission_class === "string"
      ? parsed.omission_class
      : isRecord(parsed.omitted_record) && typeof parsed.omitted_record.omission_class === "string"
        ? parsed.omitted_record.omission_class
        : null;
  return { stream, omissionClass, afterSequence, raw: parsed };
}

function tryParseEvent(parsed: Record<string, unknown>): ParsedMuseEvent | null {
  const stream = asStream(parsed.stream);
  if (!stream) return null;
  if (typeof parsed.sequence !== "number" || !Number.isInteger(parsed.sequence)) return null;
  if (typeof parsed.payload_type !== "string") return null;
  if (typeof parsed.id !== "string") return null;
  // recorded_at is microseconds in live logs, but fork/side-channel lines
  // omit it. Preserve the event with a null timestamp instead of dropping
  // lineage evidence; the mapper substitutes observed_at and diagnoses it.
  const recordedAtUs =
    typeof parsed.recorded_at === "number" && Number.isFinite(parsed.recorded_at)
      ? parsed.recorded_at
      : null;
  return {
    id: parsed.id,
    stream,
    sequence: parsed.sequence,
    recordedAtUs,
    payloadType: parsed.payload_type,
    payload: parsed.payload ?? null,
    causationId: typeof parsed.causation_id === "string" ? parsed.causation_id : null,
    durability: typeof parsed.durability === "string" ? parsed.durability : null,
  };
}

export function parseMuseLines(lines: string[]): ParseResult {
  const result: ParseResult = {
    events: [],
    markers: [],
    headerFrames: 0,
    invalidLines: 0,
    truncatedTail: false,
  };
  let lastSequence: number | null = null;
  for (const line of lines) {
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      result.invalidLines++;
      continue;
    }
    if (!isRecord(parsed)) {
      result.invalidLines++;
      continue;
    }
    // Marker check runs before the header check: live compaction markers
    // carry stream + position (no top-level sequence), so a
    // stream/sequence presence test would misfile them as header frames.
    const marker = tryParseMarker(parsed, lastSequence);
    if (marker) {
      result.markers.push(marker);
      continue;
    }
    // Header frame: no stream/sequence, carries embedded records.
    if (!("stream" in parsed) || !("sequence" in parsed)) {
      result.headerFrames++;
      continue;
    }
    const event = tryParseEvent(parsed);
    if (!event) {
      result.invalidLines++;
      continue;
    }
    result.events.push(event);
    lastSequence = event.sequence;
  }
  result.events.sort((a, b) => a.sequence - b.sequence);
  return result;
}

// Splitter keeps the trailing-partial rule in one place: a final line
// without a newline is a torn write, not evidence.
export function parseMuseContent(content: string): ParseResult {
  const endsWithNewline = content === "" || content.endsWith("\n");
  const lines = content.split("\n");
  const tail = lines.pop() ?? "";
  const result = parseMuseLines(lines);
  if (tail !== "") {
    result.truncatedTail = !endsWithNewline;
    if (!endsWithNewline) return result;
    const extra = parseMuseLines([tail]);
    result.events.push(...extra.events);
    result.markers.push(...extra.markers);
    result.headerFrames += extra.headerFrames;
    result.invalidLines += extra.invalidLines;
    result.events.sort((a, b) => a.sequence - b.sequence);
  }
  return result;
}

export interface SequenceGap {
  fromSequence: number;
  toSequence: number;
}

// A jump is compaction only when a marker sits between its endpoints in file
// order; any other jump is a genuine gap. Markers before the first event
// (afterSequence null) explain nothing.
export function detectSequenceGaps(
  sequences: number[],
  markers: ParsedMuseMarker[],
): SequenceGap[] {
  const gaps: SequenceGap[] = [];
  const sorted = [...new Set(sequences)].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev === undefined || curr === undefined || curr <= prev + 1) continue;
    const explained = markers.some(
      (marker) =>
        marker.afterSequence !== null &&
        marker.afterSequence >= prev &&
        marker.afterSequence < curr,
    );
    if (!explained) gaps.push({ fromSequence: prev, toSequence: curr });
  }
  return gaps;
}
