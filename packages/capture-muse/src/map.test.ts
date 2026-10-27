import { describe, expect, it } from "vitest";
import { mapMuseToTape } from "./map";
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
});
