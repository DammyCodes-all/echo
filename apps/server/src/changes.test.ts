import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeSchema, type TapeEvent } from "@echo/contracts";
import {
  appendEvents,
  deleteEchoSession,
  type EchoDb,
  getChangeRefs,
  getProgress,
  insertSnapshot,
  listSnapshots,
  openEchoDb,
  recordChangeRef,
  upsertProject,
  upsertSession,
} from "@echo/db";
import type { SnapshotResult } from "@echo/snapshots";
import { snapshotWorkingTree } from "@echo/snapshots";
import { describe, expect, it } from "vitest";
import { createChangesService } from "./changes";

const TAKEN_AT = new Date("2026-10-28T10:00:00.000Z");
const silentLog = { info: () => {}, error: () => {} };

function livePromptEvent(
  sessionId: string,
  projectId: string,
  eventId: string,
  observedAt: string,
): TapeEvent {
  return {
    v: 1,
    tape_seq: 0,
    event_id: eventId,
    record_key: `test:${eventId}`,
    session_id: sessionId,
    project_id: projectId,
    kind: "prompt.submitted",
    ts: observedAt,
    observed_at: observedAt,
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
    payload: { text: "add a notes file" },
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

function insertRow(db: EchoDb, sessionId: string, snapshot: SnapshotResult, eventId: string): void {
  insertSnapshot(db, {
    id: snapshot.commitOid,
    sessionId,
    commitOid: snapshot.commitOid,
    parentOid: snapshot.parentOid,
    trigger: snapshot.trigger,
    eventId,
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

async function seedTwoSnapshots(): Promise<{
  db: EchoDb;
  dataDir: string;
  root: string;
  projectId: string;
  sessionId: string;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-changes-data-"));
  const root = mkdtempSync(join(tmpdir(), "echo-changes-root-"));
  const projectId = "prj_changes";
  const sessionId = "ses_changes";
  writeFileSync(join(root, "notes.txt"), "a\n");
  const baseline = await takeSnapshot({
    dataDir,
    root,
    sessionId,
    projectId,
    trigger: "baseline",
    eventId: "evt_base",
  });
  writeFileSync(join(root, "notes.txt"), "a\nb\nc\nd\n");
  const final = await takeSnapshot({
    dataDir,
    root,
    sessionId,
    projectId,
    trigger: "final",
    eventId: "evt_final",
  });
  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  upsertProject(db, { id: projectId, root, name: "changes" });
  upsertSession(db, {
    id: sessionId,
    projectId,
    agent: "opencode",
    model: null,
    directory: root,
    title: "changes",
    startedAt: TAKEN_AT.toISOString(),
    tapePath: join(dataDir, "tape.jsonl"),
    captureQuality: "partial",
  });
  insertRow(db, sessionId, baseline, "evt_base");
  insertRow(db, sessionId, final, "evt_final");
  return { db, dataDir, root, projectId, sessionId };
}

describe("changes service", () => {
  it("generates skeleton changes and dedupes the second run", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      expect(first.artifact?.changes.length).toBeGreaterThan(0);
      for (const change of first.artifact?.changes ?? []) {
        expect(ChangeSchema.parse(change)).toEqual(change);
      }
      const refs = getChangeRefs(db, sessionId);
      expect(refs).toHaveLength(first.artifact?.changes.length ?? 0);
      const path = join(dataDir, "projects", projectId, "sessions", sessionId, "changes.json");
      const bytes = readFileSync(path, "utf8");
      expect(first.artifact?.summary).toContain("reviewed change");

      const second = await service.maybeGenerateChanges(sessionId);
      expect(second.outcome).toBe("fresh");
      expect(getChangeRefs(db, sessionId)).toHaveLength(refs.length);
      expect(readFileSync(path, "utf8")).toBe(bytes);
    } finally {
      db.close();
    }
  });

  it("appends new pairs and versions without resetting progress", async () => {
    const { db, dataDir, root, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      const before = first.artifact?.changes ?? [];
      expect(before.length).toBeGreaterThan(0);
      const firstChange = before[0];
      if (!firstChange) throw new Error("expected a change");
      const recorded = service.recordProgress(sessionId, {
        changeId: firstChange.id,
        version: firstChange.version,
        state: "understood",
      });
      expect(recorded.status).toBe(200);

      writeFileSync(join(root, "notes.txt"), "a\nb\nc\nd\ne\nf\ng\n");
      const third = await takeSnapshot({
        dataDir,
        root,
        sessionId,
        projectId,
        trigger: "final",
        eventId: "evt_third",
      });
      insertRow(db, sessionId, third, "evt_third");

      const second = await service.maybeGenerateChanges(sessionId);
      expect(second.outcome).toBe("generated");
      const after = second.artifact?.changes ?? [];
      expect(after.length).toBeGreaterThan(before.length);
      for (const change of before) {
        expect(after.map((entry) => `${entry.id}:v${entry.version}`)).toContain(
          `${change.id}:v${change.version}`,
        );
      }
      // Old progress survives the regen.
      expect(
        getProgress(db, sessionId).find(
          (row) => row.changeId === firstChange.id && row.version === firstChange.version,
        )?.state,
      ).toBe("understood");
    } finally {
      db.close();
    }
  });

  it("assigns a new version when a span rehashes", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const snapshots = listSnapshots(db, sessionId);
      const prev = snapshots[0]?.commitOid;
      const next = snapshots[1]?.commitOid;
      if (!prev || !next) throw new Error("expected two snapshots");
      // A prior model regen stored a different hash for the same span.
      recordChangeRef(db, {
        sessionId,
        changeId: `c_${"0".repeat(16)}`,
        version: 1,
        prevOid: prev,
        nextOid: next,
      });
      const service = createChangesService({ db, dataDir, log: silentLog });
      const outcome = await service.maybeGenerateChanges(sessionId);
      expect(outcome.outcome).toBe("generated");
      const versions = getChangeRefs(db, sessionId)
        .filter((ref) => ref.prevOid === prev && ref.nextOid === next)
        .map((ref) => ref.version)
        .sort();
      // The stale v1 row for the gone id is pruned: refs mirror the list.
      expect(versions).toEqual([2]);
      expect(outcome.artifact?.changes.every((change) => change.version === 2)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("round-trips progress and moves the resume pointer", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const generated = await service.maybeGenerateChanges(sessionId);
      const changes = generated.artifact?.changes ?? [];
      expect(changes.length).toBeGreaterThan(0);

      const initial = service.getChanges(sessionId);
      expect(initial.status).toBe(200);
      const initialBody = initial.body as {
        changes: unknown[];
        progress: unknown[];
        summary: unknown;
        isLive: unknown;
      };
      expect(initialBody.changes).toHaveLength(changes.length);
      expect(initialBody.progress).toEqual([]);
      expect(typeof initialBody.summary).toBe("string");
      expect(initialBody.summary).toContain("reviewed change");
      expect(initialBody.isLive).toBe(false);

      for (const change of changes) {
        const recorded = service.recordProgress(sessionId, {
          changeId: change.id,
          version: change.version,
          state: "understood",
        });
        expect(recorded.status).toBe(200);
      }
      const done = service.getChanges(sessionId);
      const doneBody = done.body as {
        changes: unknown[];
        progress: Array<{ changeId: string; version: number; state: string }>;
        summary: string;
        isLive: boolean;
      };
      expect(done.status).toBe(200);
      expect(doneBody.changes).toHaveLength(changes.length);
      expect(doneBody.progress).toHaveLength(changes.length);
      expect(typeof doneBody.summary).toBe("string");
      expect(doneBody.isLive).toBe(false);

      // Skipped still counts as not-understood: the stored row keeps it.
      const firstChange = changes[0];
      if (!firstChange) throw new Error("expected a change");
      expect(
        service.recordProgress(sessionId, {
          changeId: firstChange.id,
          version: firstChange.version,
          state: "skipped",
        }).status,
      ).toBe(200);
      const resumed = service.getChanges(sessionId);
      const resumedBody = resumed.body as {
        progress: Array<{ changeId: string; version: number; state: string }>;
      };
      expect(
        resumedBody.progress.find(
          (row) => row.changeId === firstChange.id && row.version === firstChange.version,
        )?.state,
      ).toBe("skipped");
    } finally {
      db.close();
    }
  });

  it("returns 202 while the session is still recording with no changes", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      appendEvents(db, sessionId, [
        livePromptEvent(sessionId, projectId, "evt_live", new Date().toISOString()),
      ]);
      const outcome = service.getChanges(sessionId);
      expect(outcome.status).toBe(202);
      expect(outcome.body).toEqual({ waiting: true, sessionId });
    } finally {
      db.close();
    }
  });

  it("serves live sessions with the live flag", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      await service.maybeGenerateChanges(sessionId);
      appendEvents(db, sessionId, [
        livePromptEvent(sessionId, projectId, "evt_live", new Date().toISOString()),
      ]);
      const outcome = service.getChanges(sessionId);
      expect(outcome.status).toBe(200);
      const body = outcome.body as {
        changes: unknown[];
        progress: unknown[];
        summary: string;
        isLive: boolean;
      };
      expect(body.changes.length).toBeGreaterThan(0);
      expect(body.isLive).toBe(true);
      expect(typeof body.summary).toBe("string");
    } finally {
      db.close();
    }
  });

  it("returns 404 for unknown sessions", async () => {
    const { db, dataDir } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      expect(service.getChanges("ses_missing")).toEqual({
        status: 404,
        body: { error: { code: "not_found", message: "unknown session" } },
      });
      const changeId = `c_${"a".repeat(16)}`;
      expect(
        service.recordProgress("ses_missing", { changeId, version: 1, state: "viewed" }),
      ).toEqual({
        status: 404,
        body: { error: { code: "not_found", message: "unknown session" } },
      });
    } finally {
      db.close();
    }
  });

  it("rejects invalid progress bodies with 400", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const changeId = `c_${"a".repeat(16)}`;
      for (const body of [
        { changeId, version: 1, state: "bogus" },
        { changeId, version: 0, state: "viewed" },
        { changeId, version: 1 },
        { version: 1, state: "viewed" },
        null,
      ]) {
        const outcome = service.recordProgress(sessionId, body);
        expect(outcome.status).toBe(400);
        expect(outcome.body).toEqual({
          error: {
            code: "invalid_request",
            message: expect.any(String),
          },
        });
      }
    } finally {
      db.close();
    }
  });

  it("deletes change rows with the session", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const generated = await service.maybeGenerateChanges(sessionId);
      const change = generated.artifact?.changes[0];
      if (!change) throw new Error("expected a change");
      expect(
        service.recordProgress(sessionId, {
          changeId: change.id,
          version: change.version,
          state: "viewed",
        }).status,
      ).toBe(200);
      expect(getChangeRefs(db, sessionId).length).toBeGreaterThan(0);
      expect(getProgress(db, sessionId).length).toBeGreaterThan(0);
      deleteEchoSession(db, sessionId);
      expect(getChangeRefs(db, sessionId)).toEqual([]);
      expect(getProgress(db, sessionId)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("heals orphan refs: recorded-but-missing ids regenerate in place", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      const before = first.artifact?.changes ?? [];
      expect(before.length).toBeGreaterThan(0);
      // Lose the file but keep the rows: the next run must not skip.
      rmSync(join(dataDir, "projects", projectId, "sessions", sessionId, "changes.json"));
      const second = await service.maybeGenerateChanges(sessionId);
      expect(second.outcome).toBe("generated");
      const after = second.artifact?.changes ?? [];
      expect(after.map((change) => `${change.id}:v${change.version}`).sort()).toEqual(
        before.map((change) => `${change.id}:v${change.version}`).sort(),
      );
    } finally {
      db.close();
    }
  });

  it("folds big sessions and keeps one stable rollup across regens", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-changes-data-"));
    const root = mkdtempSync(join(tmpdir(), "echo-changes-root-"));
    const projectId = "prj_changes";
    const sessionId = "ses_changes";
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    upsertProject(db, { id: projectId, root, name: "changes" });
    upsertSession(db, {
      id: sessionId,
      projectId,
      agent: "opencode",
      model: null,
      directory: root,
      title: "changes",
      startedAt: TAKEN_AT.toISOString(),
      tapePath: join(dataDir, "tape.jsonl"),
      captureQuality: "partial",
    });
    const take = async (trigger: "baseline" | "tool.post" | "final", eventId: string) => {
      const snapshot = await takeSnapshot({
        dataDir,
        root,
        sessionId,
        projectId,
        trigger,
        eventId,
      });
      insertRow(db, sessionId, snapshot, eventId);
    };
    await take("baseline", "evt_0");
    // Two pairs touching 22 files each: ~12 groups, over the fold threshold.
    for (const round of [1, 2]) {
      for (let i = 0; i < 22; i += 1) {
        writeFileSync(
          join(root, `f${i}.txt`),
          `round ${round} file ${i}\nline a ${round}\nline b ${round}\n`,
        );
      }
      await take("tool.post", `evt_${round}`);
    }
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      const changes = first.artifact?.changes ?? [];
      // 12 candidates fold to 5: one rollup plus four kept.
      expect(changes).toHaveLength(5);
      const rollups = changes.filter((change) => change.files.length >= 10);
      expect(rollups).toHaveLength(1);
      const rollupId = rollups[0]?.id;
      expect(rollupId).toMatch(/^c_[0-9a-f]{16}$/);
      expect(getChangeRefs(db, sessionId)).toHaveLength(changes.length);

      // One more pair: the rollup keeps its id, nothing duplicates.
      writeFileSync(join(root, "f0.txt"), "round 3 file 0\nline A 3\nline B 3\nmore\n");
      await take("tool.post", "evt_3");
      const second = await service.maybeGenerateChanges(sessionId);
      expect(second.outcome).toBe("generated");
      const again = second.artifact?.changes ?? [];
      const ids = again.map((change) => change.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(again.filter((change) => change.files.length >= 10)).toHaveLength(1);
      expect(again.find((change) => change.files.length >= 10)?.id).toBe(rollupId);
      expect(again.length).toBeLessThanOrEqual(6);
      expect(getChangeRefs(db, sessionId)).toHaveLength(again.length);
    } finally {
      db.close();
    }
  });
});
