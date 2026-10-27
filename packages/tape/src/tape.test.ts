import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TapeEvent } from "@echo/contracts";
import { describe, expect, it } from "vitest";
import { readTape, TapeWriter } from "./index";

function makeEvent(tapeSeq: number): TapeEvent {
  return {
    v: 1,
    tape_seq: tapeSeq,
    event_id: `01JTESTTESTTESTTESTTEST${String(tapeSeq).padStart(2, "0")}`,
    record_key: null,
    session_id: "ses_test",
    project_id: "prj_test",
    kind: "model.response",
    ts: "2026-10-27T10:00:00.000Z",
    observed_at: "2026-10-27T10:00:00.050Z",
    source: {
      agent: "opencode",
      adapter: "opencode-sqlite",
      adapter_version: "0.1.0",
      build: "opencode v2.1.4",
      schema: "opencode.db/2.1.4",
      record_type: "assistant",
      payload_type: null,
      sequence: tapeSeq,
      durability: null,
      origin: "import",
    },
    links: {
      turn_id: null,
      tool_call_id: null,
      batch_id: null,
      parent_session_id: null,
      subagent_id: null,
      snapshot: null,
    },
    payload: { seq: tapeSeq },
    redaction: { version: "r1", findings: 0 },
    diagnostics: [],
  };
}

function tapePath(dir: string): string {
  return join(dir, "tape.jsonl");
}

describe("TapeWriter / readTape", () => {
  it("round-trips events in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-tape-"));
    const writer = new TapeWriter(tapePath(dir));
    writer.append(makeEvent(0));
    writer.append(makeEvent(1));
    writer.close();

    const result = readTape(tapePath(dir));
    expect(result.events.map((e) => e.tape_seq)).toEqual([0, 1]);
    expect(result.truncatedTailBytes).toBe(0);
    expect(result.invalidLines).toBe(0);
  });

  it("reports a partial last line without emitting it", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-tape-"));
    const path = tapePath(dir);
    const writer = new TapeWriter(path);
    writer.append(makeEvent(0));
    writer.close();
    appendFileSync(path, '{"v":1,"tape_seq":1,"event_id":"cut');

    const result = readTape(path);
    expect(result.events.map((e) => e.tape_seq)).toEqual([0]);
    expect(result.truncatedTailBytes).toBeGreaterThan(0);
  });

  it("dedupes repeated event ids when reading", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-tape-"));
    const path = tapePath(dir);
    const writer = new TapeWriter(path);
    writer.append(makeEvent(0));
    writer.append(makeEvent(0));
    writer.close();

    const result = readTape(path);
    expect(result.events).toHaveLength(1);
    expect(result.duplicateEvents).toBe(1);
  });

  it("skips oversized and invalid lines with counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-tape-"));
    const path = tapePath(dir);
    writeFileSync(path, "not json\n");
    const writer = new TapeWriter(path);
    writer.append(makeEvent(0));
    writer.close();
    appendFileSync(path, `${"x".repeat(8 * 1024 * 1024 + 1)}\n`);

    const result = readTape(path);
    expect(result.events.map((e) => e.tape_seq)).toEqual([0]);
    expect(result.invalidLines).toBe(1);
    expect(result.oversizedLines).toBe(1);
  });
});
