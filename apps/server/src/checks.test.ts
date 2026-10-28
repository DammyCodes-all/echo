import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvents, insertSnapshot, openEchoDb, upsertProject, upsertSession } from "@echo/db";
import type { SnapshotResult } from "@echo/snapshots";
import { snapshotWorkingTree } from "@echo/snapshots";
import { describe, expect, it } from "vitest";
import { createChecksService } from "./checks";
import { makeSnapshotEvent } from "./tape-events";

const TAKEN_AT = new Date("2026-10-28T10:00:00.000Z");
const ENV = { META_API_KEY: "test-key", META_MODEL_ID: "test-model" } as NodeJS.ProcessEnv;
const sandboxRunner = async () => ({ status: "ok" as const, stdout: "" });

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
  const dataDir = mkdtempSync(join(tmpdir(), "echo-checks-data-"));
  const root = mkdtempSync(join(tmpdir(), "echo-checks-root-"));
  const projectId = "prj_checks";
  const sessionId = "ses_checks";
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
  const middle = await takeSnapshot({
    dataDir,
    root,
    sessionId,
    projectId,
    trigger: "tool.post",
    eventId: "evt_mid",
  });
  writeFileSync(join(root, "notes.txt"), "a\nc\n");
  const final = await takeSnapshot({
    dataDir,
    root,
    sessionId,
    projectId,
    trigger: "final",
    eventId: "evt_final",
  });

  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  upsertProject(db, { id: projectId, root, name: "checks" });
  upsertSession(db, {
    id: sessionId,
    projectId,
    agent: "opencode",
    model: null,
    directory: root,
    title: "checks",
    startedAt: TAKEN_AT.toISOString(),
    tapePath: join(dataDir, "tape.jsonl"),
    captureQuality: "partial",
  });
  for (const snapshot of [baseline, middle, final]) {
    insertSnapshot(db, {
      id: snapshot.commitOid,
      sessionId,
      commitOid: snapshot.commitOid,
      parentOid: snapshot.parentOid,
      trigger: snapshot.trigger,
      eventId:
        snapshot.trigger === "baseline"
          ? "evt_base"
          : snapshot.trigger === "final"
            ? "evt_final"
            : "evt_mid",
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
    makeSnapshotEvent({
      agent: "opencode",
      sessionId,
      projectId,
      eventId: "evt_base",
      observedAt: TAKEN_AT.toISOString(),
      result: baseline,
    }),
    makeSnapshotEvent({
      agent: "opencode",
      sessionId,
      projectId,
      eventId: "evt_mid",
      observedAt: TAKEN_AT.toISOString(),
      result: middle,
    }),
    makeSnapshotEvent({
      agent: "opencode",
      sessionId,
      projectId,
      eventId: "evt_final",
      observedAt: TAKEN_AT.toISOString(),
      result: final,
    }),
  ]);
  return { dataDir, db, projectId, sessionId };
}

function stubFetch(reply: unknown) {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      { headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
}

describe("createChecksService", () => {
  it("returns 404 for unknown sessions and checks", async () => {
    const { dataDir, db } = await seedSession();
    try {
      const service = createChecksService(db, dataDir, { env: ENV, sandboxRunner });
      expect(
        (await service.generate("ses_missing", { limit: 3, opened: [], waived: [] })).status,
      ).toBe(404);
      expect(
        (await service.answer("chk_missing", { confidence: "certain", answer: "x" })).status,
      ).toBe(404);
      expect((await service.sessionChecks("ses_missing")).status).toBe(404);
      expect((await service.report("ses_missing")).status).toBe(404);
    } finally {
      db.close();
    }
  });

  it("generates a decision check for the hunk with a replaced attempt", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const service = createChecksService(db, dataDir, { env: ENV, sandboxRunner });
      const outcome = await service.generate(sessionId, { limit: 3, opened: [], waived: [] });
      expect(outcome.status).toBe(200);
      const body = outcome.body as {
        checks: Array<{ id: string; kind: string; hunkId: string; rubric: string[] }>;
        dropped: unknown[];
      };
      expect(body.checks).toHaveLength(1);
      expect(body.checks[0]?.kind).toBe("decision");
      expect(body.checks[0]?.rubric).toHaveLength(3);
      expect(body.dropped).toHaveLength(0);

      // Regeneration is deterministic: same check id, attempts preserved.
      const again = (
        await service.generate(sessionId, {
          limit: 3,
          opened: [body.checks[0]?.hunkId ?? ""],
          waived: [],
        })
      ).body as typeof body;
      expect(again.checks.map((check) => check.id)).toEqual(body.checks.map((check) => check.id));
    } finally {
      db.close();
    }
  });

  it("drops waived hunks instead of asking about them", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const service = createChecksService(db, dataDir, { env: ENV, sandboxRunner });
      const first = (await service.generate(sessionId, { limit: 3, opened: [], waived: [] }))
        .body as {
        checks: Array<{ hunkId: string }>;
      };
      const hunkId = first.checks[0]?.hunkId;
      if (!hunkId) throw new Error("expected a check");
      const waived = (await service.generate(sessionId, { limit: 3, opened: [], waived: [hunkId] }))
        .body as {
        checks: unknown[];
        dropped: Array<{ hunkId: string; reason: string }>;
      };
      expect(waived.checks).toHaveLength(0);
      expect(waived.dropped).toEqual([{ hunkId, reason: "waived" }]);
      const stored = (await service.sessionChecks(sessionId)).body as { waived: string[] };
      expect(stored.waived).toContain(hunkId);
    } finally {
      db.close();
    }
  });

  it("grades answers, scores calibration, and reports it", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const generated = (
        await createChecksService(db, dataDir, { env: ENV, sandboxRunner }).generate(sessionId, {
          limit: 3,
          opened: [],
          waived: [],
        })
      ).body as { checks: Array<{ id: string; rubric: string[] }> };
      const check = generated.checks[0];
      if (!check) throw new Error("expected a check");

      const answerText =
        "Earlier attempt wrote b. Landed version writes c instead. It was kept because c is the wanted greeting.";
      const grading = stubFetch({
        hits: [
          {
            point: check.rubric[0],
            hit: true,
            excerpt: "wrote b",
            why: "names the earlier attempt",
          },
          {
            point: check.rubric[1],
            hit: true,
            excerpt: "writes c instead",
            why: "names the difference",
          },
          {
            point: check.rubric[2],
            hit: true,
            excerpt: "c is the wanted greeting",
            why: "states why kept",
          },
        ],
      });
      // Fresh service: proves answers resolve from persisted artifacts, not memory.
      const service = createChecksService(db, dataDir, {
        env: ENV,
        fetchImpl: grading,
        sandboxRunner,
      });
      const outcome = await service.answer(check.id, { confidence: "certain", answer: answerText });
      expect(outcome.status).toBe(200);
      const body = outcome.body as {
        attempt: {
          correct: boolean;
          brier: number;
          overconfident: boolean;
          underconfident: boolean;
        };
      };
      expect(body.attempt.correct).toBe(true);
      expect(body.attempt.brier).toBeCloseTo(0.0025, 4);
      expect(body.attempt.overconfident).toBe(false);

      const wrongGrading = stubFetch({
        hits: [
          { point: check.rubric[0], hit: false, excerpt: null, why: "not mentioned" },
          { point: check.rubric[1], hit: false, excerpt: null, why: "not mentioned" },
          { point: check.rubric[2], hit: false, excerpt: null, why: "not mentioned" },
        ],
      });
      const wrongService = createChecksService(db, dataDir, {
        env: ENV,
        fetchImpl: wrongGrading,
        sandboxRunner,
      });
      const wrong = (
        await wrongService.answer(check.id, { confidence: "certain", answer: "I have no idea." })
      ).body as {
        attempt: { correct: boolean; overconfident: boolean };
      };
      expect(wrong.attempt.correct).toBe(false);
      expect(wrong.attempt.overconfident).toBe(true);

      const report = (await service.report(sessionId)).body as {
        checksTotal: number;
        answered: number;
        correct: number;
        calibration: { meanBrier: number; overconfidenceCount: number };
      };
      expect(report.checksTotal).toBe(1);
      expect(report.answered).toBe(1);
      expect(report.correct).toBe(0);
      expect(report.calibration.overconfidenceCount).toBe(1);
      expect(report.calibration.meanBrier).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("fails closed when the model is off", async () => {
    const { dataDir, db, sessionId } = await seedSession();
    try {
      const generated = (
        await createChecksService(db, dataDir, { env: ENV, sandboxRunner }).generate(sessionId, {
          limit: 3,
          opened: [],
          waived: [],
        })
      ).body as { checks: Array<{ id: string }> };
      const checkId = generated.checks[0]?.id;
      if (!checkId) throw new Error("expected a check");
      const off = createChecksService(db, dataDir, {
        env: { ...ENV, ECHO_MODEL: "off" } as NodeJS.ProcessEnv,
        sandboxRunner,
      });
      expect((await off.answer(checkId, { confidence: "certain", answer: "x" })).status).toBe(503);
    } finally {
      db.close();
    }
  });
});
