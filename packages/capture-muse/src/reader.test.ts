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

  it("detects live compaction markers with position instead of sequence", () => {
    const lines = [
      JSON.stringify({ retained_frame: "session_permission_transaction" }),
      baseEnvelope({ sequence: 95 }),
      // Real marker shape observed Oct 27: stream + position, no top-level sequence.
      JSON.stringify({
        retained_marker: "retained",
        schema_version: 1,
        stream: { kind: "session", id: "ses_parent" },
        position: { id: "01a17d7f-7bdf-7260-b80d-b2e8afead03", sequence: 96 },
        omitted_record: {
          record_type: "event",
          durability: "durable",
          payload_type: "runtime.session",
          payload_schema_version: 1,
          payload_kind: "object",
          omission_class: "checkpoint_trim",
        },
      }),
      baseEnvelope({ sequence: 98, id: "00000000-0000-4000-8000-000000000003" }),
    ];
    const parsed = parseMuseLines(lines);
    expect(parsed.headerFrames).toBe(1);
    expect(parsed.markers).toHaveLength(1);
    expect(parsed.markers[0]?.omissionClass).toBe("checkpoint_trim");
    expect(parsed.markers[0]?.afterSequence).toBe(95);
    expect(parsed.events.map((event) => event.sequence)).toEqual([95, 98]);
    expect(detectSequenceGaps([95, 98], parsed.markers)).toEqual([]);
  });

  it("preserves fork lines without recorded_at instead of dropping them", () => {
    const record: Record<string, unknown> = {
      schema_version: 1,
      id: "00000000-0000-4000-8000-000000000010",
      stream: { kind: "session", id: "ses_parent" },
      sequence: 1,
      record_type: "event",
      durability: "durable",
      payload_type: "session.fork.created",
      payload_schema_version: 1,
      payload: { fork_session_id: "ses_fork", source_session_id: "ses_parent" },
    };
    const parsed = parseMuseLines([line(record)]);
    expect(parsed.invalidLines).toBe(0);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.recordedAtUs).toBeNull();
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
