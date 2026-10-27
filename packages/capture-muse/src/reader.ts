export interface MuseStream {
  kind: string;
  id: string;
}

export interface ParsedMuseEvent {
  id: string;
  stream: MuseStream;
  sequence: number;
  recordedAtUs: number;
  payloadType: string;
  payload: unknown;
  causationId: string | null;
  durability: string | null;
}

export interface ParsedMuseMarker {
  stream: MuseStream;
  omissionClass: string | null;
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
function tryParseMarker(parsed: Record<string, unknown>): ParsedMuseMarker | null {
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
  return { stream, omissionClass, raw: parsed };
}

function tryParseEvent(parsed: Record<string, unknown>): ParsedMuseEvent | null {
  const stream = asStream(parsed.stream);
  if (!stream) return null;
  if (typeof parsed.sequence !== "number" || !Number.isInteger(parsed.sequence)) return null;
  if (typeof parsed.recorded_at !== "number" || !Number.isFinite(parsed.recorded_at)) return null;
  if (typeof parsed.payload_type !== "string") return null;
  if (typeof parsed.id !== "string") return null;
  return {
    id: parsed.id,
    stream,
    sequence: parsed.sequence,
    recordedAtUs: parsed.recorded_at,
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
    // Header frame: no stream/sequence, carries embedded records.
    if (!("stream" in parsed) || !("sequence" in parsed)) {
      result.headerFrames++;
      continue;
    }
    const marker = tryParseMarker(parsed);
    if (marker) {
      result.markers.push(marker);
      continue;
    }
    const event = tryParseEvent(parsed);
    if (!event) {
      result.invalidLines++;
      continue;
    }
    result.events.push(event);
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

// Marker-adjacent jumps are compaction (expected trimming), not gaps.
// Only marker-less jumps are returned here.
export function detectSequenceGaps(sequences: number[], markerCount: number): SequenceGap[] {
  const gaps: SequenceGap[] = [];
  if (markerCount > 0) return gaps;
  const sorted = [...new Set(sequences)].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev === undefined || curr === undefined) continue;
    if (curr > prev + 1) gaps.push({ fromSequence: prev, toSequence: curr });
  }
  return gaps;
}
