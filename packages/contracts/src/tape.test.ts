import { describe, expect, it } from "vitest";
import { ApiErrorSchema, CaptureGapCodeSchema, TapeEnvelopeSchema } from "./index";

function baseEvent(overrides: Record<string, unknown>) {
  return {
    v: 1,
    tape_seq: 0,
    event_id: "01JBASE0000000000000000000",
    session_id: "ses_test",
    project_id: "prj_test",
    ts: "2026-10-27T10:00:00.000Z",
    observed_at: "2026-10-27T10:00:00.050Z",
    redaction: { version: "r1", findings: 0 },
    diagnostics: [],
    ...overrides,
  };
}

describe("TapeEnvelopeSchema against observed agent schemas", () => {
  it("accepts an event derived from a Muse 1.4.13 native record", () => {
    const parsed = TapeEnvelopeSchema.parse(
      baseEvent({
        kind: "agent.unknown",
        source: {
          agent: "muse",
          adapter: "muse-native",
          adapter_version: "0.1.0",
          build: "Muse Code 1.4.13 (1.4.13-R6996.1)",
          schema: "session-jsonl/frame1",
          record_type: "event",
          payload_type: "runtime.brand_new_type",
          sequence: 128,
          durability: "durable",
          origin: "live",
        },
        links: { snapshot: null },
        payload: { preserved: "redacted-unknown-payload" },
        diagnostics: ["unknown_payload_type"],
      }),
    );
    expect(parsed.source.payload_type).toBe("runtime.brand_new_type");
    expect(parsed.diagnostics).toContain("unknown_payload_type");
  });

  it("accepts an OpenCode assistant message with git-oid snapshot and readable reasoning", () => {
    const parsed = TapeEnvelopeSchema.parse(
      baseEvent({
        kind: "model.response",
        source: {
          agent: "opencode",
          adapter: "opencode-sqlite",
          adapter_version: "0.1.0",
          build: "opencode v2.1.4",
          schema: "opencode.db/2.1.4",
          record_type: "assistant",
          payload_type: null,
          sequence: 6,
          durability: null,
          origin: "import",
        },
        links: {
          snapshot: {
            kind: "git_oids",
            start_oid: "853694aae8816094a0d875fee7ea26278dbf5d0f",
            end_oid: null,
          },
        },
        payload: {
          parts: [
            { type: "reasoning", text: "<redacted>", native: true },
            { type: "tool", name: "read", state: { status: "completed" } },
          ],
        },
      }),
    );
    expect(parsed.links.snapshot).toEqual({
      kind: "git_oids",
      start_oid: "853694aae8816094a0d875fee7ea26278dbf5d0f",
      end_oid: null,
    });
  });

  it("rejects an unsupported agent and an invalid snapshot oid", () => {
    const claudeEvent = baseEvent({
      kind: "tool.completed",
      source: {
        agent: "claude",
        adapter: "x",
        adapter_version: "0.0.1",
        build: null,
        schema: null,
        record_type: null,
        payload_type: null,
        sequence: null,
        durability: null,
        origin: "live",
      },
    });
    expect(TapeEnvelopeSchema.safeParse(claudeEvent).success).toBe(false);

    const badOidEvent = baseEvent({
      kind: "file.snapshot",
      source: {
        agent: "opencode",
        adapter: "opencode-sqlite",
        adapter_version: "0.1.0",
        build: null,
        schema: null,
        record_type: null,
        payload_type: null,
        sequence: null,
        durability: null,
        origin: "live",
      },
      links: { snapshot: { kind: "git_oids", start_oid: "nothex", end_oid: null } },
    });
    expect(TapeEnvelopeSchema.safeParse(badOidEvent).success).toBe(false);
  });

  it("covers the gap codes both adapters can emit and the API error shape", () => {
    expect(CaptureGapCodeSchema.options).toContain("frame_embedded");
    expect(CaptureGapCodeSchema.options).toContain("checkpoint_trim");
    const error = ApiErrorSchema.parse({
      error: { code: "not_on_tape", message: "Not on the tape." },
    });
    expect(error.error.code).toBe("not_on_tape");
  });
});
