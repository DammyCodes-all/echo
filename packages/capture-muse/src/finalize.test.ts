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
});
