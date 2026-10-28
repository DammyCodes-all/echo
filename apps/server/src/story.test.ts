import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStorySchema, type TapeEvent } from "@echo/contracts";
import {
  appendEvents,
  getArtifactRef,
  getSessionSummary,
  insertSnapshot,
  openEchoDb,
  readAllEvents,
  setSessionCheckStatus,
  upsertProject,
  upsertSession,
} from "@echo/db";
import type { SnapshotResult } from "@echo/snapshots";
import { snapshotWorkingTree } from "@echo/snapshots";
import { describe, expect, it } from "vitest";
import { assignSessionOrder, createStoryService, validateDraft } from "./story";
import { computeWatermark, type FactSet, type StoryFact } from "./story-facts";
import { makeSnapshotEvent } from "./tape-events";

const TAKEN_AT = new Date("2026-10-28T10:00:00.000Z");
const ISO = TAKEN_AT.toISOString();
const OFF_ENV = { ...process.env, ECHO_MODEL: "off" } as NodeJS.ProcessEnv;
const silentLog = { info: () => {}, error: () => {} };
const throwingFetch = (() => {
  throw new Error("network used");
}) as unknown as typeof fetch;

function fact(overrides: Partial<StoryFact> & { id: string }): StoryFact {
  return {
    kind: "hunk",
    summary: "",
    eventIds: [],
    files: [],
    riskFlags: [],
    riskReasons: [],
    verification: "nothing",
    testedByRunIds: [],
    ...overrides,
  };
}

function baseFacts(): FactSet {
  return {
    sessionId: "s1",
    promptClusters: [{ id: "P1", promptEventId: "e0", text: "fix billing retry", index: 0 }],
    facts: [
      fact({
        id: "H1",
        kind: "hunk",
        summary: "billing/retry.ts: +12 −3 around charge",
        eventIds: ["e1"],
        files: ["billing/retry.ts"],
        riskFlags: ["payments"],
        riskReasons: ["touches payment code (billing/retry.ts)"],
        testedByRunIds: ["R1"],
      }),
      fact({
        id: "R1",
        kind: "run",
        summary: "ran pnpm vitest billing/retry.ts (exit 0, observed pass)",
        eventIds: ["e2"],
      }),
    ],
    routineFactIds: [],
  };
}

function validCard(overrides: Record<string, unknown> = {}) {
  return {
    headline: "Retry billing charges",
    constituentHunkIds: ["H1"],
    constituentActionIds: [],
    why: [{ text: "observed pass via billing run", label: "observed", factIds: ["R1"] }],
    before: [],
    now: [{ text: "billing/retry.ts retry changed", label: "observed", factIds: ["H1"] }],
    ...overrides,
  };
}

function validDraft(overrides: Record<string, unknown> = {}) {
  return {
    summary: "Retry billing charges.",
    shortVersion: [
      { text: "billing/retry.ts retry changed", label: "observed", factIds: ["H1"] },
      { text: "retried 42 times", label: "observed", factIds: ["H1"] },
      { text: "also touched src/evil.ts", label: "observed", factIds: ["H1"] },
    ],
    askVsResult: {
      asked: [{ text: "fix billing retry", label: "agent_stated", factIds: ["P1"] }],
      delivered: [],
      extras: [],
      missing: [],
    },
    cards: [validCard()],
    ...overrides,
  };
}

describe("validateDraft", () => {
  it("drops invented-number and invented-file claims but keeps valid ones", () => {
    const result = validateDraft(validDraft(), baseFacts());
    expect(result.valid).toBe(true);
    expect(result.story?.shortVersion).toHaveLength(1);
    expect(result.story?.shortVersion[0]).toMatchObject({ factIds: ["H1"] });
    expect(result.dropped).toHaveLength(2);
    expect(result.dropped.join("\n")).toMatch(/42/);
    expect(result.dropped.join("\n")).toMatch(/src\/evil\.ts/);
    expect(result.dropped.every((line) => line.startsWith("Echo couldn't verify this: "))).toBe(
      true,
    );
    // Surviving claims only: asked keeps the grounded prompt quote.
    expect(result.story?.askVsResult.asked).toHaveLength(1);
  });

  it("never lets the model upgrade verification", () => {
    const result = validateDraft(validDraft(), baseFacts());
    const card = result.story?.cards[0];
    expect(card?.verification).toBe("nothing");
    expect(card?.highRisk).toBe(true);
    expect(card?.riskReasons).toContain("no observed test run covers this change");
    expect(card?.riskReasons).toContain(
      "touches payment code — confirm retry counts and idempotency",
    );
    // checkedBy keeps the run-fact claim that passes the token check.
    expect(card?.checkedBy).toHaveLength(1);
  });

  it("rolls risk up as the max constituent with plain sentences", () => {
    const facts = baseFacts();
    facts.facts.push(
      fact({
        id: "H2",
        kind: "hunk",
        summary: "src/auth/session.ts: +5 −1 around token",
        files: ["src/auth/session.ts"],
        riskFlags: ["auth", "destructive"],
        riskReasons: [],
        verification: "partly_observed",
      }),
    );
    const draft = validDraft({
      cards: [validCard({ constituentHunkIds: ["H1", "H2"] })],
    });
    const result = validateDraft(draft, facts);
    const card = result.story?.cards[0];
    // Weakest constituent wins: H1 is nothing.
    expect(card?.verification).toBe("nothing");
    expect(card?.highRisk).toBe(true);
    expect(card?.riskReasons).toEqual(
      expect.arrayContaining([
        "touches payment code — confirm retry counts and idempotency",
        "touches auth code — confirm login and session behavior is unchanged",
        "looks destructive — confirm nothing needed is deleted or revoked",
        "no observed test run covers this change",
      ]),
    );
    expect(card?.touches).toEqual(
      expect.arrayContaining(["billing/retry.ts", "src/auth/session.ts"]),
    );
  });

  it("rejects structural failures and drafts with zero surviving cards", () => {
    expect(validateDraft({}, baseFacts()).valid).toBe(false);
    expect(validateDraft({ summary: "x" }, baseFacts()).valid).toBe(false);
    const noCards = validateDraft(
      validDraft({ cards: [validCard({ constituentHunkIds: ["NOPE"] })] }),
      baseFacts(),
    );
    expect(noCards.valid).toBe(false);
    expect(noCards.story).toBeNull();
  });

  it("applies the detour inclusion rule", () => {
    const attempt = (id: string, status: string, path: string): StoryFact =>
      fact({
        id,
        kind: "attempt",
        summary: `attempt ${id} on ${path}`,
        files: [path],
        riskFlags: [`attempt-status:${status}`],
      });
    const facts = baseFacts();
    facts.facts.push(
      attempt("T1", "failed_with_side_effect", "a.ts"),
      attempt("T2", "reverted", "b.ts"),
      attempt("T3", "failed", "c.ts"),
      attempt("T4", "failed", "d.ts"),
      attempt("T5", "failed", "d.ts"),
    );
    const result = validateDraft(validDraft(), facts);
    expect(result.valid).toBe(true);
    const byId = new Map((result.story?.detours ?? []).map((detour) => [detour.id, detour]));
    expect(byId.get("T1")?.costReason).toBe("side_effect");
    expect(byId.get("T2")?.costReason).toBe("reverted");
    expect(byId.has("T3")).toBe(false);
    expect(byId.get("T4")?.costReason).toBe("repeated_attempt");
    expect(byId.get("T5")?.costReason).toBe("repeated_attempt");
  });

  it("drops claims that reference unknown fact ids", () => {
    const draft = validDraft({
      shortVersion: [
        { text: "billing/retry.ts retry changed", label: "observed", factIds: ["H1"] },
        { text: "billing/retry.ts also fixed elsewhere", label: "observed", factIds: ["H99"] },
      ],
    });
    const result = validateDraft(draft, baseFacts());
    expect(result.valid).toBe(true);
    expect(result.story?.shortVersion).toHaveLength(1);
    expect(result.errors.join("\n")).toMatch(/H99/);
  });

  it("scopes checkedBy to runs linked from the card's own hunks", () => {
    const facts = baseFacts();
    facts.facts.push(
      fact({
        id: "R2",
        kind: "run",
        summary: "ran pnpm vitest other.ts (exit 0, observed pass)",
        eventIds: ["e9"],
      }),
    );
    const draft = validDraft({
      cards: [
        validCard({
          why: [
            { text: "observed pass via billing run", label: "observed", factIds: ["R1"] },
            { text: "observed pass via other run", label: "observed", factIds: ["R2"] },
          ],
        }),
      ],
    });
    const result = validateDraft(draft, facts);
    // R1 is linked from H1's testedByRunIds; R2 is a real run fact but tested
    // nothing on this card, so it stays in `why` yet out of `checkedBy`.
    expect(result.story?.cards[0]?.checkedBy).toHaveLength(1);
    expect(result.story?.cards[0]?.checkedBy[0]).toMatchObject({ factIds: ["R1"] });
    expect(result.story?.cards[0]?.why).toHaveLength(2);
  });

  it("assigns chronological sessionOrder independent of risk rank", () => {
    const facts = baseFacts();
    facts.facts.push(
      fact({
        id: "H2",
        kind: "hunk",
        summary: "docs/readme.md: +2 −0 typo fix",
        eventIds: ["e3"],
        files: ["docs/readme.md"],
      }),
    );
    const draft = validDraft({
      cards: [
        validCard(),
        {
          headline: "Fix docs typo",
          constituentHunkIds: ["H2"],
          constituentActionIds: [],
          why: [],
          before: [],
          now: [],
        },
      ],
    });
    const result = validateDraft(draft, facts);
    expect(result.valid).toBe(true);
    // Risk order: payments card first. Chronology: H2 (e3) before H1 (e10).
    const ordered = assignSessionOrder(result.story?.cards ?? [], facts, [
      { event_id: "e10", tape_seq: 10 },
      { event_id: "e3", tape_seq: 3 },
    ]);
    const byHeadline = new Map(ordered.map((card) => [card.headline, card]));
    expect(ordered[0]?.headline).toBe("Retry billing charges");
    expect(ordered[0]?.rank).toBe(1);
    expect(byHeadline.get("Retry billing charges")?.sessionOrder).toBe(1);
    expect(byHeadline.get("Fix docs typo")?.sessionOrder).toBe(0);
  });
});

// --- Integration: seeded session, ECHO_MODEL=off (no network) ---

function tapeEvent(
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
    tapeEvent(sessionId, projectId, "evt_prompt", "prompt.submitted", {
      text: "add a greeting line",
    }),
    tapeEvent(sessionId, projectId, "evt_run", "tool.completed", {
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
        promptVersion: "skeleton-v1",
      });
      expect(story.cards).toHaveLength(1);
      expect(story.summary).toBe("add a greeting line");
      expect(story.blindSpots).toContain("intermediate states may not be captured");

      const ref = getArtifactRef(db, sessionId, "story");
      expect(ref?.generator).toBe("skeleton-v1");
      expect(ref?.path).toBe(
        join(dataDir, "projects", "prj_story", "sessions", sessionId, "artifacts", "story.json"),
      );
      expect(existsSync(ref?.path ?? "")).toBe(true);
      expect(JSON.parse(readFileSync(ref?.path ?? "", "utf8"))).toEqual(first.story);
      expect(ref?.tapeWatermark).toEqual(computeWatermark(readAllEvents(db, sessionId)));

      const summary = getSessionSummary(db, sessionId);
      expect(summary?.summary).toBe("add a greeting line");
      expect(summary?.highRiskCount).toBe(0);

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
        tapeEvent(sessionId, projectId, "evt_late", "tool.completed", {
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
});
