import { describe, expect, it } from "vitest";
import { detectSequenceGaps, parseMuseContent, parseMuseLines } from "./reader";

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function baseEnvelope(overrides: Record<string, unknown>): string {
  return line({
    schema_version: 1,
    id: "00000000-0000-4000-8000-000000000000",
    stream: { kind: "session", id: "ses_parent" },
    sequence: 3,
    recorded_at: 1793097343000000,
    record_type: "event",
    durability: "durable",
    causation_id: null,
    payload_type: "runtime.session",
    payload_schema_version: 1,
    payload: { kind: "scheduled", task_id: "t1" },
    ...overrides,
  });
}

describe("parseMuseLines", () => {
  it("counts header frames, events, markers and invalid lines", () => {
    const lines = [
      JSON.stringify({ frame: 1, embedded: [] }),
      baseEnvelope({ sequence: 3 }),
      baseEnvelope({
        sequence: 4,
        id: "00000000-0000-4000-8000-000000000001",
        payload_type: "retained_marker",
        payload: {},
        retained_marker: true,
        stream: { kind: "session", id: "ses_parent" },
        omission_class: "checkpoint_trim",
      }),
      "not json",
      baseEnvelope({
        sequence: 5,
        id: "00000000-0000-4000-8000-000000000002",
        payload_type: "runtime.user_intent.accepted",
        payload: { kind: "accepted", model_messages: [] },
      }),
    ];
    const parsed = parseMuseLines(lines);
    expect(parsed.headerFrames).toBe(1);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.markers).toHaveLength(1);
    expect(parsed.markers[0]?.omissionClass).toBe("checkpoint_trim");
    expect(parsed.markers[0]?.afterSequence).toBe(3);
    expect(parsed.invalidLines).toBe(1);
    expect(parsed.events.map((event) => event.sequence)).toEqual([3, 5]);
  });

  it("treats a trailing partial line as torn, not evidence", () => {
    const full = `${baseEnvelope({ sequence: 3 })}\n${baseEnvelope({
      sequence: 4,
      id: "00000000-0000-4000-8000-000000000001",
    })}\n`;
    const parsedFull = parseMuseContent(full);
    expect(parsedFull.truncatedTail).toBe(false);
    expect(parsedFull.events).toHaveLength(2);

    const torn = `${baseEnvelope({ sequence: 3 })}\n{"schema_version":1,"stream"`;
    const parsedTorn = parseMuseContent(torn);
    expect(parsedTorn.truncatedTail).toBe(true);
    expect(parsedTorn.events).toHaveLength(1);
    expect(parsedTorn.invalidLines).toBe(0);
  });
});

describe("detectSequenceGaps", () => {
  const marker = (afterSequence: number | null) => ({
    stream: { kind: "session", id: "ses_parent" },
    omissionClass: "checkpoint_trim",
    afterSequence,
    raw: {},
  });
  it("returns jumps with no marker between their endpoints", () => {
    expect(detectSequenceGaps([3, 4, 7], [])).toEqual([{ fromSequence: 4, toSequence: 7 }]);
    expect(detectSequenceGaps([3, 3, 4], [])).toEqual([]);
  });
  it("suppresses only jumps the marker sits inside", () => {
    expect(detectSequenceGaps([3, 4, 7], [marker(4)])).toEqual([]);
    expect(detectSequenceGaps([3, 4, 7, 12], [marker(4)])).toEqual([
      { fromSequence: 7, toSequence: 12 },
    ]);
    expect(detectSequenceGaps([3, 4, 7], [marker(null)])).toEqual([
      { fromSequence: 4, toSequence: 7 },
    ]);
  });
});
