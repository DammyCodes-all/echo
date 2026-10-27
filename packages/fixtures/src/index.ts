import { TapeEnvelopeSchema, type TapeEvent, type TapeEventKind } from "@echo/contracts";

export interface FixtureSession {
  projectId: string;
  sessionId: string;
  events: TapeEvent[];
}

/** Obviously fake key shaped like a real one so the redaction gate catches it. */
export const FIXTURE_SYNTHETIC_SECRET = "sk-fixture-synthetic-secret-0001";

const BASE_TS = Date.parse("2026-10-28T12:00:00.000Z");

interface FixtureEventInput {
  kind: TapeEventKind;
  payload: unknown;
  diagnostics?: string[];
  toolCallId?: string;
  recordKey?: string;
}

/**
 * Deterministic synthetic envelope. Every event parses against the contract
 * schema; a throw here means the fixture itself is wrong, not the code under
 * test. Timestamps advance one second per sequence number so ordering is
 * stable without injected clocks.
 */
function fixtureEvent(
  session: Omit<FixtureSession, "events">,
  seq: number,
  input: FixtureEventInput,
): TapeEvent {
  const ts = new Date(BASE_TS + seq * 1000).toISOString();
  return TapeEnvelopeSchema.parse({
    v: 1,
    tape_seq: seq,
    event_id: `fixture-${seq}`,
    record_key: input.recordKey ?? null,
    session_id: session.sessionId,
    project_id: session.projectId,
    kind: input.kind,
    ts,
    observed_at: ts,
    source: {
      agent: "muse",
      adapter: "fixture",
      adapter_version: "0.1.0",
      build: null,
      schema: null,
      record_type: "synthetic",
      payload_type: null,
      sequence: seq,
      durability: "memory",
      origin: "import",
    },
    links: {
      turn_id: null,
      tool_call_id: input.toolCallId ?? null,
      batch_id: null,
      parent_session_id: null,
      subagent_id: null,
      snapshot: null,
    },
    payload: input.payload,
    redaction: { version: "fixture", findings: 0 },
    diagnostics: input.diagnostics ?? [],
  });
}

/**
 * One synthetic session covering the ARCHITECTURE §22 fixture sequence:
 * failed tool, reverted edit, shell write, interrupted tool, rapid
 * edit/revert, synthetic secret, binary + ignored .env, subagent session.
 * The secret is intentionally fake (`sk-fixture-…`) and is asserted redacted
 * in fixtures.test.ts.
 */
export function buildFixtureTape(): FixtureSession {
  const session = { projectId: "proj_fixture", sessionId: "sess_fixture" };
  const inputs: FixtureEventInput[] = [
    { kind: "session.started", payload: { agent: "muse", model: "fixture" } },
    { kind: "prompt.submitted", payload: { text: "Add a greeting to the app entrypoint." } },
    {
      kind: "tool.requested",
      toolCallId: "call_write_1",
      payload: { name: "write", input: { path: "src/app.ts", content: "hi" } },
    },
    {
      kind: "tool.completed",
      toolCallId: "call_write_1",
      payload: { name: "write", outcome: "ok", input: { path: "src/app.ts" } },
    },
    // Failed tool: formatter missing on PATH.
    {
      kind: "tool.failed",
      toolCallId: "call_fmt_1",
      payload: {
        name: "format",
        outcome: "error",
        error: { type: "command_not_found", detail: "prettier: not found" },
      },
    },
    // Shell write: creates a file outside the editor flow.
    {
      kind: "tool.requested",
      toolCallId: "call_exec_1",
      payload: { name: "exec", input: { command: "echo built > dist/out.txt" } },
    },
    {
      kind: "tool.completed",
      toolCallId: "call_exec_1",
      payload: { name: "exec", outcome: "ok", exitCode: 0 },
    },
    // Interrupted tool: user cancelled a long test run.
    {
      kind: "tool.failed",
      toolCallId: "call_test_1",
      payload: {
        name: "exec",
        outcome: "interrupted",
        error: { type: "interrupted", detail: "cancelled by user" },
      },
    },
    // Reverted edit: write then restore the original content.
    {
      kind: "tool.requested",
      toolCallId: "call_write_2",
      payload: { name: "write", input: { path: "src/app.ts", content: "hi!!" } },
    },
    {
      kind: "tool.requested",
      toolCallId: "call_write_3",
      payload: { name: "write", input: { path: "src/app.ts", content: "hi" } },
    },
    // Rapid edit/revert pair on a second file.
    {
      kind: "tool.requested",
      toolCallId: "call_write_4",
      payload: { name: "write", input: { path: "src/flag.ts", content: "on" } },
    },
    {
      kind: "tool.requested",
      toolCallId: "call_write_5",
      payload: { name: "write", input: { path: "src/flag.ts", content: "off" } },
    },
    // Synthetic secret: raw here on purpose; the redaction gate must strip it.
    {
      kind: "tool.completed",
      toolCallId: "call_env_1",
      payload: {
        name: "read",
        outcome: "ok",
        input: { path: ".env.example" },
        content: `META_API_KEY=${FIXTURE_SYNTHETIC_SECRET}`,
      },
    },
    // Binary + ignored .env: captured as diagnostics, never as content.
    {
      kind: "file.snapshot",
      payload: { trigger: "tool.post", commit_oid: null },
      diagnostics: ["binary skipped: assets/logo.png", ".env ignored by policy"],
    },
    // Subagent session: linked back to this session.
    { kind: "subagent.started", payload: { subagent_id: "sub_fixture_1", task: "lint" } },
    {
      kind: "tool.completed",
      toolCallId: "call_lint_1",
      payload: { name: "lint", outcome: "ok" },
    },
    { kind: "subagent.stopped", payload: { subagent_id: "sub_fixture_1", outcome: "ok" } },
    { kind: "turn.failed", payload: { outcome: "error", error: { type: "test_failure" } } },
    { kind: "session.ended", payload: { outcome: "ok" } },
  ];
  const events = inputs.map((input, index) => fixtureEvent(session, index + 1, input));
  return { ...session, events };
}
