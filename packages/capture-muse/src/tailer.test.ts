import { describe, expect, it } from "vitest";
import { finalizeMuseSession } from "./finalize";
import { isoFromUs } from "./map";
import { freshLaneCursor, MAX_TAIL_LINE_BYTES, tailChunk } from "./tailer";

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function envelope(seq: number, id: string, extra: Record<string, unknown> = {}): string {
  return line({
    schema_version: 1,
    id,
    stream: { kind: "session", id: "ses_parent" },
    sequence: seq,
    recorded_at: 1793097343000000 + seq * 1000,
    record_type: "event",
    durability: "durable",
    causation_id: null,
    payload_type: "runtime.user_intent.accepted",
    payload_schema_version: 1,
    payload: { kind: "accepted", task_id: "t1" },
    ...extra,
  });
}

function marker(afterHint: string, seq: number): string {
  return line({
    schema_version: 1,
    id: afterHint,
    stream: { kind: "session", id: "ses_parent" },
    sequence: seq,
    recorded_at: 1793097343000000 + seq * 1000,
    record_type: "event",
    durability: "durable",
    causation_id: null,
    payload_type: "retained_marker",
    payload_schema_version: 1,
    payload: {},
    retained_marker: true,
    omission_class: "checkpoint_trim",
  });
}

const BASE = {
  sessionId: "ses_parent",
  projectId: "prj_test",
  build: null as string | null,
  lane: "",
  observedAt: new Date("2026-10-28T10:00:00.000Z"),
};

describe("tailChunk", () => {
  it("parses a chunk and advances the cursor", () => {
    const chunk = `${envelope(3, "id-3")}\n${envelope(4, "id-4")}\n`;
    const result = tailChunk({ ...BASE, chunk, baseOffset: 0, cursor: freshLaneCursor() });
    expect(result.events.map((event) => event.record_key)).toEqual([
      "muse:ses_parent:ses_parent:3",
      "muse:ses_parent:ses_parent:4",
    ]);
    expect(result.quality).toBe("full");
    expect(result.diagnostics).toEqual([]);
    expect(result.next.lastSequence).toBe(4);
    expect(result.next.lastEventTs).toBe(isoFromUs(1793097343000000 + 4 * 1000));
    expect(result.next.markerCount).toBe(0);
    expect(result.next.sessionStarted).toBe(false);
    expect(result.consumedBytes).toBe(Buffer.byteLength(chunk, "utf8"));
    expect(result.hasNew).toBe(true);
    expect(result.truncatedTail).toBe(false);
    expect(result.schemaVersion).toBe(1);
    expect(result.nonMonotonic).toBe(false);
  });

  it("matches a full finalize for appends across chunks", () => {
    const first = `${envelope(3, "id-3")}\n${envelope(4, "id-4")}\n`;
    const second = `${envelope(5, "id-5")}\n`;
    const one = tailChunk({ ...BASE, chunk: first, baseOffset: 0, cursor: freshLaneCursor() });
    const two = tailChunk({
      ...BASE,
      chunk: second,
      baseOffset: one.consumedBytes,
      cursor: one.next,
    });
    expect(two.events.map((event) => event.record_key)).toEqual(["muse:ses_parent:ses_parent:5"]);
    const full = finalizeMuseSession({
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: null,
      liveContent: `${first}${second}`,
    });
    expect([...one.events, ...two.events].map((event) => event.event_id)).toEqual(
      full.events.map((event) => event.event_id),
    );
  });

  it("emits a boundary gap byte-identical to a full finalize", () => {
    const first = `${envelope(3, "id-3")}\n${envelope(4, "id-4")}\n`;
    const second = `${envelope(7, "id-7")}\n`;
    const one = tailChunk({ ...BASE, chunk: first, baseOffset: 0, cursor: freshLaneCursor() });
    const two = tailChunk({
      ...BASE,
      chunk: second,
      baseOffset: one.consumedBytes,
      cursor: one.next,
    });
    const gaps = two.events.filter((event) => event.kind === "capture.gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.record_key).toBe("muse:ses_parent:gap:ses_parent:4-7");
    expect(gaps[0]?.payload).toEqual({
      code: "sequence_jump",
      stream_id: "ses_parent",
      from_sequence: 4,
      to_sequence: 7,
    });
    expect(two.quality).toBe("partial");
    expect(two.diagnostics).toContain("sequence_jump");
    const full = finalizeMuseSession({
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: null,
      liveContent: `${first}${second}`,
    });
    const fullGap = full.events.find((event) => event.kind === "capture.gap");
    expect(gaps[0]?.event_id).toBe(fullGap?.event_id);
  });

  it("lets a persisted trailing marker explain the boundary jump", () => {
    const first = `${envelope(3, "id-3")}\n${envelope(4, "id-4")}\n${marker("m-1", 5)}\n`;
    const second = `${envelope(9, "id-9")}\n`;
    const one = tailChunk({ ...BASE, chunk: first, baseOffset: 0, cursor: freshLaneCursor() });
    expect(one.next.trailingMarkerAfter).toBe(4);
    const two = tailChunk({
      ...BASE,
      chunk: second,
      baseOffset: one.consumedBytes,
      cursor: one.next,
    });
    expect(two.events.filter((event) => event.kind === "capture.gap")).toHaveLength(0);
  });

  it("inherits the cursor into chunk-leading markers", () => {
    const first = `${envelope(3, "id-3")}\n${envelope(4, "id-4")}\n`;
    const second = `${marker("m-1", 5)}\n${envelope(9, "id-9")}\n`;
    const one = tailChunk({ ...BASE, chunk: first, baseOffset: 0, cursor: freshLaneCursor() });
    const two = tailChunk({
      ...BASE,
      chunk: second,
      baseOffset: one.consumedBytes,
      cursor: one.next,
    });
    expect(two.events.filter((event) => event.kind === "capture.gap")).toHaveLength(0);
    expect(two.events.some((event) => event.kind === "capture.compaction")).toBe(true);
  });

  it("continues marker indices across chunks", () => {
    const one = tailChunk({
      ...BASE,
      chunk: `${marker("m-1", 5)}\n`,
      baseOffset: 0,
      cursor: freshLaneCursor(),
    });
    const two = tailChunk({
      ...BASE,
      chunk: `${marker("m-2", 6)}\n`,
      baseOffset: one.consumedBytes,
      cursor: one.next,
    });
    expect(one.events[0]?.record_key).toBe("muse:ses_parent:marker:0");
    expect(two.events[0]?.record_key).toBe("muse:ses_parent:marker:1");
  });

  it("scopes child-lane markers per lane", () => {
    const result = tailChunk({
      ...BASE,
      lane: "child-9",
      chunk: `${marker("m-1", 5)}\n`,
      baseOffset: 0,
      cursor: freshLaneCursor(),
    });
    expect(result.events[0]?.record_key).toBe("muse:ses_parent:marker:child-9:0");
  });

  it("holds a torn tail for the next poll", () => {
    const fullLine = `${envelope(3, "id-3")}\n`;
    const partial = `${envelope(4, "id-4")}`.slice(0, 20);
    const one = tailChunk({
      ...BASE,
      chunk: `${fullLine}${partial}`,
      baseOffset: 0,
      cursor: freshLaneCursor(),
    });
    expect(one.events).toHaveLength(1);
    expect(one.truncatedTail).toBe(true);
    expect(one.diagnostics).toContain("truncated_tail");
    expect(one.consumedBytes).toBe(Buffer.byteLength(fullLine, "utf8"));
    // The next poll re-reads from the persisted offset, so it sees the
    // completed line once the writer finishes it.
    const two = tailChunk({
      ...BASE,
      chunk: `${envelope(4, "id-4")}\n`,
      baseOffset: one.consumedBytes,
      cursor: one.next,
    });
    expect(two.events.map((event) => event.record_key)).toEqual(["muse:ses_parent:ses_parent:4"]);
  });

  it("skips oversized lines with an offset-keyed truncation gap", () => {
    const big = `{"oversized": "${"x".repeat(MAX_TAIL_LINE_BYTES + 1)}"}\n`;
    const chunk = `${envelope(3, "id-3")}\n${big}${envelope(4, "id-4")}\n`;
    const result = tailChunk({ ...BASE, chunk, baseOffset: 100, cursor: freshLaneCursor() });
    expect(result.oversizedLines).toBe(1);
    const gaps = result.events.filter((event) => event.kind === "capture.gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.payload).toMatchObject({ code: "truncation" });
    expect(gaps[0]?.record_key?.startsWith("muse:ses_parent:gap:truncation:")).toBe(true);
    expect(result.quality).toBe("partial");
    // The skip is consumed: a retry at the same offset dedupes by recordKey.
    const again = tailChunk({ ...BASE, chunk, baseOffset: 100, cursor: freshLaneCursor() });
    expect(again.events.map((event) => event.event_id)).toEqual(
      result.events.map((event) => event.event_id),
    );
  });

  it("keys invalid-line gaps per chunk offset", () => {
    const one = tailChunk({
      ...BASE,
      chunk: "broken\n",
      baseOffset: 0,
      cursor: freshLaneCursor(),
    });
    expect(one.invalidLines).toBe(1);
    expect(one.events[0]?.record_key).toBe("muse:ses_parent:gap:parse-invalid:0");
    const two = tailChunk({
      ...BASE,
      chunk: "broken\n",
      baseOffset: 7,
      cursor: one.next,
    });
    expect(two.events[0]?.record_key).toBe("muse:ses_parent:gap:parse-invalid:7");
  });

  it("keys invalid-line gaps by absolute line offset, not chunk start", () => {
    // The key tracks the offending line's absolute offset: a chunk split
    // anywhere before it still yields a key anchored at the line itself.
    const head = `${envelope(3, "id-3")}\n`;
    const at = (baseOffset: number) =>
      tailChunk({
        ...BASE,
        chunk: `${head}broken\n`,
        baseOffset,
        cursor: freshLaneCursor(),
      });
    const gapKey = (result: ReturnType<typeof tailChunk>): string | undefined =>
      result.events.find((event) => event.kind === "capture.gap")?.record_key ?? undefined;
    const expected = `muse:ses_parent:gap:parse-invalid:${100 + Buffer.byteLength(head, "utf8")}`;
    expect(gapKey(at(100))).toBe(expected);
    expect(gapKey(at(5000))).toBe(
      `muse:ses_parent:gap:parse-invalid:${5000 + Buffer.byteLength(head, "utf8")}`,
    );
  });

  it("emits session.started only once across chunks", () => {
    const started = (seq: number, id: string): string =>
      line({
        schema_version: 1,
        id,
        stream: { kind: "session", id: "ses_parent" },
        sequence: seq,
        recorded_at: 1793097343000000 + seq * 1000,
        record_type: "event",
        durability: "durable",
        causation_id: null,
        payload_type: "session.opened.observed",
        payload_schema_version: 1,
        payload: { kind: "opened" },
      });
    const one = tailChunk({
      ...BASE,
      chunk: `${started(3, "id-3")}\n`,
      baseOffset: 0,
      cursor: freshLaneCursor(),
    });
    expect(one.events[0]?.kind).toBe("session.started");
    const two = tailChunk({
      ...BASE,
      chunk: `${started(4, "id-4")}\n`,
      baseOffset: one.consumedBytes,
      cursor: one.next,
    });
    expect(two.events[0]?.kind).not.toBe("session.started");
    expect(two.next.sessionStarted).toBe(true);
  });

  it("flags non-monotonic rewrites for a reset", () => {
    const one = tailChunk({
      ...BASE,
      chunk: `${envelope(3, "id-3")}\n${envelope(4, "id-4")}\n`,
      baseOffset: 0,
      cursor: freshLaneCursor(),
    });
    const two = tailChunk({
      ...BASE,
      chunk: `${envelope(3, "id-3b")}\n`,
      baseOffset: one.consumedBytes,
      cursor: one.next,
    });
    expect(two.nonMonotonic).toBe(true);
  });

  it("reports referenced children for missing-child handling", () => {
    const link = line({
      schema_version: 1,
      id: "link-1",
      stream: { kind: "session", id: "ses_parent" },
      sequence: 4,
      recorded_at: 1793097343004000,
      record_type: "event",
      durability: "durable",
      causation_id: null,
      payload_type: "runtime.session",
      payload_schema_version: 1,
      payload: {
        kind: "memory_reminder_child_session_linked",
        child_session_id: "child-9",
        parent_session_id: "ses_parent",
      },
    });
    const result = tailChunk({
      ...BASE,
      chunk: `${link}\n`,
      baseOffset: 0,
      cursor: freshLaneCursor(),
    });
    expect(result.referencedChildIds.get("child-9")).toBe(1793097343004000);
  });
});
