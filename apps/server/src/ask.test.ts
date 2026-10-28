import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TapeEvent, TapeEventKind } from "@echo/contracts";
import { insertStampedEvents, openEchoDb, upsertProject, upsertSession } from "@echo/db";
import { describe, expect, it } from "vitest";
import { createAskService } from "./ask";

const PROJECT_ID = "prj_ask";
const SESSION_ID = "ses_ask";

function makeEvent(seq: number, kind: TapeEventKind, payload: unknown): TapeEvent {
  const ts = `2026-10-28T12:00:${String(seq).padStart(2, "0")}.000Z`;
  return {
    v: 1,
    tape_seq: seq,
    event_id: `ask-${seq}`,
    record_key: null,
    session_id: SESSION_ID,
    project_id: PROJECT_ID,
    kind,
    ts,
    observed_at: ts,
    source: {
      agent: "muse",
      adapter: "test",
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
      tool_call_id: null,
      batch_id: null,
      parent_session_id: null,
      subagent_id: null,
      snapshot: null,
    },
    payload,
    redaction: { version: "test", findings: 0 },
    diagnostics: [],
  };
}

function seedDb() {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-ask-data-"));
  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  upsertProject(db, { id: PROJECT_ID, root: "/repo", name: "repo" });
  upsertSession(db, {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    agent: "muse",
    model: "test",
    directory: "/repo",
    title: "ask test",
    startedAt: "2026-10-28T12:00:00.000Z",
    tapePath: join(dataDir, "tape.jsonl"),
    captureQuality: "partial",
  });
  insertStampedEvents(db, SESSION_ID, [
    makeEvent(1, "prompt.submitted", { text: "Add a greeting to the app entrypoint." }),
    makeEvent(2, "tool.requested", {
      name: "write",
      input: { path: "src/app.ts", content: "hi" },
    }),
    makeEvent(3, "tool.completed", {
      name: "write",
      outcome: "ok",
      input: { path: "src/app.ts" },
    }),
  ]);
  return db;
}

function stubFetch(answer: unknown) {
  let calls = 0;
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(answer) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      { headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  const wrapped = (async (...args: Parameters<typeof fetch>) => {
    calls += 1;
    return fetchImpl(...args);
  }) as typeof fetch;
  return { fetchImpl: wrapped, calls: () => calls };
}

const ENV = { META_API_KEY: "test-key", META_MODEL_ID: "test-model" } as NodeJS.ProcessEnv;

describe("createAskService", () => {
  it("returns 404 for an unknown session", async () => {
    const db = seedDb();
    const service = createAskService(db, { env: ENV });
    const outcome = await service.answer("ses_missing", {
      question: "what happened?",
      filePath: null,
      symbols: [],
    });
    expect(outcome.status).toBe(404);
    db.close();
  });

  it("refuses before the model when nothing on the tape is relevant", async () => {
    const db = seedDb();
    const { fetchImpl, calls } = stubFetch({ refusal: true });
    const service = createAskService(db, { env: ENV, fetchImpl });
    const outcome = await service.answer(SESSION_ID, {
      question: "What is the capital of France?",
      filePath: null,
      symbols: [],
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ status: "refused", refusalReason: "not_on_tape" });
    expect(calls()).toBe(0);
    db.close();
  });

  it("answers with server-validated citations and caches the repeat", async () => {
    const db = seedDb();
    const { fetchImpl, calls } = stubFetch({
      refusal: false,
      refusal_reason: null,
      answer: "The write tool touched src/app.ts.",
      claims: [
        {
          text: "The write tool touched src/app.ts.",
          evidence_ids: ["E1"],
          quote: "tool write requested src/app.ts",
        },
      ],
      uncertainty: "low",
    });
    const service = createAskService(db, { env: ENV, fetchImpl });
    const input = {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
    };
    const first = await service.answer(SESSION_ID, input);
    expect(first.status).toBe(200);
    const body = first.body as {
      status: string;
      cached: boolean;
      claims: Array<{ quote: string | null }>;
    };
    expect(body.status).toBe("answered");
    expect(body.cached).toBe(false);
    const second = await service.answer(SESSION_ID, input);
    expect((second.body as { cached: boolean }).cached).toBe(true);
    expect(calls()).toBe(1);
    db.close();
  });

  it("refuses when the model cites evidence that does not exist", async () => {
    const db = seedDb();
    const { fetchImpl } = stubFetch({
      refusal: false,
      refusal_reason: null,
      answer: "Something happened.",
      claims: [{ text: "Something happened.", evidence_ids: ["E99"], quote: "nothing" }],
      uncertainty: "high",
    });
    const service = createAskService(db, { env: ENV, fetchImpl });
    const outcome = await service.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
    });
    expect(outcome.body).toMatchObject({
      status: "refused",
      refusalReason: "insufficient_evidence",
    });
    db.close();
  });

  it("fails closed when the model is off or the key is missing", async () => {
    const db = seedDb();
    const off = createAskService(db, {
      env: { ...ENV, ECHO_MODEL: "off" } as NodeJS.ProcessEnv,
    });
    const offOutcome = await off.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
    });
    expect(offOutcome.status).toBe(503);
    const keyless = createAskService(db, { env: {} as NodeJS.ProcessEnv });
    const keylessOutcome = await keyless.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
    });
    expect(keylessOutcome.status).toBe(503);
    db.close();
  });
});
