import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AskThread,
  ChangeCard,
  SessionStory,
  TapeEvent,
  TapeEventKind,
} from "@echo/contracts";
import {
  type EchoDb,
  insertStampedEvents,
  openEchoDb,
  upsertArtifactRef,
  upsertProject,
  upsertSession,
} from "@echo/db";
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
  return { db, dataDir };
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

const ANSWERED_STUB = {
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
};

function makeCard(id: string, touches: string[]): ChangeCard {
  return {
    id,
    headline: `Change ${id} touches ${touches.join(", ") || "nothing"}.`,
    constituentHunkIds: [],
    constituentActionIds: [],
    rank: 1,
    sessionOrder: 0,
    highRisk: false,
    riskReasons: [],
    verification: "observed",
    why: [],
    before: [],
    now: [],
    checkedBy: [],
    touches,
    moment: {
      eventId: null,
      toolCallId: null,
      ts: null,
      excerpt: `Change ${id}.`,
      label: "observed",
    },
    history: { priorSessionIds: [], previousPicture: null, note: null },
  };
}

function writeStory(db: EchoDb, dataDir: string, cards: ChangeCard[]): string {
  const story: SessionStory = {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    generatedAt: "2026-10-28T12:00:00.000Z",
    generator: { kind: "skeleton", model: null, promptVersion: "skeleton-v1" },
    tapeWatermark: { eventCount: 3, sha256: "abc" },
    summary: "Test story.",
    skeleton: true,
    shortVersion: [],
    askVsResult: { asked: [], delivered: [], extras: [], missing: [] },
    cards,
    routineSummary: null,
    detours: [],
    looseEnds: [],
    blindSpots: [],
    gaps: [],
    verifiedCounts: {
      observed: 0,
      partlyObserved: 0,
      agentStated: 0,
      nothing: 0,
      total: cards.length,
    },
  };
  const path = join(
    dataDir,
    "projects",
    PROJECT_ID,
    "sessions",
    SESSION_ID,
    "artifacts",
    "story.json",
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(story));
  upsertArtifactRef(db, {
    sessionId: SESSION_ID,
    kind: "story",
    path,
    tapeWatermark: story.tapeWatermark,
    generator: "skeleton-v1",
    generatedAt: story.generatedAt,
  });
  return path;
}

function threadArtifactPath(dataDir: string): string {
  return join(
    dataDir,
    "projects",
    PROJECT_ID,
    "sessions",
    SESSION_ID,
    "artifacts",
    "ask_thread.json",
  );
}

function threadMessages(service: ReturnType<typeof createAskService>) {
  return service.thread(SESSION_ID).then((outcome) => (outcome.body as AskThread).messages);
}

describe("createAskService", () => {
  it("returns 404 for an unknown session", async () => {
    const { db, dataDir } = seedDb();
    const service = createAskService(db, dataDir, { env: ENV });
    const outcome = await service.answer("ses_missing", {
      question: "what happened?",
      filePath: null,
      symbols: [],
      cardId: null,
    });
    expect(outcome.status).toBe(404);
    db.close();
  });

  it("returns 404 for thread on an unknown session", async () => {
    const { db, dataDir } = seedDb();
    const service = createAskService(db, dataDir, { env: ENV });
    const outcome = await service.thread("ses_missing");
    expect(outcome.status).toBe(404);
    db.close();
  });

  it("refuses before the model when nothing on the tape is relevant", async () => {
    const { db, dataDir } = seedDb();
    const { fetchImpl, calls } = stubFetch({ refusal: true });
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const outcome = await service.answer(SESSION_ID, {
      question: "What is the capital of France?",
      filePath: null,
      symbols: [],
      cardId: null,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ status: "refused", refusalReason: "not_on_tape" });
    expect(calls()).toBe(0);
    db.close();
  });

  it("answers with server-validated citations and caches the repeat", async () => {
    const { db, dataDir } = seedDb();
    const { fetchImpl, calls } = stubFetch(ANSWERED_STUB);
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const input = {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
      cardId: null,
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
    const { db, dataDir } = seedDb();
    const { fetchImpl } = stubFetch({
      refusal: false,
      refusal_reason: null,
      answer: "Something happened.",
      claims: [{ text: "Something happened.", evidence_ids: ["E99"], quote: "nothing" }],
      uncertainty: "high",
    });
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const outcome = await service.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
      cardId: null,
    });
    expect(outcome.body).toMatchObject({
      status: "refused",
      refusalReason: "insufficient_evidence",
    });
    db.close();
  });

  it("fails closed when the model is off or the key is missing", async () => {
    const { db, dataDir } = seedDb();
    const off = createAskService(db, dataDir, {
      env: { ...ENV, ECHO_MODEL: "off" } as NodeJS.ProcessEnv,
    });
    const offOutcome = await off.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
      cardId: null,
    });
    expect(offOutcome.status).toBe(503);
    const keyless = createAskService(db, dataDir, { env: {} as NodeJS.ProcessEnv });
    const keylessOutcome = await keyless.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
      cardId: null,
    });
    expect(keylessOutcome.status).toBe(503);
    db.close();
  });

  it("scopes retrieval to the card's single touch as the file scope", async () => {
    const { db, dataDir } = seedDb();
    writeStory(db, dataDir, [makeCard("h_aaaaaaaaaaaaaaaa", ["src/app.ts"])]);
    const { fetchImpl } = stubFetch(ANSWERED_STUB);
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const outcome = await service.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
      cardId: "h_aaaaaaaaaaaaaaaa",
    });
    expect(outcome.status).toBe(200);
    const body = outcome.body as { status: string; searchedScope: { filePath: string | null } };
    expect(body.status).toBe("answered");
    expect(body.searchedScope.filePath).toBe("src/app.ts");
    const messages = await threadMessages(service);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]).toMatchObject({
      cardId: "h_aaaaaaaaaaaaaaaa",
      text: "Which file did the write tool touch?",
      response: null,
    });
    expect(messages[1]).toMatchObject({ role: "assistant", cardId: "h_aaaaaaaaaaaaaaaa" });
    expect(messages[1]?.response).toMatchObject({ status: "answered" });
    db.close();
  });

  it("uses symbol terms for multi-file cards and lets explicit filePath win", async () => {
    const { db, dataDir } = seedDb();
    writeStory(db, dataDir, [makeCard("h_bbbbbbbbbbbbbbbb", ["src/app.ts", "src/other.ts"])]);
    const { fetchImpl } = stubFetch(ANSWERED_STUB);
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const scoped = await service.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
      cardId: "h_bbbbbbbbbbbbbbbb",
    });
    expect(scoped.status).toBe(200);
    const scopedBody = scoped.body as {
      status: string;
      searchedScope: { filePath: string | null };
    };
    expect(scopedBody.status).toBe("answered");
    expect(scopedBody.searchedScope.filePath).toBeNull();
    const explicit = await service.answer(SESSION_ID, {
      question: "What did the write tool do to the app?",
      filePath: "src/other.ts",
      symbols: [],
      cardId: "h_bbbbbbbbbbbbbbbb",
    });
    expect(explicit.status).toBe(200);
    expect(
      (explicit.body as { searchedScope: { filePath: string | null } }).searchedScope.filePath,
    ).toBe("src/other.ts");
    db.close();
  });

  it("rejects card-scoped questions when no story artifact exists", async () => {
    const { db, dataDir } = seedDb();
    const service = createAskService(db, dataDir, { env: ENV });
    const outcome = await service.answer(SESSION_ID, {
      question: "Why this change?",
      filePath: null,
      symbols: [],
      cardId: "h_aaaaaaaaaaaaaaaa",
    });
    expect(outcome.status).toBe(400);
    expect(outcome.body).toMatchObject({
      error: { code: "invalid_request", message: "unknown card" },
    });
    expect(await threadMessages(service)).toEqual([]);
    db.close();
  });

  it("rejects unknown card ids against a present story", async () => {
    const { db, dataDir } = seedDb();
    writeStory(db, dataDir, [makeCard("h_aaaaaaaaaaaaaaaa", ["src/app.ts"])]);
    const { fetchImpl } = stubFetch(ANSWERED_STUB);
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const outcome = await service.answer(SESSION_ID, {
      question: "Why this change?",
      filePath: null,
      symbols: [],
      cardId: "card-nope",
    });
    expect(outcome.status).toBe(400);
    expect(outcome.body).toMatchObject({
      error: { code: "invalid_request", message: "unknown card" },
    });
    expect(await threadMessages(service)).toEqual([]);
    db.close();
  });

  it("accumulates turns across calls in order, including cache hits", async () => {
    const { db, dataDir } = seedDb();
    const { fetchImpl, calls } = stubFetch(ANSWERED_STUB);
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const question = "Which file did the write tool touch?";
    const first = await service.answer(SESSION_ID, {
      question,
      filePath: null,
      symbols: [],
      cardId: null,
    });
    expect(first.status).toBe(200);
    const second = await service.answer(SESSION_ID, {
      question,
      filePath: null,
      symbols: [],
      cardId: null,
    });
    expect((second.body as { cached: boolean }).cached).toBe(true);
    expect(calls()).toBe(1);
    const thread = await service.thread(SESSION_ID);
    expect(thread.status).toBe(200);
    const messages = (thread.body as AskThread).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages.map((message) => message.text)).toEqual([
      question,
      "The write tool touched src/app.ts.",
      question,
      "The write tool touched src/app.ts.",
    ]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(4);
    db.close();
  });

  it("persists pre-model refusals with status refused", async () => {
    const { db, dataDir } = seedDb();
    const { fetchImpl, calls } = stubFetch({ refusal: true });
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const outcome = await service.answer(SESSION_ID, {
      question: "What is the capital of France?",
      filePath: null,
      symbols: [],
      cardId: null,
    });
    expect(outcome.body).toMatchObject({ status: "refused", refusalReason: "not_on_tape" });
    expect(calls()).toBe(0);
    const messages = await threadMessages(service);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", cardId: null });
    expect(messages[1]?.response).toMatchObject({ status: "refused" });
    expect(messages[1]?.text.length).toBeGreaterThan(0);
    db.close();
  });

  it("resets a corrupt thread artifact to empty instead of throwing", async () => {
    const { db, dataDir } = seedDb();
    const { fetchImpl } = stubFetch(ANSWERED_STUB);
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const answered = await service.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
      cardId: null,
    });
    expect(answered.status).toBe(200);
    expect(await threadMessages(service)).toHaveLength(2);
    writeFileSync(threadArtifactPath(dataDir), "not json{{{");
    const thread = await service.thread(SESSION_ID);
    expect(thread.status).toBe(200);
    expect((thread.body as AskThread).messages).toEqual([]);
    db.close();
  });

  it("persists nothing when the model is off", async () => {
    const { db, dataDir } = seedDb();
    const off = createAskService(db, dataDir, {
      env: { ...ENV, ECHO_MODEL: "off" } as NodeJS.ProcessEnv,
    });
    const outcome = await off.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
      cardId: null,
    });
    expect(outcome.status).toBe(503);
    const thread = await off.thread(SESSION_ID);
    expect(thread.status).toBe(200);
    expect((thread.body as AskThread).messages).toEqual([]);
    db.close();
  });
});
