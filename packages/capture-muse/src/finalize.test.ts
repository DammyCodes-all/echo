import { describe, expect, it } from "vitest";
import { finalizeMuseSession } from "./finalize";

function envelope(seq: number, id: string, payloadType: string, payload: unknown): string {
  return JSON.stringify({
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

describe("finalizeMuseSession", () => {
  it("composes reader and map into full-quality events", () => {
    const liveContent = [
      envelope(3, "id-3", "runtime.user_intent.accepted", { kind: "accepted" }),
      envelope(4, "id-4", "runtime.session", {
        kind: "assistant_tool_calls_committed",
        tool_calls: [{ call_id: "tool_1", name: "read" }],
      }),
    ].join("\n");
    const result = finalizeMuseSession({
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: "Muse Code 1.4.13",
      liveContent: `${liveContent}\n`,
    });
    expect(result.quality).toBe("full");
    expect(result.events.map((event) => event.kind)).toEqual([
      "prompt.submitted",
      "tool.requested",
    ]);
  });

  it("marks gaps and export deltas as partial with diagnostics", () => {
    const liveContent = [
      envelope(3, "id-3", "runtime.user_intent.accepted", { kind: "accepted" }),
      envelope(7, "id-7", "runtime.user_intent.accepted", { kind: "accepted" }),
    ].join("\n");
    const result = finalizeMuseSession({
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: null,
      liveContent: `${liveContent}\n`,
      exportDoc: {
        export_schema_version: 1,
        events: [{ kind: "record", envelope: { stream: { id: "ses_parent" }, sequence: 9 } }],
        diagnostics: [],
      },
    });
    expect(result.quality).toBe("partial");
    expect(result.diagnostics.some((entry) => entry.startsWith("export_reconciled"))).toBe(true);
  });

  it("preserves export-only records as agent.unknown with export origin", () => {
    const liveContent = [
      envelope(3, "id-3", "runtime.user_intent.accepted", { kind: "accepted" }),
    ].join("\n");
    const result = finalizeMuseSession({
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: null,
      liveContent: `${liveContent}\n`,
      exportDoc: {
        export_schema_version: 1,
        events: [
          { kind: "record", envelope: { stream: { id: "ses_parent" }, sequence: 3 } },
          { kind: "record", envelope: { stream: { id: "ses_parent" }, sequence: 9 } },
        ],
        diagnostics: [],
      },
    });
    expect(result.quality).toBe("partial");
    const recovered = result.events.filter(
      (event) => event.record_key === "muse:ses_parent:export:ses_parent:9",
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.kind).toBe("agent.unknown");
    expect(recovered[0]?.source.origin).toBe("export");
    expect(recovered[0]?.diagnostics).toContain("export_recovery");
  });

  it("reports the reconcile summary for the daemon marker", () => {
    const liveContent = [
      envelope(3, "id-3", "runtime.user_intent.accepted", { kind: "accepted" }),
    ].join("\n");
    const withoutExport = finalizeMuseSession({
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: null,
      liveContent: `${liveContent}\n`,
    });
    expect(withoutExport.reconciled).toBeNull();
    const withExport = finalizeMuseSession({
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: null,
      liveContent: `${liveContent}\n`,
      exportDoc: {
        export_schema_version: 1,
        events: [
          { kind: "record", envelope: { stream: { id: "ses_parent" }, sequence: 3 } },
          { kind: "record", envelope: { stream: { id: "ses_parent" }, sequence: 9 } },
        ],
        diagnostics: [],
      },
    });
    expect(withExport.reconciled).toEqual({ added: 1, merged: 1, schemaVersion: 1 });
  });

  it("emits a deterministic capture.gap for non-marker-adjacent sequence jumps", () => {
    const liveContent = [
      envelope(3, "id-3", "runtime.user_intent.accepted", { kind: "accepted" }),
      envelope(4, "id-4", "runtime.user_intent.accepted", { kind: "accepted" }),
      envelope(9, "id-9", "runtime.user_intent.accepted", { kind: "accepted" }),
    ].join("\n");
    const args = {
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: null as string | null,
      liveContent: `${liveContent}\n`,
    };
    const first = finalizeMuseSession(args);
    const gaps = first.events.filter((event) => event.kind === "capture.gap");
    expect(first.quality).toBe("partial");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.payload).toEqual({
      code: "sequence_jump",
      stream_id: "ses_parent",
      from_sequence: 4,
      to_sequence: 9,
    });
    expect(gaps[0]?.record_key).toBe("muse:ses_parent:gap:ses_parent:4-9");
    expect(gaps[0]?.diagnostics).toEqual(["sequence_jump"]);
    const fromEvent = first.events.find(
      (event) => event.record_key === "muse:ses_parent:ses_parent:4",
    );
    expect(gaps[0]?.ts).toBe(fromEvent?.ts);
    const second = finalizeMuseSession(args);
    expect(second.events.map((event) => event.event_id)).toEqual(
      first.events.map((event) => event.event_id),
    );
  });

  it("does not emit gaps for marker-adjacent jumps", () => {
    const marker = JSON.stringify({
      schema_version: 1,
      id: "marker-1",
      stream: { kind: "session", id: "ses_parent" },
      sequence: 5,
      recorded_at: 1793097343005000,
      record_type: "event",
      durability: "durable",
      causation_id: null,
      payload_type: "retained_marker",
      payload_schema_version: 1,
      payload: {},
      retained_marker: true,
      omission_class: "checkpoint_trim",
    });
    const liveContent = [
      envelope(3, "id-3", "runtime.user_intent.accepted", { kind: "accepted" }),
      envelope(4, "id-4", "runtime.user_intent.accepted", { kind: "accepted" }),
      marker,
      envelope(9, "id-9", "runtime.user_intent.accepted", { kind: "accepted" }),
    ].join("\n");
    const result = finalizeMuseSession({
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: null,
      liveContent: `${liveContent}\n`,
    });
    expect(result.events.filter((event) => event.kind === "capture.gap")).toHaveLength(0);
    expect(result.events.some((event) => event.kind === "capture.compaction")).toBe(true);
  });

  it("emits a capture.gap for referenced-but-missing child logs", () => {
    const link = JSON.stringify({
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
    const childLog = JSON.stringify({
      schema_version: 1,
      id: "child-1",
      stream: { kind: "session", id: "other-child" },
      sequence: 3,
      recorded_at: 1793097343003000,
      record_type: "event",
      durability: "durable",
      causation_id: null,
      payload_type: "runtime.session",
      payload_schema_version: 1,
      payload: { kind: "completed", task_id: "t9" },
    });
    const liveContent = [
      envelope(3, "id-3", "runtime.user_intent.accepted", { kind: "accepted" }),
      link,
    ].join("\n");
    const base = {
      sessionId: "ses_parent",
      projectId: "prj_test",
      build: null as string | null,
      liveContent: `${liveContent}\n`,
    };
    const missing = finalizeMuseSession({
      ...base,
      childContents: [{ id: "other-child", content: `${childLog}\n` }],
    });
    const missingGaps = missing.events.filter((event) => event.kind === "capture.gap");
    expect(missingGaps).toHaveLength(1);
    expect(missingGaps[0]?.payload).toEqual({ code: "missing_child", subagent_id: "child-9" });
    expect(missingGaps[0]?.record_key).toBe("muse:ses_parent:gap:missing-child:child-9");
    expect(missingGaps[0]?.links.subagent_id).toBe("child-9");
    expect(missingGaps[0]?.links.parent_session_id).toBe("ses_parent");
    expect(missing.diagnostics).toContain("missing_child:child-9");
    expect(missing.quality).toBe("partial");

    const present = finalizeMuseSession({
      ...base,
      childContents: [{ id: "child-9", content: `${childLog}\n` }],
    });
    expect(present.events.filter((event) => event.kind === "capture.gap")).toHaveLength(0);
  });
});
