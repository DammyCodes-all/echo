import { describe, expect, it } from "vitest";
import { buildTapeEvent, emptyLinks, MAX_PAYLOAD_BYTES, mapMuseToTape } from "./map";
import { parseMuseLines } from "./reader";

const CTX = {
  sessionId: "ses_parent",
  projectId: "prj_test",
  build: "Muse Code 1.4.13 (1.4.13-R6996.1)",
  observedAt: new Date("2026-10-27T10:00:00.000Z"),
};

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function envelope(seq: number, id: string, payloadType: string, payload: unknown): string {
  return line({
    schema_version: 1,
    id,
    stream: { kind: "session", id: "ses_parent" },
    sequence: seq,
    recorded_at: 1793097343000000 + seq * 1000,
    record_type: "event",
    durability: "durable",
    causation_id: null,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  });
}

describe("mapMuseToTape", () => {
  it("maps prompt, tool call and result into canonical kinds with stable ids", () => {
    const parsed = parseMuseLines([
      envelope(3, "id-3", "runtime.user_intent.accepted", { kind: "accepted", model_messages: [] }),
      envelope(4, "id-4", "runtime.session", {
        kind: "assistant_tool_calls_committed",
        message_id: "m1",
        tool_calls: [{ id: "c1", call_id: "tool_1", name: "read", args: '{"path":"README.md"}' }],
      }),
      envelope(5, "id-5", "runtime.session", {
        kind: "tool_result_batch_committed",
        batch_id: "b1",
        results: [{ tool_call_id: "tool_1", text: "hello" }],
      }),
    ]);
    const first = mapMuseToTape(parsed.events, parsed.markers, parsed.invalidLines, CTX);
    expect(first.quality).toBe("full");
    expect(first.events.map((event) => event.kind)).toEqual([
      "prompt.submitted",
      "tool.requested",
      "tool.completed",
    ]);
    expect(first.events[1]?.links.tool_call_id).toBe("tool_1");
    expect(first.events[0]?.record_key).toBe("muse:ses_parent:ses_parent:3");

    const second = mapMuseToTape(parsed.events, parsed.markers, parsed.invalidLines, CTX);
    expect(second.events.map((event) => event.event_id)).toEqual(
      first.events.map((event) => event.event_id),
    );
  });

  it("redacts secrets before storage and counts findings", () => {
    const parsed = parseMuseLines([
      envelope(6, "id-6", "runtime.user_intent.accepted", {
        kind: "accepted",
        text: "deploy with METAROUTER_TOKEN=paste-of-32-chars-xxxxx now",
      }),
    ]);
    const result = mapMuseToTape(parsed.events, parsed.markers, parsed.invalidLines, CTX);
    expect(JSON.stringify(result.events[0]?.payload)).not.toContain("paste-of-32-chars-xxxxx");
    expect(result.events[0]?.redaction.findings).toBe(1);
  });

  it("preserves unknown payloads and marks markers and invalid lines as diagnostics", () => {
    const parsed = parseMuseLines([
      envelope(7, "id-7", "runtime.brand_new_type", { kind: "future_kind", data: 1 }),
      line({
        schema_version: 1,
        id: "marker-1",
        stream: { kind: "session", id: "ses_parent" },
        sequence: 8,
        recorded_at: 1793097343008000,
        record_type: "event",
        durability: "durable",
        causation_id: null,
        payload_type: "retained_marker",
        payload_schema_version: 1,
        payload: {},
        retained_marker: true,
        omission_class: "checkpoint_trim",
      }),
      "broken",
    ]);
    const result = mapMuseToTape(parsed.events, parsed.markers, parsed.invalidLines, CTX);
    expect(result.quality).toBe("partial");
    expect(result.events.map((event) => event.kind)).toEqual([
      "agent.unknown",
      "capture.compaction",
      "capture.gap",
    ]);
    expect(result.events[0]?.diagnostics).toContain("unknown_payload_type");
  });

  it("links child streams without flattening them into parent actions", () => {
    const parsed = parseMuseLines([
      line({
        schema_version: 1,
        id: "child-1",
        stream: { kind: "session", id: "ses_child" },
        sequence: 3,
        recorded_at: 1793097343000000,
        record_type: "event",
        durability: "durable",
        causation_id: null,
        payload_type: "runtime.session",
        payload_schema_version: 1,
        payload: { kind: "completed", task_id: "t9" },
      }),
    ]);
    const result = mapMuseToTape(parsed.events, parsed.markers, parsed.invalidLines, CTX);
    expect(result.events[0]?.links.subagent_id).toBe("ses_child");
    expect(result.events[0]?.links.parent_session_id).toBe("ses_parent");
  });

  it("maps session lifecycle lines instead of preserving them as unknown", () => {
    const parsed = parseMuseLines([
      envelope(3, "id-3", "session.started", {}),
      envelope(4, "id-4", "session.end", { exit_reason: "done" }),
    ]);
    const result = mapMuseToTape(parsed.events, parsed.markers, parsed.invalidLines, CTX);
    expect(result.events.map((event) => event.kind)).toEqual(["session.started", "session.ended"]);
  });

  it("keeps fork lines without recorded_at with an observed_at fallback", () => {
    const parsed = parseMuseLines([
      line({
        schema_version: 1,
        id: "fork-1",
        stream: { kind: "session", id: "ses_parent" },
        sequence: 1,
        record_type: "event",
        durability: "durable",
        causation_id: null,
        payload_type: "session.fork.created",
        payload_schema_version: 1,
        payload: { fork_session_id: "ses_fork", source_session_id: "ses_parent" },
      }),
    ]);
    expect(parsed.invalidLines).toBe(0);
    const result = mapMuseToTape(parsed.events, parsed.markers, parsed.invalidLines, CTX);
    expect(result.events[0]?.kind).toBe("session.started");
    expect(result.events[0]?.ts).toBe("2026-10-27T10:00:00.000Z");
    expect(result.events[0]?.diagnostics).toContain("missing_source_timestamp");
    expect(result.quality).toBe("partial");
  });

  it("strips encrypted payloads but keeps readable reasoning text", () => {
    const parsed = parseMuseLines([
      envelope(3, "id-3", "runtime.session", {
        kind: "reasoning_committed",
        message_id: "m1",
        text: "I will read the file first",
        encrypted_content: "opaque-bytes-that-must-not-land",
        nested: { inner: "keep me", encrypted_blob: "more-opaque-bytes" },
      }),
    ]);
    const result = mapMuseToTape(parsed.events, parsed.markers, parsed.invalidLines, CTX);
    const raw = JSON.stringify(result.events);
    expect(raw).toContain("I will read the file first");
    expect(raw).toContain("keep me");
    expect(raw).not.toContain("opaque-bytes-that-must-not-land");
    expect(raw).not.toContain("more-opaque-bytes");
    // No "encrypted_*": <key> pairs may survive anywhere in the event.
    expect(raw).not.toContain('"encrypted_content":');
    expect(raw).not.toContain('"encrypted_blob":');
    expect(result.events[0]?.diagnostics).toContain("encrypted_content_removed");
  });

  it("adds no stripping diagnostic when nothing is encrypted", () => {
    const parsed = parseMuseLines([
      envelope(3, "id-3", "runtime.session", {
        kind: "reasoning_committed",
        message_id: "m1",
        text: "plain reasoning",
      }),
    ]);
    const result = mapMuseToTape(parsed.events, parsed.markers, parsed.invalidLines, CTX);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.diagnostics).not.toContain("encrypted_content_removed");
  });

  it("replaces oversized payloads with a content-free marker", () => {
    const big = "x".repeat(MAX_PAYLOAD_BYTES + 1);
    const { event } = buildTapeEvent({
      kind: "tool.completed",
      payload: { kind: "completed", text: big },
      payloadType: "runtime.session",
      recordType: "event",
      sequence: 3,
      ts: "2026-10-28T10:00:00.000Z",
      recordKey: "muse:ses_parent:ses_parent:3",
      links: emptyLinks(),
      diagnostics: [],
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: null,
      observedAt: "2026-10-28T10:00:00.050Z",
      tapeSeq: 0,
    });
    expect(JSON.stringify(event.payload)).not.toContain(big);
    expect(event.payload).toMatchObject({ truncated: true });
    expect(event.diagnostics).toContain("truncation");
    // Deterministic: the same oversized input hashes to the same id.
    const again = buildTapeEvent({
      kind: "tool.completed",
      payload: { kind: "completed", text: big },
      payloadType: "runtime.session",
      recordType: "event",
      sequence: 3,
      ts: "2026-10-28T10:00:00.000Z",
      recordKey: "muse:ses_parent:ses_parent:3",
      links: emptyLinks(),
      diagnostics: [],
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: null,
      observedAt: "2026-10-28T10:00:00.050Z",
      tapeSeq: 0,
    });
    expect(again.event.event_id).toBe(event.event_id);
  });

  it("leaves payloads under the cap untouched", () => {
    const { event } = buildTapeEvent({
      kind: "tool.completed",
      payload: { kind: "completed", text: "small" },
      payloadType: "runtime.session",
      recordType: "event",
      sequence: 3,
      ts: "2026-10-28T10:00:00.000Z",
      recordKey: "muse:ses_parent:ses_parent:3",
      links: emptyLinks(),
      diagnostics: [],
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: null,
      observedAt: "2026-10-28T10:00:00.050Z",
      tapeSeq: 0,
    });
    expect(event.payload).toEqual({ kind: "completed", text: "small" });
    expect(event.diagnostics).not.toContain("truncation");
  });
});

describe("prompt mapping from observed shapes", () => {
  it("extracts prompt text from model_messages with a refill fallback", () => {
    const parsed = parseMuseLines([
      envelope(3, "id-3", "runtime.user_intent.accepted", {
        kind: "accepted",
        intent_id: "intent-1",
        model_messages: [{ content: [{ kind: "text", text: "Do the thing" }] }],
        refill_blocks: [{ kind: "text", text: "Do the thing" }],
      }),
      envelope(4, "id-4", "runtime.user_intent.accepted", {
        kind: "accepted",
        intent_id: "intent-2",
        model_messages: [],
        refill_blocks: [{ kind: "text", text: "Refilled prompt" }],
      }),
    ]);
    const result = mapMuseToTape(parsed.events, parsed.markers, parsed.invalidLines, CTX);
    expect(result.events.map((event) => event.kind)).toEqual([
      "prompt.submitted",
      "prompt.submitted",
    ]);
    const [first, second] = result.events;
    if (!first || !second) throw new Error("events missing");
    expect((first.payload as { text: string }).text).toBe("Do the thing");
    expect((second.payload as { text: string }).text).toBe("Refilled prompt");
  });

  it("maps the textless materialized twin and intake metadata off prompt.submitted", () => {
    const parsed = parseMuseLines([
      envelope(5, "id-5", "runtime.user_intent.materialized", {
        intent_id: "intent-1",
        outcome: "ok",
      }),
      envelope(2, "id-2", "runtime.command_intake.received", {
        kind: "command_intake",
        record: { kind: "received", command: { kind: "session_start" } },
      }),
    ]);
    const result = mapMuseToTape(parsed.events, parsed.markers, parsed.invalidLines, CTX);
    expect(result.events.map((event) => event.kind)).toEqual(["session.started", "notification"]);
  });
});
