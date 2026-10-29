import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_FILE_NAMES,
  capStorySummary,
  type SessionStory,
  SessionStorySchema,
  type TapeEvent,
  type TapeEventKind,
  type VerifiedCounts,
} from "@echo/contracts";
import {
  appendEvents,
  getArtifactRef,
  getSessionSummary,
  insertSnapshot,
  listSessions,
  openEchoDb,
  readAllEvents,
  setSessionCheckStatus,
  upsertArtifactRef,
  upsertProject,
  upsertSession,
} from "@echo/db";
import type { SnapshotResult } from "@echo/snapshots";
import { snapshotWorkingTree } from "@echo/snapshots";
import { buildSkeletonStory, extractFacts, SKELETON_PROMPT_VERSION } from "@echo/story";
import type { FileAttempt } from "@echo/tape";
import { describe, expect, it } from "vitest";
import {
  computeWatermark,
  createStoryService,
  filterEmptySessions,
  finalizeStory,
  isSessionQuiet,
  normalizeDraftShape,
  STORY_QUIET_MS,
  storyHasContent,
} from "./story";
import { makeSnapshotEvent } from "./tape-events";

const TAKEN_AT = new Date("2026-10-28T10:00:00.000Z");
const ISO = TAKEN_AT.toISOString();
const OFF_ENV = { ...process.env, ECHO_MODEL: "off" } as NodeJS.ProcessEnv;
const MODEL_ENV = {
  ...process.env,
  META_API_KEY: "test-key",
  META_MODEL_ID: "test-model",
} as NodeJS.ProcessEnv;
const silentLog = { info: () => {}, error: () => {} };
const throwingFetch = (() => {
  throw new Error("network used");
}) as unknown as typeof fetch;

function seedTapeEvent(
  sessionId: string,
  projectId: string,
  eventId: string,
  kind: "prompt.submitted" | "tool.completed",
  payload: unknown,
): TapeEvent {
  return {
    v: 1,
    tape_seq: 0,
    event_id: eventId,
    record_key: null,
    session_id: sessionId,
    project_id: projectId,
    kind,
    ts: ISO,
    observed_at: ISO,
    source: {
      agent: "opencode",
      adapter: "test",
      adapter_version: "0.1.0",
      build: null,
      schema: null,
      record_type: null,
      payload_type: null,
      sequence: null,
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
    payload,
    redaction: { version: "r1", findings: 0 },
    diagnostics: [],
  };
}

async function takeSnapshot(input: {
  dataDir: string;
  root: string;
  sessionId: string;
  projectId: string;
  trigger: "baseline" | "final" | "tool.post";
  eventId: string;
}): Promise<SnapshotResult> {
  return snapshotWorkingTree({
    shadowDir: join(input.dataDir, "projects", input.projectId, "shadow.git"),
    root: input.root,
    dataDir: input.dataDir,
    sessionId: input.sessionId,
    projectId: input.projectId,
    trigger: input.trigger,
    eventId: input.eventId,
    takenAt: TAKEN_AT,
  });
}

async function seedSession() {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-story-data-"));
  const root = mkdtempSync(join(tmpdir(), "echo-story-root-"));
  const projectId = "prj_story";
  const sessionId = "ses_story";
  writeFileSync(join(root, "notes.txt"), "a\n");
  const baseline = await takeSnapshot({
    dataDir,
    root,
    sessionId,
    projectId,
    trigger: "baseline",
    eventId: "evt_base",
  });
  writeFileSync(join(root, "notes.txt"), "a\nb\n");
  const final = await takeSnapshot({
    dataDir,
    root,
    sessionId,
    projectId,
    trigger: "final",
    eventId: "evt_final",
  });

  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  upsertProject(db, { id: projectId, root, name: "story" });
  upsertSession(db, {
    id: sessionId,
    projectId,
    agent: "opencode",
    model: null,
    directory: root,
    title: "story",
    startedAt: ISO,
    tapePath: join(dataDir, "tape.jsonl"),
    captureQuality: "partial",
  });
  for (const snapshot of [baseline, final]) {
    insertSnapshot(db, {
      id: snapshot.commitOid,
      sessionId,
      commitOid: snapshot.commitOid,
      parentOid: snapshot.parentOid,
      trigger: snapshot.trigger,
      eventId: snapshot.trigger === "baseline" ? "evt_base" : "evt_final",
      takenAt: snapshot.takenAt,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      status: snapshot.status,
      diagnostics: snapshot.diagnostics,
      files: snapshot.files.map((file) => ({
        path: file.path,
        mode: file.mode,
        blobOid: file.blobOid,
        size: file.size,
        sha256: file.sha256,
        captured: file.captured,
        reason: file.reason,
      })),
    });
  }
  appendEvents(db, sessionId, [
    seedTapeEvent(sessionId, projectId, "evt_prompt", "prompt.submitted", {
      text: "add a greeting line",
    }),
    seedTapeEvent(sessionId, projectId, "evt_run", "tool.completed", {
      command: "pnpm vitest notes.txt",
      exit_code: 0,
    }),
    makeSnapshotEvent({
      agent: "opencode",
      sessionId,
      projectId,
      eventId: "evt_base",
      observedAt: ISO,
      result: baseline,
    }),
    makeSnapshotEvent({
      agent: "opencode",
      sessionId,
      projectId,
      eventId: "evt_final",
      observedAt: ISO,
      result: final,
    }),
  ]);
  return { dataDir, db, projectId, sessionId };
}

// --- Model-path helpers (mirror the stubFetchSequence pattern) ---

function stubFetchSequence(answers: unknown[]) {
  let calls = 0;
  const bodies: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ""));
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls, bodies: () => bodies };
}

const ZERO_COUNTS: VerifiedCounts = {
  observed: 0,
  partlyObserved: 0,
  agentStated: 0,
  nothing: 0,
  total: 0,
};

/** Schema-valid draft over the seeded session facts (F1 is the prompt fact). */
function modelDraft(shortText: string): SessionStory {
  return {
    schemaVersion: 1,
    sessionId: "ses_story",
    generatedAt: "2026-10-28T12:00:00.000Z",
    generator: { kind: "model", model: "test-model", promptVersion: "story-v1" },
    tapeWatermark: { eventCount: 4, sha256: "draft-sha" },
    summary: "add a greeting line",
    skeleton: false,
    shortVersion: [{ text: shortText, label: "observed", factIds: ["F1"] }],
    askVsResult: {
      asked: [{ text: "add a greeting line", label: "agent_stated", factIds: ["F1"] }],
      delivered: [],
      extras: [],
      missing: [],
    },
    cards: [],
    routineSummary: null,
    detours: [],
    looseEnds: [],
    blindSpots: [],
    gaps: [],
    verifiedCounts: { ...ZERO_COUNTS },
  };
}

describe("maybeGenerateStory", () => {
  it("returns unknown_session for missing sessions", async () => {
    const { dataDir, db } = await seedSession();
    try {
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwingFetch },
      );
      const outcome = await service.maybeGenerateStory("ses_missing");
      expect(outcome).toEqual({ outcome: "unknown_session", story: null });
    } finally {
      db.close();
    }
  });

  it("writes a skeleton artifact with no model call, then serves it fresh", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwingFetch },
      );
      const first = await service.maybeGenerateStory(sessionId, { reason: "finalize" });
      expect(first.outcome).toBe("skeleton");
      const story = SessionStorySchema.parse(first.story);
      expect(story.skeleton).toBe(true);
      expect(story.generator).toEqual({
        kind: "skeleton",
        model: null,
        promptVersion: SKELETON_PROMPT_VERSION,
      });
      expect(story.cards).toHaveLength(1);
      expect(story.summary).toBe("Prompts, changes in notes.txt.");
      expect(story.blindSpots).toContain("intermediate states may not be captured");
      // Ported loose ends: no runs on the tape, so the hunk is flagged untested.
      expect(story.looseEnds.map((end) => end.kind)).toContain("untested");
      expect(story.looseEnds.some((end) => end.claims[0]?.text.includes("notes.txt"))).toBe(true);

      const ref = getArtifactRef(db, sessionId, "story");
      expect(ref?.generator).toBe(SKELETON_PROMPT_VERSION);
      expect(ref?.path).toBe(
        join(dataDir, "projects", "prj_story", "sessions", sessionId, ARTIFACT_FILE_NAMES.story),
      );
      expect(existsSync(ref?.path ?? "")).toBe(true);
      expect(JSON.parse(readFileSync(ref?.path ?? "", "utf8"))).toEqual(first.story);
      expect(ref?.tapeWatermark).toEqual(computeWatermark(readAllEvents(db, sessionId)));

      const summary = getSessionSummary(db, sessionId);
      expect(summary?.summary).toBe("Prompts, changes in notes.txt.");
      // Risk needs observed evidence: no flags on this hunk, so the card is
      // not high-risk even though no passing run covers it.
      expect(summary?.highRiskCount).toBe(0);
      expect(story.cards[0]?.highRisk).toBe(false);
      expect(story.cards[0]?.riskReasons).toEqual([]);

      // Read-through with no new events: no model call, no rewrite.
      const second = await service.maybeGenerateStory(sessionId, { reason: "read-through" });
      expect(second.outcome).toBe("fresh");
      expect(second.story).toEqual(first.story);
    } finally {
      db.close();
    }
  });

  it("resets check status when the tape grows past the watermark", async () => {
    const { dataDir, db, sessionId, projectId } = await seedSession();
    try {
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwingFetch },
      );
      const first = await service.maybeGenerateStory(sessionId);
      expect(first.outcome).toBe("skeleton");

      setSessionCheckStatus(db, sessionId, "checked");
      expect(getSessionSummary(db, sessionId)?.checkStatus).toBe("checked");
      appendEvents(db, sessionId, [
        seedTapeEvent(sessionId, projectId, "evt_late", "tool.completed", {
          command: "pnpm vitest notes.txt",
          exit_code: 0,
        }),
      ]);
      const second = await service.maybeGenerateStory(sessionId);
      expect(second.outcome).toBe("skeleton");
      expect(getSessionSummary(db, sessionId)?.checkStatus).toBe("not_checked");
    } finally {
      db.close();
    }
  });

  it("regenerates a story cached by a superseded skeleton builder", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwingFetch },
      );
      const first = await service.maybeGenerateStory(sessionId);
      expect(first.outcome).toBe("skeleton");
      const ref = getArtifactRef(db, sessionId, "story");
      expect(ref?.generator).toBe(SKELETON_PROMPT_VERSION);
      // Simulate a cache written by the previous builder, same watermark.
      if (!ref) throw new Error("expected story artifact ref");
      upsertArtifactRef(db, { ...ref, generator: "skeleton-v1" });
      const second = await service.maybeGenerateStory(sessionId, { reason: "read-through" });
      expect(second.outcome).toBe("skeleton");
      expect(getArtifactRef(db, sessionId, "story")?.generator).toBe(SKELETON_PROMPT_VERSION);
    } finally {
      db.close();
    }
  });

  it("generates from the model and persists artifact, ref and inbox columns", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const { fetchImpl, calls, bodies } = stubFetchSequence([modelDraft("add a greeting line")]);
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        {
          env: MODEL_ENV,
          fetchImpl,
          clock: () => new Date("2026-10-28T13:00:00.000Z"),
        },
      );
      const outcome = await service.maybeGenerateStory(sessionId);
      expect(outcome.outcome).toBe("generated");
      expect(calls()).toBe(1);
      expect(bodies()[0]).toContain("story-v1");
      const story = SessionStorySchema.parse(outcome.story);
      expect(story.skeleton).toBe(false);
      expect(story.generator).toMatchObject({ kind: "model", promptVersion: "story-v1" });
      expect(story.shortVersion.map((claim) => claim.text)).toEqual(["add a greeting line"]);
      expect(story.tapeWatermark).toEqual(computeWatermark(readAllEvents(db, sessionId)));
      const ref = getArtifactRef(db, sessionId, "story");
      expect(ref?.generator).toBe("test-model");
      expect(ref?.path).toBe(
        join(dataDir, "projects", "prj_story", "sessions", sessionId, ARTIFACT_FILE_NAMES.story),
      );
      expect(existsSync(ref?.path ?? "")).toBe(true);
      const summary = getSessionSummary(db, sessionId);
      expect(summary?.summary).toBe("add a greeting line");
    } finally {
      db.close();
    }
  });

  it("regenerates once for failed claims, then ships the fix", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const { fetchImpl, calls, bodies } = stubFetchSequence([
        modelDraft("Does 99 things"),
        modelDraft("add a greeting line"),
      ]);
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const outcome = await service.maybeGenerateStory(sessionId);
      expect(outcome.outcome).toBe("generated");
      expect(calls()).toBe(2);
      expect(bodies()[1]).toContain("failed these checks");
      expect(outcome.story?.shortVersion.map((claim) => claim.text)).toEqual([
        "add a greeting line",
      ]);
      expect(outcome.story?.gaps).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("drops still-failing claims to gap lines after regeneration", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const { fetchImpl, calls } = stubFetchSequence([
        modelDraft("Does 99 things"),
        modelDraft("Does 99 things"),
      ]);
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const outcome = await service.maybeGenerateStory(sessionId);
      expect(outcome.outcome).toBe("generated");
      expect(calls()).toBe(2);
      expect(outcome.story?.shortVersion).toEqual([]);
      expect(outcome.story?.gaps).toEqual(["Echo couldn't verify this: Does 99 things"]);
    } finally {
      db.close();
    }
  });

  it("falls back to the skeleton when the model output is schema-invalid", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const { fetchImpl } = stubFetchSequence([{ nope: true }]);
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const outcome = await service.maybeGenerateStory(sessionId);
      expect(outcome.outcome).toBe("skeleton");
      expect(outcome.story?.skeleton).toBe(true);
      expect(outcome.story?.generator.promptVersion).toBe(SKELETON_PROMPT_VERSION);
    } finally {
      db.close();
    }
  });

  it("sends a very large token budget with capped reasoning effort", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const { fetchImpl, bodies } = stubFetchSequence([modelDraft("add a greeting line")]);
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const outcome = await service.maybeGenerateStory(sessionId);
      expect(outcome.outcome).toBe("generated");
      const request = JSON.parse(bodies()[0] ?? "{}") as Record<string, unknown>;
      expect(request.reasoning_effort).toBe("medium");
      expect(Number(request.max_tokens)).toBeGreaterThanOrEqual(50000);
    } finally {
      db.close();
    }
  });

  it("retries once on schema-invalid drafts, then generates", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const { fetchImpl, calls, bodies } = stubFetchSequence([
        { nope: true },
        modelDraft("add a greeting line"),
      ]);
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const outcome = await service.maybeGenerateStory(sessionId);
      expect(outcome.outcome).toBe("generated");
      expect(calls()).toBe(2);
      expect(bodies()[1]).toContain("schema validation");
      expect(outcome.story?.shortVersion.map((claim) => claim.text)).toEqual([
        "add a greeting line",
      ]);
    } finally {
      db.close();
    }
  });

  it("tolerates missing server-stamped envelope fields in drafts", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const draft = modelDraft("add a greeting line") as unknown as Record<string, unknown>;
      delete draft.tapeWatermark;
      delete draft.generator;
      const { fetchImpl } = stubFetchSequence([draft]);
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const outcome = await service.maybeGenerateStory(sessionId);
      expect(outcome.outcome).toBe("generated");
      expect(outcome.story?.generator).toMatchObject({
        kind: "model",
        promptVersion: "story-v1",
      });
      expect(outcome.story?.tapeWatermark.eventCount).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("coerces malformed card moment and history fields instead of failing", () => {
    const coerced = normalizeDraftShape({
      tapeWatermark: { eventCount: 0, sha256: "" },
      generator: null,
      cards: [
        {
          id: "h_aaaaaaaaaaaaaaaa",
          moment: { eventId: null, toolCallId: "", ts: "", excerpt: "x", label: "bogus" },
          history: { priorSessionIds: [], previousPicture: "bogus", note: null },
          why: { text: "x", label: "observed", factIds: [] },
        },
      ],
    }) as {
      tapeWatermark: { sha256: string };
      generator: { kind: string };
      cards: Array<{
        moment: { toolCallId: unknown; ts: unknown; label: unknown };
        history: { previousPicture: unknown };
        why: unknown;
      }>;
    };
    expect(coerced.tapeWatermark.sha256).toBe("server-stamped");
    expect(coerced.generator.kind).toBe("model");
    expect(coerced.cards[0]?.moment.toolCallId).toBeNull();
    expect(coerced.cards[0]?.moment.ts).toBeNull();
    expect(coerced.cards[0]?.moment.label).toBe("uncertain");
    expect(coerced.cards[0]?.history.previousPicture).toBeNull();
    expect(coerced.cards[0]?.why).toEqual([{ text: "x", label: "observed", factIds: [] }]);
  });

  it("uses the skeleton without calling the model when ECHO_MODEL=off", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwingFetch },
      );
      const outcome = await service.maybeGenerateStory(sessionId);
      expect(outcome.outcome).toBe("skeleton");
      expect(outcome.story?.skeleton).toBe(true);
    } finally {
      db.close();
    }
  });

  it("uses the skeleton when no API key is configured", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const { fetchImpl, calls } = stubFetchSequence([modelDraft("add a greeting line")]);
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: {} as NodeJS.ProcessEnv, fetchImpl },
      );
      const outcome = await service.maybeGenerateStory(sessionId);
      expect(outcome.outcome).toBe("skeleton");
      expect(calls()).toBe(0);
    } finally {
      db.close();
    }
  });

  it("fails closed on redaction failure without writing anything", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const { fetchImpl } = stubFetchSequence([modelDraft("add a greeting line")]);
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        {
          env: MODEL_ENV,
          fetchImpl,
          redactJsonImpl: () => {
            throw new Error("redaction down");
          },
        },
      );
      const outcome = await service.maybeGenerateStory(sessionId);
      expect(outcome.outcome).toBe("unavailable");
      expect(outcome.story).toBeNull();
      expect(
        existsSync(
          join(dataDir, "projects", "prj_story", "sessions", sessionId, ARTIFACT_FILE_NAMES.story),
        ),
      ).toBe(false);
      expect(getArtifactRef(db, sessionId, "story")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("writes a skeleton for a bare session row without snapshots", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-story-data-"));
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    try {
      upsertProject(db, { id: "prj_story", root: "/repo", name: "repo" });
      upsertSession(db, {
        id: "ses_story",
        projectId: "prj_story",
        agent: "muse",
        model: null,
        directory: "/repo",
        title: "story test",
        startedAt: ISO,
        tapePath: join(dataDir, "tape.jsonl"),
        captureQuality: "partial",
      });
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwingFetch },
      );
      const outcome = await service.maybeGenerateStory("ses_story");
      expect(outcome.outcome).toBe("skeleton");
      expect(outcome.story?.cards).toEqual([]);
      expect(outcome.story?.tapeWatermark.eventCount).toBe(0);
    } finally {
      db.close();
    }
  });
});

// --- Deterministic enrichment over engine facts (ported behaviors) ---

const SYN_SESSION = "ses_syn";
const SYN_PROJECT = "prj_syn";

function synEvent(
  seq: number,
  eventId: string,
  kind: TapeEventKind,
  payload: unknown,
  toolCallId: string | null = null,
): TapeEvent {
  const ts = `2026-10-28T12:00:${String(seq).padStart(2, "0")}.000Z`;
  return {
    v: 1,
    tape_seq: seq,
    event_id: eventId,
    record_key: null,
    session_id: SYN_SESSION,
    project_id: SYN_PROJECT,
    kind,
    ts,
    observed_at: ts,
    source: {
      agent: "muse",
      adapter: "test",
      adapter_version: "0.1.0",
      build: null,
      schema: null,
      record_type: null,
      payload_type: null,
      sequence: seq,
      durability: "memory",
      origin: "import",
    },
    links: {
      turn_id: null,
      tool_call_id: toolCallId,
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

function synAttempt(overrides: Partial<FileAttempt> & { id: string }): FileAttempt {
  return {
    path: "src/auth/login.ts",
    snapshotId: "snap1",
    commitOid: "ccc",
    trigger: "tool.post",
    eventId: null,
    takenAt: ISO,
    status: "failed",
    confidence: "exact",
    introducedLines: 4,
    survivingLines: 0,
    introducedText: [],
    replacementText: [],
    finalStart: null,
    finalEnd: null,
    detail: "attempt",
    link: { eventId: null, toolCallId: null, toolOutcome: null, turnId: null, batchId: null },
    ...overrides,
  };
}

describe("finalizeStory", () => {
  function buildScenario() {
    const tape: TapeEvent[] = [
      synEvent(1, "e-prompt", "prompt.submitted", { text: "ship the auth fix" }),
      synEvent(2, "e-docs", "tool.requested", { name: "edit", input: { path: "docs/notes.md" } }),
      synEvent(
        3,
        "e-run",
        "tool.requested",
        {
          name: "vitest",
          input: { command: "pnpm vitest" },
        },
        "tc-run",
      ),
      synEvent(
        4,
        "e-run-done",
        "tool.completed",
        {
          name: "vitest",
          exitCode: 0,
          output: "pass",
        },
        "tc-run",
      ),
      synEvent(5, "e-auth", "tool.requested", {
        name: "edit",
        input: { path: "src/auth/login.ts" },
      }),
    ];
    const hunks = [
      {
        id: "h_aaaaaaaaaaaaaaaa",
        path: "src/auth/login.ts",
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        patch: "@@ -1,2 +1,3 @@\n+const token = 1;\n+// TODO: rotate token",
        addedText: "const token = 1;\n// TODO: rotate token",
        removedText: "const old = 0;",
        addedLines: 2,
        removedLines: 1,
      },
      {
        id: "h_bbbbbbbbbbbbbbbb",
        path: "docs/notes.md",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        patch: "@@ -1 +1,2 @@\n+hello",
        addedText: "hello",
        removedText: "",
        addedLines: 1,
        removedLines: 0,
      },
    ];
    const attempts: FileAttempt[] = [
      synAttempt({ id: "att-1", eventId: "e-auth", takenAt: "2026-10-28T12:00:05.000Z" }),
      synAttempt({ id: "att-2", eventId: "e-auth", takenAt: "2026-10-28T12:00:06.000Z" }),
      synAttempt({
        id: "att-lone",
        path: "docs/other.md",
        eventId: null,
        status: "failed",
      }),
      synAttempt({
        id: "att-docs",
        path: "docs/notes.md",
        eventId: "e-docs",
        status: "landed",
        introducedLines: 1,
        survivingLines: 1,
        takenAt: "2026-10-28T12:00:02.000Z",
      }),
    ];
    const facts = extractFacts({ sessionId: SYN_SESSION, tape, hunks, attempts });
    const draft = buildSkeletonStory(facts, { generatedAt: ISO, tapeSha256: "syn-sha" }).story;
    return { tape, facts, draft };
  }

  it("adds repeated_attempt detours but not lone failures", () => {
    const { tape, facts, draft } = buildScenario();
    const story = SessionStorySchema.parse(
      finalizeStory({ facts, draft, tape, reviewDiagnostics: [], captureQuality: "full" }),
    );
    const repeated = story.detours.filter((detour) => detour.costReason === "repeated_attempt");
    expect(repeated).toHaveLength(2);
    expect(new Set(repeated.flatMap((detour) => detour.attemptIds))).toEqual(
      new Set(["att-1", "att-2"]),
    );
    expect(story.detours.some((detour) => detour.attemptIds.includes("att-lone"))).toBe(false);
  });

  it("caps the summary to one headline sentence after validation", () => {
    const { tape, facts, draft } = buildScenario();
    draft.summary =
      "Shipped the auth fix across the login flow. Cleaned up the docs. A third sentence nobody needs on a card.";
    const story = SessionStorySchema.parse(
      finalizeStory({ facts, draft, tape, reviewDiagnostics: [], captureQuality: "full" }),
    );
    expect(story.summary).toBe("Shipped the auth fix across the login flow.");
  });

  it("adds TODO and untested loose ends, blind spots stay separate", () => {
    const { tape, facts, draft } = buildScenario();
    const story = SessionStorySchema.parse(
      finalizeStory({
        facts,
        draft,
        tape,
        reviewDiagnostics: ["review_build_failed"],
        captureQuality: "partial",
      }),
    );
    const kinds = story.looseEnds.map((end) => end.kind);
    expect(kinds).toContain("todo");
    expect(kinds).not.toContain("untested");
    const todo = story.looseEnds.find((end) => end.kind === "todo");
    expect(todo?.claims[0]?.text).toContain("src/auth/login.ts");
    // Blind spots carry the capture gap + pipeline diagnostics, not loose ends.
    expect(story.blindSpots).toContain("review_build_failed");
    expect(story.blindSpots).toContain("intermediate states may not be captured");
    expect(
      story.looseEnds.every((end) => !story.blindSpots.includes(end.claims[0]?.text ?? "")),
    ).toBe(true);
  });

  it("flags untested hunks when the tape has no runs", () => {
    const tape: TapeEvent[] = [synEvent(1, "e-prompt", "prompt.submitted", { text: "fix it" })];
    const hunks = [
      {
        id: "h_cccccccccccccccc",
        path: "src/app.ts",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        patch: "@@ -1 +1,2 @@\n+x",
        addedText: "x",
        removedText: "",
        addedLines: 1,
        removedLines: 0,
      },
    ];
    const facts = extractFacts({ sessionId: SYN_SESSION, tape, hunks, attempts: [] });
    const draft = buildSkeletonStory(facts, { generatedAt: ISO, tapeSha256: "syn-sha" }).story;
    const story = SessionStorySchema.parse(
      finalizeStory({ facts, draft, tape, reviewDiagnostics: [], captureQuality: "full" }),
    );
    const untested = story.looseEnds.filter((end) => end.kind === "untested");
    expect(untested).toHaveLength(1);
    expect(untested[0]?.claims[0]?.text).toContain("src/app.ts");
    expect(untested[0]?.cardId).toBe("h_cccccccccccccccc");
    expect(untested[0]?.claims[0]?.label).toBe("observed");
  });

  it("folds untested ends for hunks without cards into one shared end", () => {
    const tape: TapeEvent[] = [synEvent(1, "e-prompt", "prompt.submitted", { text: "fix all" })];
    const hunks = Array.from({ length: 25 }, (_, index) => {
      const hex = index.toString(16).padStart(16, "0");
      return {
        id: `h_${hex}`,
        path: `src/file${index}.ts`,
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        patch: "@@ -1 +1,2 @@\n+x",
        addedText: "x",
        removedText: "",
        addedLines: 1,
        removedLines: 0,
      };
    });
    const facts = extractFacts({ sessionId: SYN_SESSION, tape, hunks, attempts: [] });
    const draft = buildSkeletonStory(facts, { generatedAt: ISO, tapeSha256: "syn-sha" }).story;
    expect(draft.cards).toHaveLength(21);
    const story = SessionStorySchema.parse(
      finalizeStory({ facts, draft, tape, reviewDiagnostics: [], captureQuality: "full" }),
    );
    const untested = story.looseEnds.filter((end) => end.kind === "untested");
    // One end per kept card plus a single end for the folded hunks.
    expect(untested).toHaveLength(21);
    const folded = untested.filter((end) => end.cardId === story.cards[20]?.id);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.claims[0]?.text).toContain("these changes");
    expect(
      untested
        .filter((end) => end !== folded[0])
        .every((end) => story.cards.slice(0, 20).some((card) => card.id === end.cardId)),
    ).toBe(true);
  });

  it("skips untested ends for mechanical hunks", () => {
    const tape: TapeEvent[] = [synEvent(1, "e-prompt", "prompt.submitted", { text: "fix it" })];
    const hunks = [
      {
        id: "h_cccccccccccccccc",
        path: "src/app.ts",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        patch: "@@ -1 +1,2 @@\n+x",
        addedText: "x",
        removedText: "",
        addedLines: 1,
        removedLines: 0,
      },
      {
        id: "h_dddddddddddddddd",
        path: "pnpm-lock.yaml",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        patch: "@@ -1 +1,2 @@\n+y",
        addedText: "y",
        removedText: "",
        addedLines: 1,
        removedLines: 0,
      },
    ];
    const facts = extractFacts({ sessionId: SYN_SESSION, tape, hunks, attempts: [] });
    const draft = buildSkeletonStory(facts, { generatedAt: ISO, tapeSha256: "syn-sha" }).story;
    // Lockfile hunk folds into the routine line, not a card.
    expect(draft.cards).toHaveLength(1);
    expect(draft.routineSummary ?? "").toContain("pnpm-lock.yaml");
    const story = SessionStorySchema.parse(
      finalizeStory({ facts, draft, tape, reviewDiagnostics: [], captureQuality: "full" }),
    );
    const untested = story.looseEnds.filter((end) => end.kind === "untested");
    expect(untested).toHaveLength(1);
    expect(untested[0]?.cardId).toBe("h_cccccccccccccccc");
  });

  it("collapses untested ends for hunks no card covers into one orphan end", () => {
    const tape: TapeEvent[] = [synEvent(1, "e-prompt", "prompt.submitted", { text: "fix it" })];
    const hunk = (id: string, path: string) => ({
      id,
      path,
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      patch: "@@ -1 +1,2 @@\n+x",
      addedText: "x",
      removedText: "",
      addedLines: 1,
      removedLines: 0,
    });
    const hunks = [
      hunk("h_eeeeeeeeeeeeeeee", "src/kept.ts"),
      hunk("h_ffffffffffffffff", "src/dropped-a.ts"),
      hunk("h_0000000000000000", "src/dropped-b.ts"),
    ];
    const facts = extractFacts({ sessionId: SYN_SESSION, tape, hunks, attempts: [] });
    const full = buildSkeletonStory(facts, { generatedAt: ISO, tapeSha256: "syn-sha" }).story;
    // Simulate a model draft that covers only the first hunk.
    const draft = { ...full, cards: full.cards.slice(0, 1) };
    const story = SessionStorySchema.parse(
      finalizeStory({ facts, draft, tape, reviewDiagnostics: [], captureQuality: "full" }),
    );
    const untested = story.looseEnds.filter((end) => end.kind === "untested");
    expect(untested).toHaveLength(2);
    const orphan = untested.filter((end) => end.cardId === null);
    expect(orphan).toHaveLength(1);
    expect(orphan[0]?.claims[0]?.text).toContain("these changes");
  });

  it("surfaces the no-surviving-attempt gap as verification context", () => {
    const { tape, facts, draft } = buildScenario();
    const story = SessionStorySchema.parse(
      finalizeStory({ facts, draft, tape, reviewDiagnostics: [], captureQuality: "full" }),
    );
    const auth = story.cards.find((card) => card.touches.includes("src/auth/login.ts"));
    expect(
      auth?.checkedBy.some(
        (claim) => claim.text === "No surviving attempt evidence for src/auth/login.ts",
      ),
    ).toBe(true);
    const note = auth?.checkedBy.find((claim) =>
      claim.text.includes("No surviving attempt evidence"),
    );
    expect(note?.label).toBe("uncertain");
    // The landed docs hunk has surviving evidence: no note there.
    const docs = story.cards.find((card) => card.touches.includes("docs/notes.md"));
    expect(
      docs?.checkedBy.some((claim) => claim.text.includes("No surviving attempt evidence")),
    ).toBe(false);
  });

  it("ranks by risk while sessionOrder stays chronological", () => {
    const { tape, facts, draft } = buildScenario();
    const story = SessionStorySchema.parse(
      finalizeStory({ facts, draft, tape, reviewDiagnostics: [], captureQuality: "full" }),
    );
    const byId = new Map(story.cards.map((card) => [card.id, card]));
    // Auth hunk carries blast flags: riskiest first.
    expect(byId.get("h_aaaaaaaaaaaaaaaa")?.rank).toBe(1);
    expect(byId.get("h_bbbbbbbbbbbbbbbb")?.rank).toBe(2);
    // Docs attempt landed earlier on the tape: chronological first.
    expect(byId.get("h_bbbbbbbbbbbbbbbb")?.sessionOrder).toBe(0);
    expect(byId.get("h_aaaaaaaaaaaaaaaa")?.sessionOrder).toBe(1);
  });
});

describe("session title stability", () => {
  function titledDraft(summary: string): SessionStory {
    return { ...modelDraft("add a greeting line"), summary };
  }

  function growTape(
    db: ReturnType<typeof openEchoDb>,
    sessionId: string,
    projectId: string,
    eventId: string,
  ) {
    appendEvents(db, sessionId, [
      seedTapeEvent(sessionId, projectId, eventId, "prompt.submitted", {
        text: "keep going",
      }),
    ]);
  }

  it("keeps the first model summary on regen while other details refresh", async () => {
    const { dataDir, db, sessionId, projectId } = await seedSession();
    try {
      const { fetchImpl, calls } = stubFetchSequence([
        titledDraft("First title"),
        titledDraft("Second title"),
      ]);
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const first = await service.maybeGenerateStory(sessionId);
      expect(first.outcome).toBe("generated");
      expect(first.story?.summary).toBe("First title");

      growTape(db, sessionId, projectId, "evt_late_title");
      const second = await service.maybeGenerateStory(sessionId);
      // Regen ran against the new tape...
      expect(second.outcome).toBe("generated");
      expect(calls()).toBe(2);
      expect(second.story?.tapeWatermark.eventCount).toBeGreaterThan(
        first.story?.tapeWatermark.eventCount ?? 0,
      );
      // ...but the title is frozen while the rest follows the fresh draft.
      expect(second.story?.summary).toBe("First title");
      expect(second.story?.shortVersion.map((claim) => claim.text)).toEqual([
        "add a greeting line",
      ]);
      expect(getSessionSummary(db, sessionId)?.summary).toBe("First title");
      const ref = getArtifactRef(db, sessionId, "story");
      expect(JSON.parse(readFileSync(ref?.path ?? "", "utf8")).summary).toBe("First title");
    } finally {
      db.close();
    }
  });

  it("caps an over-long model summary before storing it", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const long =
        "Separated project workspace into overview learn and architecture areas with code index and generated project summary and tech stack alongside ingest hardening and follow-up fixes";
      const { fetchImpl } = stubFetchSequence([titledDraft(long)]);
      const service = createStoryService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const outcome = await service.maybeGenerateStory(sessionId);
      expect(outcome.outcome).toBe("generated");
      expect(outcome.story?.summary).toBe(capStorySummary(long));
      expect(getSessionSummary(db, sessionId)?.summary).toBe(capStorySummary(long));
      const ref = getArtifactRef(db, sessionId, "story");
      expect(JSON.parse(readFileSync(ref?.path ?? "", "utf8")).summary).toBe(capStorySummary(long));
    } finally {
      db.close();
    }
  });

  it("lets the first model narration replace a skeleton title, then freezes", async () => {
    const { dataDir, db, sessionId, projectId } = await seedSession();
    try {
      const skeletonService = createStoryService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwingFetch },
      );
      const skeleton = await skeletonService.maybeGenerateStory(sessionId);
      expect(skeleton.outcome).toBe("skeleton");
      const skeletonSummary = skeleton.story?.summary;
      expect(typeof skeletonSummary).toBe("string");

      const { fetchImpl } = stubFetchSequence([
        titledDraft("Real model title"),
        titledDraft("Renamed title"),
      ]);
      const modelService = createStoryService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      growTape(db, sessionId, projectId, "evt_late_upgrade");
      const upgraded = await modelService.maybeGenerateStory(sessionId);
      expect(upgraded.outcome).toBe("generated");
      expect(upgraded.story?.summary).toBe("Real model title");

      growTape(db, sessionId, projectId, "evt_late_rename");
      const renamed = await modelService.maybeGenerateStory(sessionId);
      expect(renamed.outcome).toBe("generated");
      expect(renamed.story?.summary).toBe("Real model title");
      expect(getSessionSummary(db, sessionId)?.summary).toBe("Real model title");
    } finally {
      db.close();
    }
  });
});

describe("empty session filtering", () => {
  function emptySkeleton(): SessionStory {
    return {
      ...modelDraft("unused"),
      skeleton: true,
      generator: { kind: "skeleton", model: null, promptVersion: SKELETON_PROMPT_VERSION },
      summary: "No prompts recorded, no file changes recorded.",
      shortVersion: [],
      askVsResult: { asked: [], delivered: [], extras: [], missing: [] },
    };
  }

  function writeStoryArtifact(
    db: ReturnType<typeof openEchoDb>,
    dataDir: string,
    sessionId: string,
    story: SessionStory,
    generator: string,
  ): void {
    const path = join(dataDir, `${sessionId}.story.json`);
    writeFileSync(path, `${JSON.stringify(story)}\n`);
    upsertArtifactRef(db, {
      sessionId,
      kind: "story",
      path,
      tapeWatermark: { eventCount: 0, sha256: "empty" },
      generator,
      generatedAt: ISO,
    });
  }

  function seedBareSession(
    db: ReturnType<typeof openEchoDb>,
    projectId: string,
    root: string,
    dataDir: string,
    sessionId: string,
  ): void {
    upsertSession(db, {
      id: sessionId,
      projectId,
      agent: "opencode",
      model: null,
      directory: root,
      title: null,
      startedAt: ISO,
      tapePath: join(dataDir, `${sessionId}.jsonl`),
      captureQuality: "import_only",
    });
  }

  it("treats only content-free skeletons as empty", () => {
    expect(storyHasContent(emptySkeleton())).toBe(false);
    expect(
      storyHasContent({
        ...emptySkeleton(),
        shortVersion: [{ text: "did a thing", label: "observed", factIds: ["F1"] }],
      }),
    ).toBe(true);
    expect(
      storyHasContent({
        ...emptySkeleton(),
        askVsResult: {
          asked: [{ text: "do a thing", label: "observed", factIds: ["F1"] }],
          delivered: [],
          extras: [],
          missing: [],
        },
      }),
    ).toBe(true);
    // A model narration always counts, even with no cards.
    expect(storyHasContent(modelDraft("add a greeting line"))).toBe(true);
  });

  it("drops content-free skeletons but keeps recording and meaningful sessions", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-story-filter-data-"));
    const root = mkdtempSync(join(tmpdir(), "echo-story-filter-root-"));
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    try {
      const projectId = "prj_filter";
      upsertProject(db, { id: projectId, root, name: "filter" });
      seedBareSession(db, projectId, root, dataDir, "ses_empty");
      seedBareSession(db, projectId, root, dataDir, "ses_full");
      seedBareSession(db, projectId, root, dataDir, "ses_recording");
      writeStoryArtifact(db, dataDir, "ses_empty", emptySkeleton(), SKELETON_PROMPT_VERSION);
      writeStoryArtifact(db, dataDir, "ses_full", modelDraft("add a greeting line"), "test-model");

      const ids = filterEmptySessions(db, listSessions(db, projectId)).map((session) => session.id);
      expect(ids.sort()).toEqual(["ses_full", "ses_recording"]);
    } finally {
      db.close();
    }
  });

  it("keeps sessions whose story artifact is missing or unreadable", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-story-filter-read-"));
    const root = mkdtempSync(join(tmpdir(), "echo-story-filter-readroot-"));
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    try {
      const projectId = "prj_filter";
      upsertProject(db, { id: projectId, root, name: "filter" });
      seedBareSession(db, projectId, root, dataDir, "ses_broken");
      const brokenPath = join(dataDir, "ses_broken.story.json");
      writeFileSync(brokenPath, "not json\n");
      upsertArtifactRef(db, {
        sessionId: "ses_broken",
        kind: "story",
        path: brokenPath,
        tapeWatermark: { eventCount: 0, sha256: "broken" },
        generator: SKELETON_PROMPT_VERSION,
        generatedAt: ISO,
      });
      // Also points at a file that does not exist.
      seedBareSession(db, projectId, root, dataDir, "ses_gone");
      upsertArtifactRef(db, {
        sessionId: "ses_gone",
        kind: "story",
        path: join(dataDir, "missing.story.json"),
        tapeWatermark: { eventCount: 0, sha256: "gone" },
        generator: SKELETON_PROMPT_VERSION,
        generatedAt: ISO,
      });

      const ids = filterEmptySessions(db, listSessions(db, projectId)).map((session) => session.id);
      expect(ids.sort()).toEqual(["ses_broken", "ses_gone"]);
    } finally {
      db.close();
    }
  });
});

describe("story quiet gate", () => {
  const T1 = Date.parse("2026-10-29T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  function markAllEventsRecent(db: ReturnType<typeof openEchoDb>, sessionId: string, atMs: number) {
    db.prepare("UPDATE events SET observed_at = ? WHERE session_id = ?").run(iso(atMs), sessionId);
  }

  it("isSessionQuiet treats missing or corrupt timestamps as quiet", () => {
    expect(isSessionQuiet(null, T1)).toBe(true);
    expect(isSessionQuiet("not-a-timestamp", T1)).toBe(true);
    expect(isSessionQuiet(iso(T1 - 61_000), T1)).toBe(true);
    expect(isSessionQuiet(iso(T1 - 60_000), T1)).toBe(true);
    expect(isSessionQuiet(iso(T1 - 59_000), T1)).toBe(false);
    expect(isSessionQuiet(iso(T1 - 59_000), T1, 30_000)).toBe(true);
    expect(isSessionQuiet(iso(T1 - 29_000), T1, 30_000)).toBe(false);
    expect(isSessionQuiet(iso(T1 - 31_000), T1, 30_000)).toBe(true);
    expect(STORY_QUIET_MS).toBe(60_000);
  });

  it("reports waiting with nothing to show when an active session has no story yet", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      markAllEventsRecent(db, sessionId, T1);
      const waiting = createStoryService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwingFetch, clock: () => new Date(T1) },
      );
      const outcome = await waiting.maybeGenerateStory(sessionId);
      expect(outcome.outcome).toBe("waiting");
      expect(outcome.story).toBeNull();
      // A minute of silence later, the same session generates normally.
      const quiet = createStoryService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwingFetch, clock: () => new Date(T1 + 61_000) },
      );
      expect((await quiet.maybeGenerateStory(sessionId)).outcome).toBe("skeleton");
    } finally {
      db.close();
    }
  });

  it("serves the previous artifact as waiting while the session is active", async () => {
    const { dataDir, db, sessionId, projectId } = await seedSession();
    try {
      const firstService = createStoryService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwingFetch },
      );
      const first = await firstService.maybeGenerateStory(sessionId, { reason: "finalize" });
      expect(first.outcome).toBe("skeleton");
      const summary = first.story?.summary;
      expect(typeof summary).toBe("string");
      // New tape activity right now: watermark moved but the session is loud.
      appendEvents(db, sessionId, [
        seedTapeEvent(sessionId, projectId, "evt_loud", "prompt.submitted", { text: "keep going" }),
      ]);
      markAllEventsRecent(db, sessionId, Date.now());
      const second = await firstService.maybeGenerateStory(sessionId);
      expect(second.outcome).toBe("waiting");
      expect(second.story?.summary).toBe(summary);
      expect(getSessionSummary(db, sessionId)?.summary).toBe(summary);
    } finally {
      db.close();
    }
  });
});
