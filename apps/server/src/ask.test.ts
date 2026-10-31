import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AskThread,
  Change,
  ChangeCard,
  SessionStory,
  TapeEvent,
  TapeEventKind,
} from "@echo/contracts";
import { CHANGES_FILE_NAME } from "@echo/contracts";
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

function seedDb(extra: TapeEvent[] = []) {
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
    ...extra,
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

const CHANGE_1 = "c_aaaaaaaaaaaaaaaa";
const CHANGE_2 = "c_bbbbbbbbbbbbbbbb";
const UNKNOWN_CHANGE = "c_ffffffffffffffff";

function digestWith(keyword: string, filler: string, total = 60): string {
  const words = [keyword];
  for (let i = 1; i < total; i += 1) words.push(`${filler}${i}`);
  return words.join(" ");
}

function makeChange(id: string, files: string[], digest: string): Change {
  return {
    id,
    version: 1,
    snapshotPair: { prevOid: "prev0", nextOid: "next0" },
    title: `Update ${id.slice(3, 7)} entry`,
    summary: "First sentence here. Second sentence here.",
    before: ["Before text one."],
    now: ["Now text one."],
    howItWorks: [],
    headsUp: [],
    files: files.map((path) => ({ path, note: `Change ${path}.` })),
    digest,
    createdFrom: { kind: "snapshot_pair", prevOid: "prev0", nextOid: "next0" },
  } as Change;
}

function writeChanges(dataDir: string, changes: Change[]): void {
  const path = join(dataDir, "projects", PROJECT_ID, "sessions", SESSION_ID, CHANGES_FILE_NAME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      sessionId: SESSION_ID,
      generatedAt: "2026-10-28T12:00:00.000Z",
      generator: "test",
      summary: "Test changes.",
      diagnostics: [],
      changes,
    }),
  );
}

const DIGEST_STUB = {
  refusal: false,
  refusal_reason: null,
  answer: "Alpha is the earlier change.",
  claims: [
    {
      text: "Alpha is the earlier change.",
      evidence_ids: ["E1"],
      quote: "alpha ax1 ax2",
    },
  ],
  uncertainty: "low",
};

const PAYMENT_STUB = {
  refusal: false,
  refusal_reason: null,
  answer: "The agent refactored the payment module.",
  claims: [
    {
      text: "The agent refactored the payment module.",
      evidence_ids: ["E1"],
      quote: "Refactor the payment module in src/pay.ts",
    },
  ],
  uncertainty: "low",
};

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

  it("answers from the change slice with the change file as scope", async () => {
    const { db, dataDir } = seedDb();
    writeChanges(dataDir, [makeChange(CHANGE_1, ["src/app.ts"], digestWith("ledger", "ax"))]);
    const { fetchImpl, calls } = stubFetch(ANSWERED_STUB);
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const outcome = await service.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
      cardId: null,
      changeId: CHANGE_1,
    });
    expect(outcome.status).toBe(200);
    const body = outcome.body as { status: string; searchedScope: { filePath: string | null } };
    expect(body.status).toBe("answered");
    expect(body.searchedScope.filePath).toBe("src/app.ts");
    expect(calls()).toBe(1);
    // The thread schema has no change field, so the c_ anchor persists null.
    const messages = await threadMessages(service);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]).toMatchObject({ cardId: null });
    expect(messages[1]).toMatchObject({ role: "assistant", cardId: null });
    db.close();
  });

  it("accepts a c_ anchor carried in cardId", async () => {
    const { db, dataDir } = seedDb();
    writeChanges(dataDir, [makeChange(CHANGE_1, ["src/app.ts"], digestWith("ledger", "ax"))]);
    const { fetchImpl } = stubFetch(ANSWERED_STUB);
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const outcome = await service.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
      cardId: CHANGE_1,
    });
    expect(outcome.status).toBe(200);
    const body = outcome.body as { status: string; searchedScope: { filePath: string | null } };
    expect(body.status).toBe("answered");
    expect(body.searchedScope.filePath).toBe("src/app.ts");
    db.close();
  });

  it("refuses pre-model for questions outside the change slice", async () => {
    const { db, dataDir } = seedDb([
      makeEvent(4, "tool.requested", {
        name: "write",
        input: { path: "src/pay.ts", content: "pay" },
      }),
      makeEvent(5, "prompt.submitted", {
        text: "Refactor the payment module in src/pay.ts; this changed the checkout flow.",
      }),
    ]);
    writeChanges(dataDir, [makeChange(CHANGE_1, ["src/app.ts"], digestWith("ledger", "ax"))]);
    const { fetchImpl, calls } = stubFetch(PAYMENT_STUB);
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const scoped = await service.answer(SESSION_ID, {
      question: "What changed in the payment refactor?",
      filePath: null,
      symbols: [],
      cardId: null,
      changeId: CHANGE_1,
    });
    expect(scoped.body).toMatchObject({ status: "refused", refusalReason: "not_on_tape" });
    expect(calls()).toBe(0);
    // Control: the same question over the whole tape answers.
    const unscoped = await service.answer(SESSION_ID, {
      question: "What changed in the payment refactor?",
      filePath: null,
      symbols: [],
      cardId: null,
    });
    expect((unscoped.body as { status: string }).status).toBe("answered");
    expect(calls()).toBe(1);
    db.close();
  });

  it("includes earlier digests but not later ones", async () => {
    const { db, dataDir } = seedDb();
    writeChanges(dataDir, [
      makeChange(CHANGE_1, ["src/app.ts"], digestWith("alpha", "ax")),
      makeChange(CHANGE_2, ["src/app.ts"], digestWith("beta", "bx")),
    ]);
    const { fetchImpl, calls } = stubFetch(DIGEST_STUB);
    const service = createAskService(db, dataDir, { env: ENV, fetchImpl });
    const fromEarlier = await service.answer(SESSION_ID, {
      question: "Tell me about alpha.",
      filePath: null,
      symbols: [],
      cardId: null,
      changeId: CHANGE_2,
    });
    expect((fromEarlier.body as { status: string }).status).toBe("answered");
    expect(calls()).toBe(1);
    const fromLater = await service.answer(SESSION_ID, {
      question: "Tell me about beta.",
      filePath: null,
      symbols: [],
      cardId: null,
      changeId: CHANGE_1,
    });
    expect(fromLater.body).toMatchObject({ status: "refused", refusalReason: "not_on_tape" });
    expect(calls()).toBe(1);
    db.close();
  });

  it("rejects unknown change ids without touching the thread", async () => {
    const { db, dataDir } = seedDb();
    writeChanges(dataDir, [makeChange(CHANGE_1, ["src/app.ts"], digestWith("ledger", "ax"))]);
    const service = createAskService(db, dataDir, { env: ENV });
    const outcome = await service.answer(SESSION_ID, {
      question: "Why this change?",
      filePath: null,
      symbols: [],
      cardId: null,
      changeId: UNKNOWN_CHANGE,
    });
    expect(outcome.status).toBe(400);
    expect(outcome.body).toMatchObject({
      error: { code: "invalid_request", message: "unknown change" },
    });
    expect(await threadMessages(service)).toEqual([]);
    db.close();
  });

  it("rejects change scope when no changes artifact exists", async () => {
    const { db, dataDir } = seedDb();
    const service = createAskService(db, dataDir, { env: ENV });
    const outcome = await service.answer(SESSION_ID, {
      question: "Why this change?",
      filePath: null,
      symbols: [],
      cardId: null,
      changeId: CHANGE_1,
    });
    expect(outcome.status).toBe(400);
    expect(outcome.body).toMatchObject({
      error: { code: "invalid_request", message: "unknown change" },
    });
    expect(await threadMessages(service)).toEqual([]);
    db.close();
  });

  it("fails closed with change scope when the model is off", async () => {
    const { db, dataDir } = seedDb();
    writeChanges(dataDir, [makeChange(CHANGE_1, ["src/app.ts"], digestWith("ledger", "ax"))]);
    const off = createAskService(db, dataDir, {
      env: { ...ENV, ECHO_MODEL: "off" } as NodeJS.ProcessEnv,
    });
    const outcome = await off.answer(SESSION_ID, {
      question: "Which file did the write tool touch?",
      filePath: null,
      symbols: [],
      cardId: null,
      changeId: CHANGE_1,
    });
    expect(outcome.status).toBe(503);
    expect(await threadMessages(off)).toEqual([]);
    db.close();
  });
});

describe("ask demo overlay", () => {
  const input = {
    question: "Which file did the write tool touch?",
    filePath: null,
    symbols: [],
    cardId: null,
  };

  function threadPath(dataDir: string): string {
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

  it("seeds from the baked thread and keeps new turns in memory", async () => {
    const { db, dataDir } = seedDb();
    try {
      const baked = createAskService(db, dataDir, {
        env: ENV,
        fetchImpl: stubFetch(ANSWERED_STUB).fetchImpl,
      });
      const first = await baked.answer(SESSION_ID, input);
      expect(first.status).toBe(200);
      const before = readFileSync(threadPath(dataDir), "utf8");

      const demo = createAskService(db, dataDir, {
        env: ENV,
        fetchImpl: stubFetch(ANSWERED_STUB).fetchImpl,
        demo: true,
      });
      const second = await demo.answer(SESSION_ID, input);
      expect(second.status).toBe(200);
      const thread = await demo.thread(SESSION_ID);
      expect(thread.status).toBe(200);
      // Two baked messages plus the two demo turns.
      expect((thread.body as AskThread).messages).toHaveLength(4);
      // The baked file is untouched and a file-backed reader sees only it.
      expect(readFileSync(threadPath(dataDir), "utf8")).toBe(before);
      const reread = await baked.thread(SESSION_ID);
      expect((reread.body as AskThread).messages).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("writes no thread file when none was baked", async () => {
    const { db, dataDir } = seedDb();
    try {
      const demo = createAskService(db, dataDir, {
        env: ENV,
        fetchImpl: stubFetch(ANSWERED_STUB).fetchImpl,
        demo: true,
      });
      const outcome = await demo.answer(SESSION_ID, input);
      expect(outcome.status).toBe(200);
      expect(existsSync(threadPath(dataDir))).toBe(false);
      const thread = await demo.thread(SESSION_ID);
      expect((thread.body as AskThread).messages).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
