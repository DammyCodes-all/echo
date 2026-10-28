import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStory, TapeEvent, TapeEventKind } from "@echo/contracts";
import {
  getArtifactRef,
  getSessionSummary,
  openEchoDb,
  upsertProject,
  upsertSession,
} from "@echo/db";
import { describe, expect, it } from "vitest";
import { createStoryService, type GatheredInputs, sessionStoryPath } from "./story-generate";

const PROJECT_ID = "prj_story";
const SESSION_ID = "ses_story";
const ENV = { META_API_KEY: "test-key", META_MODEL_ID: "test-model" } as NodeJS.ProcessEnv;

function makeEvent(seq: number, kind: TapeEventKind, payload: unknown): TapeEvent {
  const ts = `2026-10-28T12:00:${String(seq).padStart(2, "0")}.000Z`;
  return {
    v: 1,
    tape_seq: seq,
    event_id: `story-${seq}`,
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

function stubGather(overrides: Partial<GatheredInputs> = {}): () => Promise<GatheredInputs> {
  return async () => ({
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    tape: [makeEvent(1, "prompt.submitted", { text: "Do the thing" })],
    hunks: [],
    attempts: [],
    rawEventCount: 1,
    tapeSha256: "abc123",
    tapeCapped: false,
    tapeMissing: false,
    ...overrides,
  });
}

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

function minimalDraft(overrides: Partial<SessionStory> = {}): SessionStory {
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    generatedAt: "2026-10-28T12:00:00.000Z",
    generator: { kind: "model", model: "test-model", promptVersion: "story-v1" },
    tapeWatermark: { eventCount: 1, sha256: "abc123" },
    summary: "Did the thing.",
    skeleton: false,
    shortVersion: [{ text: "Do the thing", label: "observed", factIds: ["F1"] }],
    askVsResult: { asked: [], delivered: [], extras: [], missing: [] },
    cards: [],
    routineSummary: null,
    detours: [],
    looseEnds: [],
    blindSpots: [],
    gaps: [],
    verifiedCounts: { observed: 0, partlyObserved: 0, agentStated: 0, nothing: 0, total: 0 },
    ...overrides,
  };
}

function seedDb(dataDir: string) {
  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  upsertProject(db, { id: PROJECT_ID, root: "/repo", name: "repo" });
  upsertSession(db, {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    agent: "muse",
    model: "test",
    directory: "/repo",
    title: "story test",
    startedAt: "2026-10-28T12:00:00.000Z",
    tapePath: join(dataDir, "tape.jsonl"),
    captureQuality: "partial",
  });
  return db;
}

describe("createStoryService", () => {
  it("returns not_found for an unknown session", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-story-data-"));
    const db = seedDb(dataDir);
    const service = createStoryService(db, {
      dataDir,
      env: ENV,
      gatherInputs: async () => null,
    });
    const outcome = await service.generateStory("ses_missing");
    expect(outcome.status).toBe("not_found");
    expect(outcome.story).toBeNull();
    db.close();
  });

  it("generates from the model and persists artifact, ref and inbox columns", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-story-data-"));
    const db = seedDb(dataDir);
    const { fetchImpl, calls, bodies } = stubFetchSequence([minimalDraft()]);
    const service = createStoryService(db, {
      dataDir,
      env: ENV,
      fetchImpl,
      gatherInputs: stubGather(),
      clock: () => new Date("2026-10-28T13:00:00.000Z"),
    });
    const outcome = await service.generateStory(SESSION_ID);
    expect(outcome.status).toBe("generated");
    expect(outcome.generator).toBe("story-v1");
    expect(calls()).toBe(1);
    expect(bodies()[0]).toContain("story-v1");
    const storyPath = sessionStoryPath(dataDir, PROJECT_ID, SESSION_ID);
    expect(outcome.path).toBe(storyPath);
    expect(existsSync(storyPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(storyPath, "utf8")) as SessionStory;
    expect(onDisk.tapeWatermark).toEqual({ eventCount: 1, sha256: "abc123" });
    expect(onDisk.generator).toMatchObject({ kind: "model", promptVersion: "story-v1" });
    const ref = getArtifactRef(db, SESSION_ID, "story");
    expect(ref).toMatchObject({ path: storyPath, generator: "story-v1" });
    expect(ref?.tapeWatermark).toEqual({ eventCount: 1, sha256: "abc123" });
    const summary = getSessionSummary(db, SESSION_ID);
    expect(summary?.summary).toBe("Did the thing.");
    expect(summary?.highRiskCount).toBe(0);
    db.close();
  });

  it("regenerates once for failed claims, then ships the fix", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-story-data-"));
    const db = seedDb(dataDir);
    const bad = minimalDraft({
      shortVersion: [{ text: "Does 99 things", label: "observed", factIds: ["F1"] }],
    });
    const fixed = minimalDraft({
      shortVersion: [{ text: "Do the thing", label: "observed", factIds: ["F1"] }],
    });
    const { fetchImpl, calls, bodies } = stubFetchSequence([bad, fixed]);
    const service = createStoryService(db, {
      dataDir,
      env: ENV,
      fetchImpl,
      gatherInputs: stubGather(),
    });
    const outcome = await service.generateStory(SESSION_ID);
    expect(outcome.status).toBe("generated");
    expect(calls()).toBe(2);
    expect(bodies()[1]).toContain("failed these checks");
    expect(outcome.story?.shortVersion.map((claim) => claim.text)).toEqual(["Do the thing"]);
    expect(outcome.story?.gaps).toEqual([]);
    expect(outcome.diagnostics.join(" ")).toContain("story_claims_failed:1");
    db.close();
  });

  it("drops still-failing claims to gap lines after regeneration", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-story-data-"));
    const db = seedDb(dataDir);
    const bad = minimalDraft({
      shortVersion: [{ text: "Does 99 things", label: "observed", factIds: ["F1"] }],
    });
    const { fetchImpl, calls } = stubFetchSequence([bad, bad]);
    const service = createStoryService(db, {
      dataDir,
      env: ENV,
      fetchImpl,
      gatherInputs: stubGather(),
    });
    const outcome = await service.generateStory(SESSION_ID);
    expect(outcome.status).toBe("generated");
    expect(calls()).toBe(2);
    expect(outcome.story?.shortVersion).toEqual([]);
    expect(outcome.story?.gaps).toEqual(["Echo couldn't verify this: Does 99 things"]);
    expect(outcome.diagnostics.join(" ")).toContain("story_dropped_claims:1");
    db.close();
  });

  it("falls back to the skeleton when the model output is schema-invalid", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-story-data-"));
    const db = seedDb(dataDir);
    const { fetchImpl } = stubFetchSequence([{ nope: true }]);
    const service = createStoryService(db, {
      dataDir,
      env: ENV,
      fetchImpl,
      gatherInputs: stubGather(),
    });
    const outcome = await service.generateStory(SESSION_ID);
    expect(outcome.status).toBe("degraded");
    expect(outcome.story?.skeleton).toBe(true);
    expect(outcome.generator).toBe("skeleton-v1");
    expect(outcome.diagnostics.join(" ")).toContain("model_unavailable_skeleton:invalid_response");
    db.close();
  });

  it("uses the skeleton without calling the model when ECHO_MODEL=off", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-story-data-"));
    const db = seedDb(dataDir);
    const { fetchImpl, calls } = stubFetchSequence([minimalDraft()]);
    const service = createStoryService(db, {
      dataDir,
      env: { ...ENV, ECHO_MODEL: "off" },
      fetchImpl,
      gatherInputs: stubGather(),
    });
    const outcome = await service.generateStory(SESSION_ID);
    expect(outcome.status).toBe("degraded");
    expect(outcome.story?.skeleton).toBe(true);
    expect(calls()).toBe(0);
    expect(outcome.diagnostics).toContain("model_off_skeleton");
    db.close();
  });

  it("uses the skeleton when no API key is configured", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-story-data-"));
    const db = seedDb(dataDir);
    const { fetchImpl, calls } = stubFetchSequence([minimalDraft()]);
    const service = createStoryService(db, {
      dataDir,
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
      gatherInputs: stubGather(),
    });
    const outcome = await service.generateStory(SESSION_ID);
    expect(outcome.status).toBe("degraded");
    expect(calls()).toBe(0);
    expect(outcome.diagnostics.join(" ")).toContain("model_unavailable_skeleton:missing_api_key");
    db.close();
  });

  it("fails closed on redaction failure without writing anything", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-story-data-"));
    const db = seedDb(dataDir);
    const { fetchImpl } = stubFetchSequence([minimalDraft()]);
    const service = createStoryService(db, {
      dataDir,
      env: ENV,
      fetchImpl,
      gatherInputs: stubGather(),
      redactJsonImpl: () => {
        throw new Error("redaction down");
      },
    });
    const outcome = await service.generateStory(SESSION_ID);
    expect(outcome.status).toBe("failed");
    expect(outcome.story).toBeNull();
    expect(outcome.diagnostics).toContain("story_redaction_failed");
    expect(existsSync(sessionStoryPath(dataDir, PROJECT_ID, SESSION_ID))).toBe(false);
    expect(getArtifactRef(db, SESSION_ID, "story")).toBeNull();
    db.close();
  });

  it("gathers from a bare session row without snapshots or tape file", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-story-data-"));
    const db = seedDb(dataDir);
    const service = createStoryService(db, {
      dataDir,
      env: { ...ENV, ECHO_MODEL: "off" },
    });
    const outcome = await service.generateStory(SESSION_ID);
    expect(outcome.status).toBe("degraded");
    expect(outcome.story?.cards).toEqual([]);
    expect(outcome.story?.tapeWatermark.eventCount).toBe(0);
    expect(outcome.diagnostics).toContain("tape_file_missing");
    db.close();
  });
});
