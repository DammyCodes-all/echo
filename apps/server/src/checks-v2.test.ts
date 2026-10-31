import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ChangeCard,
  ChecksV2ResponseSchema,
  CheckV2AnswerResponseSchema,
  type SessionStory,
} from "@echo/contracts";
import {
  type EchoDb,
  getSessionSummary,
  openEchoDb,
  recordEngagementEvents,
  upsertArtifactRef,
  upsertProject,
  upsertSession,
} from "@echo/db";
import { describe, expect, it } from "vitest";
import { createChecksV2Service } from "./checks-v2";

const PROJECT_ID = "prj_checks2";
const ISO = "2026-10-28T12:00:00.000Z";
const ENV = { META_API_KEY: "test-key", META_MODEL_ID: "test-model" } as NodeJS.ProcessEnv;
const OFF_ENV = { ...ENV, ECHO_MODEL: "off" } as NodeJS.ProcessEnv;
const silentLog = { info: () => {}, error: () => {} };

function seedDb(sessionId: string): { db: EchoDb; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-checks2-data-"));
  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  upsertProject(db, { id: PROJECT_ID, root: "/repo", name: "checks2" });
  upsertSession(db, {
    id: sessionId,
    projectId: PROJECT_ID,
    agent: "opencode",
    model: null,
    directory: "/repo",
    title: "checks2",
    startedAt: ISO,
    tapePath: join(dataDir, "tape.jsonl"),
    captureQuality: "partial",
  });
  return { db, dataDir };
}

function makeCard(id: string, overrides: Partial<ChangeCard> = {}): ChangeCard {
  return {
    id,
    headline: `Change ${id}.`,
    constituentHunkIds: [],
    constituentActionIds: [],
    rank: 1,
    sessionOrder: 0,
    highRisk: false,
    riskReasons: [],
    verification: "nothing",
    why: [],
    before: [],
    now: [],
    checkedBy: [],
    touches: [],
    moment: {
      eventId: null,
      toolCallId: null,
      ts: null,
      excerpt: `Change ${id}.`,
      label: "uncertain",
    },
    history: { priorSessionIds: [], previousPicture: null, note: null },
    ...overrides,
  };
}

function card1(): ChangeCard {
  return makeCard("h_aaaaaaaaaaaaaaaa", {
    headline: "Retry billing charges",
    rank: 1,
    highRisk: true,
    riskReasons: ["touches payment code"],
    verification: "observed",
    touches: ["billing/retry.ts"],
    why: [{ text: "billing/retry.ts retry changed", label: "observed", factIds: [] }],
  });
}

function card2(): ChangeCard {
  return makeCard("h_bbbbbbbbbbbbbbbb", {
    headline: "Fix docs typo",
    rank: 2,
    touches: ["docs/readme.md"],
    why: [{ text: "docs/readme.md typo fixed", label: "uncertain", factIds: [] }],
  });
}

function writeStory(db: EchoDb, dataDir: string, sessionId: string, cards: ChangeCard[]): void {
  const story: SessionStory = {
    schemaVersion: 1,
    sessionId,
    generatedAt: ISO,
    generator: { kind: "skeleton", model: null, promptVersion: "skeleton-v1" },
    tapeWatermark: { eventCount: 0, sha256: "abc" },
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
    sessionId,
    "artifacts",
    "story.json",
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(story));
  upsertArtifactRef(db, {
    sessionId,
    kind: "story",
    path,
    tapeWatermark: story.tapeWatermark,
    generator: "skeleton-v1",
    generatedAt: story.generatedAt,
  });
}

function seedSession(sessionId: string): { db: EchoDb; dataDir: string } {
  const seeded = seedDb(sessionId);
  writeStory(seeded.db, seeded.dataDir, sessionId, [card1(), card2()]);
  recordEngagementEvents(seeded.db, sessionId, [
    { id: "eng-1", cardId: "h_bbbbbbbbbbbbbbbb", kind: "card_expanded", occurredAt: ISO },
  ]);
  return seeded;
}

function stubFetchQueue(replies: unknown[]) {
  let calls = 0;
  const bodies: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ""));
    const reply = replies[Math.min(calls, replies.length - 1)];
    calls += 1;
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls, bodies: () => bodies };
}

function draftSet(): unknown {
  return {
    questions: [
      {
        cardId: "h_aaaaaaaaaaaaaaaa",
        format: "free_text",
        kind: "teach_back",
        question:
          "Explain the billing retry change in billing/retry.ts so a teammate can act on it.",
        rubric: ["states what changed in billing/retry.ts"],
        explanation: "The retry path in billing/retry.ts changed.",
        evidencePaths: ["billing/retry.ts"],
      },
      {
        cardId: "h_bbbbbbbbbbbbbbbb",
        format: "mcq",
        kind: "consequence",
        question: "What did the docs change cost or open up?",
        options: [
          { id: "o1", text: "Nothing beyond docs" },
          { id: "o2", text: "The billing retry path" },
        ],
        correctOptionId: "o1",
        distractorSources: [],
        explanation: "Docs-only change in docs/readme.md.",
        evidencePaths: ["docs/readme.md"],
      },
    ],
  };
}

function hitGrading(): unknown {
  return {
    hits: [
      {
        point: "states what changed in billing/retry.ts",
        hit: true,
        excerpt: "billing/retry.ts",
        why: "names the file",
      },
    ],
  };
}

function missGrading(): unknown {
  return {
    hits: [
      {
        point: "states what changed in billing/retry.ts",
        hit: false,
        excerpt: null,
        why: "not mentioned",
      },
    ],
  };
}

describe("createChecksV2Service", () => {
  it("returns 404 for unknown sessions", async () => {
    const { db, dataDir } = seedSession("ses_v2_404");
    try {
      const service = createChecksV2Service({ db, dataDir, log: silentLog }, { env: ENV });
      expect((await service.generate("ses_missing")).status).toBe(404);
      expect((await service.checkMe("ses_missing", "h_aaaaaaaaaaaaaaaa")).status).toBe(404);
      expect(service.state("ses_missing").status).toBe(404);
      expect(service.skip("ses_missing").status).toBe(404);
      expect(
        (
          await service.answer("ses_missing", {
            questionId: "q",
            confidence: "certain",
            selectedOptionId: null,
            answerText: null,
          })
        ).status,
      ).toBe(404);
    } finally {
      db.close();
    }
  });

  it("generate fails closed when the model is off and leaves status untouched", async () => {
    const { db, dataDir } = seedSession("ses_v2_off");
    try {
      const service = createChecksV2Service({ db, dataDir, log: silentLog }, { env: OFF_ENV });
      const outcome = await service.generate("ses_v2_off");
      expect(outcome.status).toBe(503);
      expect(outcome.body).toMatchObject({ error: { code: "check_unavailable" } });
      expect(getSessionSummary(db, "ses_v2_off")?.checkStatus).toBe("not_checked");
      expect(service.state("ses_v2_off").body).toMatchObject({ status: "offered", questions: [] });
    } finally {
      db.close();
    }
  });

  it("generate rejects sessions with no story or no check needed", async () => {
    const { db, dataDir } = seedDb("ses_v2_nostory");
    try {
      const service = createChecksV2Service({ db, dataDir, log: silentLog }, { env: ENV });
      const missing = await service.generate("ses_v2_nostory");
      expect(missing.status).toBe(400);
      expect(missing.body).toMatchObject({ error: { message: "no story yet" } });
      writeStory(db, dataDir, "ses_v2_nostory", []);
      const empty = await service.generate("ses_v2_nostory");
      expect(empty.status).toBe(400);
      expect(empty.body).toMatchObject({ error: { message: "no check needed" } });
    } finally {
      db.close();
    }
  });

  it("generate prefers cards touching files the project got wrong before", async () => {
    const { db, dataDir } = seedDb("ses_xnow");
    try {
      upsertSession(db, {
        id: "ses_xpast",
        projectId: PROJECT_ID,
        agent: "opencode",
        model: null,
        directory: "/repo",
        title: "past",
        startedAt: ISO,
        tapePath: join(dataDir, "tape-past.jsonl"),
        captureQuality: "partial",
      });
      upsertSession(db, {
        id: "ses_xnow",
        projectId: PROJECT_ID,
        agent: "opencode",
        model: null,
        directory: "/repo",
        title: "now",
        startedAt: ISO,
        tapePath: join(dataDir, "tape-now.jsonl"),
        captureQuality: "partial",
      });
      // Past session: one card on db/store.ts, answered confidently but wrong.
      writeStory(db, dataDir, "ses_xpast", [
        makeCard("h_8888888888888888", { touches: ["db/store.ts"] }),
      ]);
      const pastPath = join(
        dataDir,
        "projects",
        PROJECT_ID,
        "sessions",
        "ses_xpast",
        "artifacts",
        "checks_v2.json",
      );
      writeFileSync(
        pastPath,
        JSON.stringify({
          schemaVersion: 1,
          sessionId: "ses_xpast",
          status: "completed",
          generatedAt: ISO,
          tapeWatermark: { eventCount: 0, sha256: "abc" },
          questions: [],
          attempts: [],
          picture: [
            { cardId: "h_8888888888888888", bucket: "confident_but_wrong", questionId: "q_past" },
          ],
          currentQuestionId: null,
          origin: "offer",
        }),
      );
      // Now session: six plain cards; only the worst-ranked touches the weak file.
      const nowCards = [1, 2, 3, 4, 5, 6].map((rank) =>
        makeCard(`h_${String(rank).repeat(16)}`, {
          rank,
          touches: rank === 6 ? ["db/store.ts"] : [`docs/f${rank}.md`],
        }),
      );
      writeStory(db, dataDir, "ses_xnow", nowCards);
      const draftAll = {
        questions: [1, 2, 3, 4, 5, 6].map((rank) => {
          const file = rank === 6 ? "db/store.ts" : `docs/f${rank}.md`;
          return {
            cardId: `h_${String(rank).repeat(16)}`,
            format: "free_text",
            kind: "teach_back",
            question: `What changed in ${file}?`,
            rubric: [`States the ${file} change.`],
            explanation: `${file} changed.`,
            evidencePaths: [file],
          };
        }),
      };
      const { fetchImpl, calls } = stubFetchQueue([draftAll]);
      const service = createChecksV2Service(
        { db, dataDir, log: silentLog },
        { env: ENV, fetchImpl },
      );
      const state = ChecksV2ResponseSchema.parse((await service.generate("ses_xnow")).body);
      expect(calls()).toBe(1);
      const pictured = new Map(state.picture.map((entry) => [entry.cardId, entry.questionId]));
      // Rank 6 jumps into the five targeted slots on the weak-file signal;
      // rank 5 (better rank, fresh files) drops out.
      expect(pictured.get("h_6666666666666666")).not.toBeNull();
      expect(pictured.get("h_5555555555555555")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("generate keeps rank order when no other session left a weak file", async () => {
    const { db, dataDir } = seedDb("ses_xsolo");
    try {
      upsertSession(db, {
        id: "ses_xsolo",
        projectId: PROJECT_ID,
        agent: "opencode",
        model: null,
        directory: "/repo",
        title: "solo",
        startedAt: ISO,
        tapePath: join(dataDir, "tape-solo.jsonl"),
        captureQuality: "partial",
      });
      const soloCards = [1, 2, 3, 4, 5, 6].map((rank) =>
        makeCard(`h_${String(rank).repeat(16)}`, { rank, touches: [`docs/f${rank}.md`] }),
      );
      writeStory(db, dataDir, "ses_xsolo", soloCards);
      const draftAll = {
        questions: [1, 2, 3, 4, 5, 6].map((rank) => {
          const file = `docs/f${rank}.md`;
          return {
            cardId: `h_${String(rank).repeat(16)}`,
            format: "free_text",
            kind: "teach_back",
            question: `What changed in ${file}?`,
            rubric: [`States the ${file} change.`],
            explanation: `${file} changed.`,
            evidencePaths: [file],
          };
        }),
      };
      const { fetchImpl } = stubFetchQueue([draftAll]);
      const service = createChecksV2Service(
        { db, dataDir, log: silentLog },
        { env: ENV, fetchImpl },
      );
      const state = ChecksV2ResponseSchema.parse((await service.generate("ses_xsolo")).body);
      const pictured = new Map(state.picture.map((entry) => [entry.cardId, entry.questionId]));
      expect(pictured.get("h_5555555555555555")).not.toBeNull();
      expect(pictured.get("h_6666666666666666")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("runs generate to answer to completed and marks the session checked", async () => {
    const { db, dataDir } = seedSession("ses_v2_full");
    try {
      const { fetchImpl } = stubFetchQueue([draftSet(), hitGrading()]);
      const service = createChecksV2Service(
        { db, dataDir, log: silentLog },
        { env: ENV, fetchImpl },
      );
      const generated = await service.generate("ses_v2_full");
      expect(generated.status).toBe(200);
      const state = ChecksV2ResponseSchema.parse(generated.body);
      expect(state.status).toBe("in_progress");
      expect(state.questions).toHaveLength(2);
      // Public shape strips keys, rubrics and explanations.
      expect(JSON.stringify(state)).not.toContain("correctOptionId");
      expect(JSON.stringify(state)).not.toContain("distractorSources");
      expect(JSON.stringify(state)).not.toContain("The retry path");
      expect(state.picture).toHaveLength(2);
      expect(state.picture.every((entry) => entry.bucket === "never_looked")).toBe(true);

      const mcq = state.questions.find((entry) => entry.cardId === "h_bbbbbbbbbbbbbbbb");
      const free = state.questions.find((entry) => entry.cardId === "h_aaaaaaaaaaaaaaaa");
      if (!mcq || !free) throw new Error("expected both questions");
      expect(state.currentQuestionId).toBe(state.questions[0]?.id);

      const answeredMcq = await service.answer("ses_v2_full", {
        questionId: mcq.id,
        confidence: "certain",
        selectedOptionId: "o1",
        answerText: null,
      });
      expect(answeredMcq.status).toBe(200);
      const mcqBody = CheckV2AnswerResponseSchema.parse(answeredMcq.body);
      expect(mcqBody.attempt.correct).toBe(true);
      expect(mcqBody.attempt.bucket).toBe("solid");
      expect(mcqBody.reveal.summary).toBe("Docs-only change in docs/readme.md.");
      expect(mcqBody.reveal.evidence).toHaveLength(1);

      const mid = ChecksV2ResponseSchema.parse(service.state("ses_v2_full").body);
      expect(mid.currentQuestionId).toBe(free.id);
      expect(mid.picture.find((entry) => entry.cardId === "h_bbbbbbbbbbbbbbbb")?.bucket).toBe(
        "solid",
      );

      const answeredFree = await service.answer("ses_v2_full", {
        questionId: free.id,
        confidence: "guessing",
        selectedOptionId: null,
        answerText: "The change updated billing/retry.ts.",
      });
      expect(answeredFree.status).toBe(200);
      const freeBody = CheckV2AnswerResponseSchema.parse(answeredFree.body);
      expect(freeBody.attempt.correct).toBe(true);
      expect(freeBody.attempt.bucket).toBe("right_but_unsure");
      expect(freeBody.attempt.rubricHits).toHaveLength(1);

      const done = ChecksV2ResponseSchema.parse(service.state("ses_v2_full").body);
      expect(done.status).toBe("completed");
      expect(done.currentQuestionId).toBeNull();
      expect(getSessionSummary(db, "ses_v2_full")?.checkStatus).toBe("checked");
    } finally {
      db.close();
    }
  });

  it("maps wrong answers to the confident and unconfident buckets", async () => {
    const { db, dataDir } = seedSession("ses_v2_wrong");
    try {
      const { fetchImpl } = stubFetchQueue([draftSet(), missGrading()]);
      const service = createChecksV2Service(
        { db, dataDir, log: silentLog },
        { env: ENV, fetchImpl },
      );
      const generated = await service.generate("ses_v2_wrong");
      const state = ChecksV2ResponseSchema.parse(generated.body);
      const mcq = state.questions.find((entry) => entry.cardId === "h_bbbbbbbbbbbbbbbb");
      const free = state.questions.find((entry) => entry.cardId === "h_aaaaaaaaaaaaaaaa");
      if (!mcq || !free) throw new Error("expected both questions");

      const wrongCertain = await service.answer("ses_v2_wrong", {
        questionId: mcq.id,
        confidence: "certain",
        selectedOptionId: "o2",
        answerText: null,
      });
      expect(CheckV2AnswerResponseSchema.parse(wrongCertain.body).attempt.bucket).toBe(
        "confident_but_wrong",
      );
      const wrongGuessing = await service.answer("ses_v2_wrong", {
        questionId: free.id,
        confidence: "guessing",
        selectedOptionId: null,
        answerText: "I have no idea what changed.",
      });
      const wrongBody = CheckV2AnswerResponseSchema.parse(wrongGuessing.body);
      expect(wrongBody.attempt.correct).toBe(false);
      expect(wrongBody.attempt.bucket).toBe("wrong_and_knew_it");
      // Completion counts answers, not correctness.
      expect(ChecksV2ResponseSchema.parse(service.state("ses_v2_wrong").body).status).toBe(
        "completed",
      );
      expect(getSessionSummary(db, "ses_v2_wrong")?.checkStatus).toBe("checked");
    } finally {
      db.close();
    }
  });

  it("rejects retakes and malformed answers", async () => {
    const { db, dataDir } = seedSession("ses_v2_shape");
    try {
      const { fetchImpl } = stubFetchQueue([draftSet(), hitGrading()]);
      const service = createChecksV2Service(
        { db, dataDir, log: silentLog },
        { env: ENV, fetchImpl },
      );
      const state = ChecksV2ResponseSchema.parse((await service.generate("ses_v2_shape")).body);
      const mcq = state.questions.find((entry) => entry.cardId === "h_bbbbbbbbbbbbbbbb");
      const free = state.questions.find((entry) => entry.cardId === "h_aaaaaaaaaaaaaaaa");
      if (!mcq || !free) throw new Error("expected both questions");

      const noKey = await service.answer("ses_v2_shape", {
        questionId: mcq.id,
        confidence: "certain",
        selectedOptionId: null,
        answerText: null,
      });
      expect(noKey.status).toBe(400);
      const noText = await service.answer("ses_v2_shape", {
        questionId: free.id,
        confidence: "guessing",
        selectedOptionId: null,
        answerText: "   ",
      });
      expect(noText.status).toBe(400);
      const unknown = await service.answer("ses_v2_shape", {
        questionId: "q_missing",
        confidence: "certain",
        selectedOptionId: "o1",
        answerText: null,
      });
      expect(unknown.status).toBe(404);

      const first = await service.answer("ses_v2_shape", {
        questionId: mcq.id,
        confidence: "certain",
        selectedOptionId: "o1",
        answerText: null,
      });
      expect(first.status).toBe(200);
      const retake = await service.answer("ses_v2_shape", {
        questionId: mcq.id,
        confidence: "certain",
        selectedOptionId: "o1",
        answerText: null,
      });
      expect(retake.status).toBe(400);
      expect(retake.body).toMatchObject({ error: { message: "question already answered" } });
    } finally {
      db.close();
    }
  });

  it("records nothing when free_text grading has no model", async () => {
    const { db, dataDir } = seedSession("ses_v2_nograde");
    try {
      const { fetchImpl } = stubFetchQueue([draftSet()]);
      const on = createChecksV2Service({ db, dataDir, log: silentLog }, { env: ENV, fetchImpl });
      const state = ChecksV2ResponseSchema.parse((await on.generate("ses_v2_nograde")).body);
      const free = state.questions.find((entry) => entry.cardId === "h_aaaaaaaaaaaaaaaa");
      if (!free) throw new Error("expected a free_text question");
      const off = createChecksV2Service({ db, dataDir, log: silentLog }, { env: OFF_ENV });
      const outcome = await off.answer("ses_v2_nograde", {
        questionId: free.id,
        confidence: "certain",
        selectedOptionId: null,
        answerText: "The change updated billing/retry.ts.",
      });
      expect(outcome.status).toBe(503);
      expect(ChecksV2ResponseSchema.parse(on.state("ses_v2_nograde").body).attempts).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("skips at the offer and mid-check, and refuses to skip a finished set", async () => {
    const { db, dataDir } = seedSession("ses_v2_skip");
    try {
      const service = createChecksV2Service({ db, dataDir, log: silentLog }, { env: ENV });
      const atOffer = service.skip("ses_v2_skip");
      expect(atOffer.status).toBe(200);
      expect(ChecksV2ResponseSchema.parse(atOffer.body).status).toBe("skipped");
      expect(getSessionSummary(db, "ses_v2_skip")?.checkStatus).toBe("skipped");
    } finally {
      db.close();
    }

    const { db: db2, dataDir: dataDir2 } = seedSession("ses_v2_skipmid");
    try {
      const { fetchImpl } = stubFetchQueue([draftSet(), hitGrading()]);
      const service = createChecksV2Service(
        { db: db2, dataDir: dataDir2, log: silentLog },
        { env: ENV, fetchImpl },
      );
      const state = ChecksV2ResponseSchema.parse((await service.generate("ses_v2_skipmid")).body);
      const mcq = state.questions.find((entry) => entry.cardId === "h_bbbbbbbbbbbbbbbb");
      if (!mcq) throw new Error("expected an mcq question");
      await service.answer("ses_v2_skipmid", {
        questionId: mcq.id,
        confidence: "certain",
        selectedOptionId: "o1",
        answerText: null,
      });
      const mid = service.skip("ses_v2_skipmid");
      expect(mid.status).toBe(200);
      const skipped = ChecksV2ResponseSchema.parse(mid.body);
      expect(skipped.status).toBe("skipped");
      expect(skipped.attempts).toHaveLength(1);
      expect(getSessionSummary(db2, "ses_v2_skipmid")?.checkStatus).toBe("skipped");
    } finally {
      db2.close();
    }

    const { db: db3, dataDir: dataDir3 } = seedSession("ses_v2_skipdone");
    try {
      const { fetchImpl } = stubFetchQueue([draftSet(), hitGrading()]);
      const service = createChecksV2Service(
        { db: db3, dataDir: dataDir3, log: silentLog },
        { env: ENV, fetchImpl },
      );
      const state = ChecksV2ResponseSchema.parse((await service.generate("ses_v2_skipdone")).body);
      for (const question of state.questions) {
        const isMcq = question.format === "mcq";
        await service.answer("ses_v2_skipdone", {
          questionId: question.id,
          confidence: "certain",
          selectedOptionId: isMcq ? "o1" : null,
          answerText: isMcq ? null : "The change updated billing/retry.ts.",
        });
      }
      // The free_text answer consumed the second queued reply; correctness
      // does not matter here, only that the set finished.
      const refused = service.skip("ses_v2_skipdone");
      expect(refused.status).toBe(400);
    } finally {
      db3.close();
    }
  });

  it("check-me builds a single-card set that never flips session status", async () => {
    const { db, dataDir } = seedSession("ses_v2_checkme");
    try {
      const { fetchImpl, calls } = stubFetchQueue([draftSet()]);
      const service = createChecksV2Service(
        { db, dataDir, log: silentLog },
        { env: ENV, fetchImpl },
      );
      const badCard = await service.checkMe("ses_v2_checkme", "card-nope");
      expect(badCard.status).toBe(400);
      const single = await service.checkMe("ses_v2_checkme", "h_bbbbbbbbbbbbbbbb");
      expect(single.status).toBe(200);
      const singleState = ChecksV2ResponseSchema.parse(single.body);
      expect(singleState.questions).toHaveLength(1);
      expect(singleState.questions[0]?.cardId).toBe("h_bbbbbbbbbbbbbbbb");
      expect(singleState.currentQuestionId).toBe(singleState.questions[0]?.id);
      expect(calls()).toBe(1);

      const repeat = await service.checkMe("ses_v2_checkme", "h_bbbbbbbbbbbbbbbb");
      expect(ChecksV2ResponseSchema.parse(repeat.body).questions).toHaveLength(1);
      expect(calls()).toBe(1);

      const question = singleState.questions[0];
      if (!question) throw new Error("expected a question");
      const answered = await service.answer("ses_v2_checkme", {
        questionId: question.id,
        confidence: "certain",
        selectedOptionId: "o1",
        answerText: null,
      });
      expect(answered.status).toBe(200);
      const after = ChecksV2ResponseSchema.parse(service.state("ses_v2_checkme").body);
      expect(after.status).toBe("in_progress");
      expect(after.attempts).toHaveLength(1);
      expect(getSessionSummary(db, "ses_v2_checkme")?.checkStatus).toBe("not_checked");
    } finally {
      db.close();
    }
  });

  it("state with no set returns an empty offered envelope", async () => {
    const { db, dataDir } = seedSession("ses_v2_offered");
    try {
      const service = createChecksV2Service({ db, dataDir, log: silentLog }, { env: ENV });
      const outcome = service.state("ses_v2_offered");
      expect(outcome.status).toBe(200);
      expect(ChecksV2ResponseSchema.parse(outcome.body)).toMatchObject({
        status: "offered",
        questions: [],
        attempts: [],
        picture: [],
        currentQuestionId: null,
      });
    } finally {
      db.close();
    }
  });

  it("drafts with a 10k low-reasoning budget by default", async () => {
    const { db, dataDir } = seedSession("ses_v2_budget");
    try {
      const { fetchImpl, bodies } = stubFetchQueue([draftSet()]);
      const service = createChecksV2Service(
        { db, dataDir, log: silentLog },
        { env: ENV, fetchImpl },
      );
      const outcome = await service.generate("ses_v2_budget");
      expect(outcome.status).toBe(200);
      const request = JSON.parse(bodies()[0] ?? "{}") as Record<string, unknown>;
      expect(request["max_tokens"]).toBe(10_000);
      expect(request["reasoning_effort"]).toBe("low");
    } finally {
      db.close();
    }
  });

  it("honors explicit model env over the checks budget defaults", async () => {
    const { db, dataDir } = seedSession("ses_v2_budgenv");
    try {
      const { fetchImpl, bodies } = stubFetchQueue([draftSet()]);
      const service = createChecksV2Service(
        { db, dataDir, log: silentLog },
        {
          env: { ...ENV, META_MAX_TOKENS: "4000", META_REASONING_EFFORT: "medium" },
          fetchImpl,
        },
      );
      const outcome = await service.generate("ses_v2_budgenv");
      expect(outcome.status).toBe(200);
      const request = JSON.parse(bodies()[0] ?? "{}") as Record<string, unknown>;
      expect(request["max_tokens"]).toBe(4000);
      expect(request["reasoning_effort"]).toBe("medium");
    } finally {
      db.close();
    }
  });

  it("generate fails closed fast when the model call stalls", async () => {
    const { db, dataDir } = seedSession("ses_v2_stall");
    try {
      // A stalled model call: pending until aborted, like a real hung fetch.
      const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("This operation was aborted", "AbortError"));
          });
        })) as typeof fetch;
      const service = createChecksV2Service(
        { db, dataDir, log: silentLog },
        { env: ENV, fetchImpl: hangingFetch, timeoutMs: 50 },
      );
      const outcome = await service.generate("ses_v2_stall");
      expect(outcome.status).toBe(503);
      expect(getSessionSummary(db, "ses_v2_stall")?.checkStatus).toBe("not_checked");
    } finally {
      db.close();
    }
  }, 10_000);
});

describe("checks-v2 demo overlay", () => {
  function artifactPath(dataDir: string, sessionId: string): string {
    return join(
      dataDir,
      "projects",
      PROJECT_ID,
      "sessions",
      sessionId,
      "artifacts",
      "checks_v2.json",
    );
  }

  async function bake(dataDir: string, db: EchoDb, sessionId: string) {
    const { fetchImpl } = stubFetchQueue([draftSet(), hitGrading()]);
    const service = createChecksV2Service({ db, dataDir, log: silentLog }, { env: ENV, fetchImpl });
    const generated = await service.generate(sessionId);
    expect(generated.status).toBe(200);
    return ChecksV2ResponseSchema.parse(generated.body);
  }

  it("answers persist to memory while the baked file stays byte-identical", async () => {
    const { db, dataDir } = seedSession("ses_v2_demo");
    try {
      const baked = await bake(dataDir, db, "ses_v2_demo");
      const mcq = baked.questions.find((entry) => entry.cardId === "h_bbbbbbbbbbbbbbbb");
      if (!mcq) throw new Error("expected the mcq question");
      const before = readFileSync(artifactPath(dataDir, "ses_v2_demo"), "utf8");
      const demo = createChecksV2Service({ db, dataDir, log: silentLog }, { env: ENV, demo: true });
      const answered = await demo.answer("ses_v2_demo", {
        questionId: mcq.id,
        confidence: "certain",
        selectedOptionId: "o1",
        answerText: null,
      });
      expect(answered.status).toBe(200);
      const mid = ChecksV2ResponseSchema.parse(demo.state("ses_v2_demo").body);
      expect(mid.attempts).toHaveLength(1);
      expect(readFileSync(artifactPath(dataDir, "ses_v2_demo"), "utf8")).toBe(before);
      // A fresh file-backed service sees none of it: nothing leaked to disk.
      const fileBacked = createChecksV2Service({ db, dataDir, log: silentLog }, { env: ENV });
      expect(
        ChecksV2ResponseSchema.parse(fileBacked.state("ses_v2_demo").body).attempts,
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("demo completion does not flip the session check status", async () => {
    const { db, dataDir } = seedSession("ses_v2_demo_done");
    try {
      const baked = await bake(dataDir, db, "ses_v2_demo_done");
      const mcq = baked.questions.find((entry) => entry.cardId === "h_bbbbbbbbbbbbbbbb");
      const free = baked.questions.find((entry) => entry.cardId === "h_aaaaaaaaaaaaaaaa");
      if (!mcq || !free) throw new Error("expected both questions");
      const { fetchImpl } = stubFetchQueue([hitGrading()]);
      const demo = createChecksV2Service(
        { db, dataDir, log: silentLog },
        { env: ENV, fetchImpl, demo: true },
      );
      await demo.answer("ses_v2_demo_done", {
        questionId: mcq.id,
        confidence: "certain",
        selectedOptionId: "o1",
        answerText: null,
      });
      const answeredFree = await demo.answer("ses_v2_demo_done", {
        questionId: free.id,
        confidence: "guessing",
        selectedOptionId: null,
        answerText: "The change updated billing/retry.ts.",
      });
      expect(answeredFree.status).toBe(200);
      expect(ChecksV2ResponseSchema.parse(demo.state("ses_v2_demo_done").body).status).toBe(
        "completed",
      );
      expect(getSessionSummary(db, "ses_v2_demo_done")?.checkStatus).toBe("not_checked");
    } finally {
      db.close();
    }
  });

  it("demo enforces no-retakes within the visitor overlay", async () => {
    const { db, dataDir } = seedSession("ses_v2_demo_retake");
    try {
      const baked = await bake(dataDir, db, "ses_v2_demo_retake");
      const mcq = baked.questions.find((entry) => entry.cardId === "h_bbbbbbbbbbbbbbbb");
      if (!mcq) throw new Error("expected the mcq question");
      const demo = createChecksV2Service({ db, dataDir, log: silentLog }, { env: ENV, demo: true });
      const first = await demo.answer("ses_v2_demo_retake", {
        questionId: mcq.id,
        confidence: "certain",
        selectedOptionId: "o1",
        answerText: null,
      });
      expect(first.status).toBe(200);
      const second = await demo.answer("ses_v2_demo_retake", {
        questionId: mcq.id,
        confidence: "certain",
        selectedOptionId: "o1",
        answerText: null,
      });
      expect(second.status).toBe(400);
    } finally {
      db.close();
    }
  });
});
