import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionSummaryFromDigests, rollupIdFor } from "@echo/chapters";
import {
  CHANGES_FILE_NAME,
  ChangeCodeResponseSchema,
  ChangeSchema,
  type TapeEvent,
} from "@echo/contracts";
import {
  appendEvents,
  deleteEchoSession,
  type EchoDb,
  getChangeRefs,
  getProgress,
  getSessionSummary,
  insertSnapshot,
  listSnapshots,
  openEchoDb,
  recordChangeRef,
  setSessionSummary,
  upsertProject,
  upsertSession,
} from "@echo/db";
import type { SnapshotResult } from "@echo/snapshots";
import { snapshotWorkingTree } from "@echo/snapshots";
import { describe, expect, it } from "vitest";
import { createChangesService } from "./changes";

const TAKEN_AT = new Date("2026-10-28T10:00:00.000Z");
const silentLog = { info: () => {}, error: () => {} };
const OFF_ENV = { ...process.env, ECHO_MODEL: "off" } as NodeJS.ProcessEnv;
const MODEL_ENV = {
  ...process.env,
  ECHO_MODEL: "",
  META_API_KEY: "test-key",
  META_MODEL_ID: "test-model",
} as NodeJS.ProcessEnv;

function stubFetchSequence(answers: unknown[]) {
  let calls = 0;
  const fetchImpl = (async () => {
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
  return { fetchImpl, calls: () => calls };
}

function nameTestDraft() {
  return {
    title: "Add project notes file",
    summary:
      "This change adds the project notes file. The new lines now carry the updated content for review.",
    before: ["Before this change, the notes file held the earlier form."],
    now: ["Now the file carries the updated version in place."],
    howItWorks: [
      "Change notes.txt: add the new lines.",
      "Keep the surrounding content as is.",
      "Review the new lines only.",
    ],
    headsUp: [],
    files: [{ path: "notes.txt", note: "Change notes.txt: updated." }],
    digest: Array.from({ length: 60 }, (_, i) => `token${i}`).join(" "),
  };
}

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

function toolEditEvent(
  sessionId: string,
  projectId: string,
  eventId: string,
  observedAt: string,
  path: string,
  ts: string = observedAt,
): TapeEvent {
  const base = livePromptEvent(sessionId, projectId, eventId, observedAt);
  return {
    ...base,
    kind: "tool.completed",
    ts,
    payload: {
      name: "edit",
      status: "completed",
      input: { path, oldString: "a\n", newString: "a\nb\nc\nd\n" },
    },
  };
}

function toolIntentEvent(
  sessionId: string,
  projectId: string,
  eventId: string,
  observedAt: string,
): TapeEvent {
  // Muse-style opaque intent: no input.path, but the relative path appears
  // in the requested tool-call args, which counts as evidence.
  const base = livePromptEvent(sessionId, projectId, eventId, observedAt);
  return {
    ...base,
    kind: "tool.requested",
    payload: {
      event: { kind: "assistant_tool_calls_committed" },
      tool_calls: [{ args: JSON.stringify({ path: "notes.txt", find: "a", replace: "b" }) }],
    },
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
  // Evidence gate: the tape must prove the session touched notes.txt,
  // or the pair diff would be dropped as another session's write.
  appendEvents(db, sessionId, [
    toolEditEvent(
      sessionId,
      projectId,
      "evt_evidence",
      TAKEN_AT.toISOString(),
      join(root, "notes.txt"),
    ),
  ]);
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

  it("folds big sessions into small rollups with stable ids across regens", async () => {
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
    // Evidence gate: every touched file needs a tape edit, or the pair
    // diffs would be dropped as unattributed.
    appendEvents(
      db,
      sessionId,
      Array.from({ length: 22 }, (_, i) =>
        toolEditEvent(
          sessionId,
          projectId,
          `evt_evidence_${i}`,
          TAKEN_AT.toISOString(),
          join(root, `f${i}.txt`),
        ),
      ),
    );
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
      // 12 candidates fold to 4 kept plus 3 rollup chunks; every change
      // stays small enough to read in a minute.
      expect(changes).toHaveLength(7);
      for (const change of changes) {
        expect(change.files.length).toBeLessThanOrEqual(10);
      }
      const rollupIds = new Set([0, 1, 2].map((index) => rollupIdFor(sessionId, index)));
      const rollups = changes.filter((change) => rollupIds.has(change.id));
      expect(rollups).toHaveLength(3);
      expect(getChangeRefs(db, sessionId)).toHaveLength(changes.length);

      // One more pair: the rollup ids stay put, nothing duplicates.
      writeFileSync(join(root, "f0.txt"), "round 3 file 0\nline A 3\nline B 3\nmore\n");
      await take("tool.post", "evt_3");
      const second = await service.maybeGenerateChanges(sessionId);
      expect(second.outcome).toBe("generated");
      const again = second.artifact?.changes ?? [];
      const ids = again.map((change) => change.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const change of again) {
        expect(change.files.length).toBeLessThanOrEqual(10);
      }
      expect(again.filter((change) => rollupIds.has(change.id))).toHaveLength(3);
      expect(again.length).toBeLessThanOrEqual(7);
      expect(getChangeRefs(db, sessionId)).toHaveLength(again.length);
    } finally {
      db.close();
    }
  });

  it("resplits a stored giant rollup on the next run, then stays fresh", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      // Simulate a pre-split artifact: one change wider than the reader cap,
      // snapshots untouched so only the shape flags it stale.
      const path = join(dataDir, "projects", projectId, "sessions", sessionId, "changes.json");
      const stored = JSON.parse(readFileSync(path, "utf8")) as {
        changes: Array<{ files: Array<{ path: string; note: string }> }>;
      };
      expect(stored.changes.length).toBeGreaterThan(0);
      const head = stored.changes[0];
      if (head === undefined) throw new Error("seed produced no changes");
      head.files = Array.from({ length: 11 }, (_, i) => ({
        path: `wide/f${i}.txt`,
        note: "wide file",
      }));
      writeFileSync(path, JSON.stringify(stored));
      expect(service.findSessionNeedingChanges(false)).toEqual({
        sessionId,
        reason: "stale",
      });
      const second = await service.maybeGenerateChanges(sessionId);
      expect(second.outcome).toBe("generated");
      for (const change of second.artifact?.changes ?? []) {
        expect(change.files.length).toBeLessThanOrEqual(10);
      }
      // Healed once: the next run is fresh, not a regen loop.
      const third = await service.maybeGenerateChanges(sessionId);
      expect(third.outcome).toBe("fresh");
    } finally {
      db.close();
    }
  });

  it("rewrites a drifted summary without touching row prose", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      const before = first.artifact?.changes ?? [];
      // Simulate an old-shape summary over unchanged rows and snapshots.
      const path = join(dataDir, "projects", projectId, "sessions", sessionId, "changes.json");
      const stored = JSON.parse(readFileSync(path, "utf8")) as { summary: string };
      stored.summary = "A stale summary shape from before the excerpt cap.";
      writeFileSync(path, JSON.stringify(stored));
      expect(service.findSessionNeedingChanges(false)).toEqual({
        sessionId,
        reason: "stale",
      });
      const second = await service.maybeGenerateChanges(sessionId);
      expect(second.outcome).toBe("generated");
      expect(second.artifact?.summary).not.toBe(stored.summary);
      // Rows byte-identical: same ids, versions, prose, and generator stamp.
      expect(second.artifact?.changes).toEqual(before);
      expect(second.artifact?.generator).toBe(first.artifact?.generator);
      const third = await service.maybeGenerateChanges(sessionId);
      expect(third.outcome).toBe("fresh");
    } finally {
      db.close();
    }
  });

  it("serves numbered hunks for one stored change", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      const change = first.artifact?.changes[0];
      if (!change) throw new Error("seed produced no changes");
      const outcome = await service.getChangeCode(sessionId, change.id);
      expect(outcome.status).toBe(200);
      const body = ChangeCodeResponseSchema.parse(outcome.body);
      expect(body.changeId).toBe(change.id);
      expect(body.version).toBe(change.version);
      expect(body.files.map((file) => file.path)).toEqual(["notes.txt"]);
      const file = body.files[0];
      if (!file) throw new Error("code response has no files");
      // notes.txt went from "a" to "a b c d": one context line, three adds.
      expect(file.added).toBe(3);
      expect(file.removed).toBe(0);
      expect(file.truncated).toBe(false);
      expect(file.hunks).toHaveLength(1);
      const hunk = file.hunks[0];
      if (!hunk) throw new Error("code response has no hunks");
      expect(hunk.lines.map((line) => line.kind)).toEqual(["context", "add", "add", "add"]);
      expect(hunk.lines[0]).toMatchObject({ prevNo: 1, nextNo: 1, text: "a" });
      expect(hunk.lines[3]).toMatchObject({ prevNo: null, nextNo: 4, text: "d" });
    } finally {
      db.close();
    }
  });

  it("refuses unknown sessions, bad ids, and unknown changes", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      const change = first.artifact?.changes[0];
      if (!change) throw new Error("seed produced no changes");
      expect((await service.getChangeCode("ses_missing", change.id)).status).toBe(404);
      const bad = await service.getChangeCode(sessionId, "not-an-id");
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toContain("invalid_request");
      const missing = await service.getChangeCode(sessionId, "c_0000000000000000");
      expect(missing.status).toBe(404);
      expect(JSON.stringify(missing.body)).toContain("not_found");
    } finally {
      db.close();
    }
  });

  it("syncs the inbox summary with the model off and leaves the title null", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      db.prepare("UPDATE sessions SET title = NULL WHERE id = ?").run(sessionId);
      const service = createChangesService({ db, dataDir, log: silentLog }, { env: OFF_ENV });
      appendEvents(db, sessionId, [
        livePromptEvent(sessionId, projectId, "evt_p1", "2026-10-28T09:00:00.000Z"),
      ]);
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      const row = getSessionSummary(db, sessionId);
      expect(row?.summary).toBe(first.artifact?.summary);
      expect(row?.title).toBeNull();
    } finally {
      db.close();
    }
  });

  it("names untitled sessions from the model, capped and redacted", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      db.prepare("UPDATE sessions SET title = NULL WHERE id = ?").run(sessionId);
      // Fake secret built at runtime so no secret-shaped literal lives here.
      const fakeKey = `sk-${"1".repeat(20)}`;
      const { fetchImpl, calls } = stubFetchSequence([
        nameTestDraft(),
        { title: `Notes file with ${fakeKey} inside the draft` },
      ]);
      const service = createChangesService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      appendEvents(db, sessionId, [
        livePromptEvent(sessionId, projectId, "evt_p1", "2026-10-28T09:00:00.000Z"),
      ]);
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      // One narration call plus one naming call.
      expect(calls()).toBe(2);
      const title = getSessionSummary(db, sessionId)?.title ?? "";
      expect(title).toContain("[REDACTED:api-key-prefix:");
      expect(title).not.toContain(fakeKey);
      expect(title.length).toBeLessThanOrEqual(60);
    } finally {
      db.close();
    }
  });

  it("never overwrites an agent title and spends no naming call", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const { fetchImpl, calls } = stubFetchSequence([nameTestDraft()]);
      const service = createChangesService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      appendEvents(db, sessionId, [
        livePromptEvent(sessionId, projectId, "evt_p1", "2026-10-28T09:00:00.000Z"),
      ]);
      await service.maybeGenerateChanges(sessionId);
      expect(getSessionSummary(db, sessionId)?.title).toBe("changes");
      // Narration ran; naming skipped without a model call.
      expect(calls()).toBe(1);
    } finally {
      db.close();
    }
  });

  it("advances a drifted watermark on content-fresh runs", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      // Simulate a pre-watermark artifact: same content, no watermark.
      const path = join(dataDir, "projects", projectId, "sessions", sessionId, "changes.json");
      const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      delete stored.snapshotWatermark;
      writeFileSync(path, JSON.stringify(stored));
      expect(service.findSessionNeedingChanges(false)).toEqual({ sessionId, reason: "stale" });
      const second = await service.maybeGenerateChanges(sessionId);
      expect(second.outcome).toBe("fresh");
      // Watermark advanced, content untouched — and the backfill lets go.
      const reread = JSON.parse(readFileSync(path, "utf8")) as {
        snapshotWatermark: unknown;
        changes: unknown[];
      };
      expect(reread.snapshotWatermark).toEqual(first.artifact?.snapshotWatermark);
      expect(reread.changes).toEqual(first.artifact?.changes ?? []);
      expect(service.findSessionNeedingChanges(false)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("heals missing inbox metadata on fresh runs and backfills it", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog }, { env: OFF_ENV });
      appendEvents(db, sessionId, [
        livePromptEvent(sessionId, projectId, "evt_p1", "2026-10-28T09:00:00.000Z"),
      ]);
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      // Simulate a legacy row: artifact current, inbox columns empty.
      db.prepare("UPDATE sessions SET title = NULL, story_summary = NULL WHERE id = ?").run(
        sessionId,
      );
      expect(service.findSessionNeedingChanges(false)).toEqual({ sessionId, reason: "meta" });
      const second = await service.maybeGenerateChanges(sessionId);
      expect(second.outcome).toBe("fresh");
      const row = getSessionSummary(db, sessionId);
      expect(row?.summary).toBe(first.artifact?.summary);
      // Model off: summary heals, title waits for a model run.
      expect(row?.title).toBeNull();
      expect(service.findSessionNeedingChanges(false)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("flags title-only gaps for the backfill only when the model is on", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog }, { env: OFF_ENV });
      appendEvents(db, sessionId, [
        livePromptEvent(sessionId, projectId, "evt_p1", "2026-10-28T09:00:00.000Z"),
      ]);
      await service.maybeGenerateChanges(sessionId);
      db.prepare("UPDATE sessions SET title = NULL WHERE id = ?").run(sessionId);
      // Summary current, title missing: flaggable only with the model on,
      // or model-off daemons would pick it every tick without effect.
      expect(service.findSessionNeedingChanges(false)).toBeNull();
      expect(service.findSessionNeedingChanges(true)).toEqual({ sessionId, reason: "meta" });
    } finally {
      db.close();
    }
  });

  it("drops diff files the tape never evidenced and counts the gap", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-changes-data-"));
    const root = mkdtempSync(join(tmpdir(), "echo-changes-root-"));
    const projectId = "prj_changes";
    const sessionId = "ses_changes";
    writeFileSync(join(root, "notes.txt"), "a\n");
    writeFileSync(join(root, "other.txt"), "x\n");
    const baseline = await takeSnapshot({
      dataDir,
      root,
      sessionId,
      projectId,
      trigger: "baseline",
      eventId: "evt_base",
    });
    writeFileSync(join(root, "notes.txt"), "a\nb\nc\nd\n");
    writeFileSync(join(root, "other.txt"), "x\ny\nz\nw\n");
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
    // Only notes.txt was ever touched: other.txt is another session's
    // shared-tree write and must not be claimed.
    appendEvents(db, sessionId, [
      toolEditEvent(
        sessionId,
        projectId,
        "evt_evidence",
        TAKEN_AT.toISOString(),
        join(root, "notes.txt"),
      ),
    ]);
    insertRow(db, sessionId, baseline, "evt_base");
    insertRow(db, sessionId, final, "evt_final");
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      const files = (first.artifact?.changes ?? []).flatMap((change) =>
        change.files.map((file) => file.path),
      );
      expect(files).toContain("notes.txt");
      expect(files).not.toContain("other.txt");
      expect(first.artifact?.diagnostics).toContain("changes_unattributed:1");
      expect(first.artifact?.diagnostics).toContain("changes_evidence_gated_v2");
    } finally {
      db.close();
    }
  });

  it("leaves empty changes when the tape evidences nothing", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      // SeedTwoSnapshots evidences notes.txt; remove all tool events so the
      // pair diffs look like another session's writes.
      db.prepare("DELETE FROM events WHERE kind LIKE 'tool.%'").run();
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      expect(first.artifact?.changes).toEqual([]);
      expect(first.artifact?.summary).toContain("no reviewed changes");
      expect(first.artifact?.diagnostics).toContain("changes_evidence_gated_v2");
    } finally {
      db.close();
    }
  });

  it("counts Muse-style requested intent as evidence", async () => {
    const { db, dataDir, sessionId, projectId } = await seedTwoSnapshots();
    try {
      // Same removal as above, but a requested intent naming notes.txt
      // restores the claim without any completed file-tool event.
      db.prepare("DELETE FROM events WHERE kind LIKE 'tool.%'").run();
      const service = createChangesService({ db, dataDir, log: silentLog });
      appendEvents(db, sessionId, [
        toolIntentEvent(sessionId, projectId, "evt_intent", TAKEN_AT.toISOString()),
      ]);
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      const files = (first.artifact?.changes ?? []).flatMap((change) =>
        change.files.map((file) => file.path),
      );
      expect(files).toContain("notes.txt");
    } finally {
      db.close();
    }
  });

  it("drops evidence outside the pair window", async () => {
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
    // Same file, same path — but the session touched it years before this
    // pair, so the diff belongs to whoever wrote it in-window.
    appendEvents(db, sessionId, [
      toolEditEvent(
        sessionId,
        projectId,
        "evt_old",
        "2020-01-01T00:00:00.000Z",
        join(root, "notes.txt"),
        "2020-01-01T00:00:00.000Z",
      ),
    ]);
    insertRow(db, sessionId, baseline, "evt_base");
    insertRow(db, sessionId, final, "evt_final");
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      expect(first.artifact?.changes).toEqual([]);
      expect(first.artifact?.diagnostics).toContain("changes_unattributed:1");
      expect(first.artifact?.diagnostics).toContain("changes_evidence_gated_v2");
    } finally {
      db.close();
    }
  });

  it("keeps import-style evidence with an old source time", async () => {
    const { db, dataDir, sessionId, projectId, root } = await seedTwoSnapshots();
    try {
      // Imports stamp observed_at at import time with older source times;
      // either clock counting keeps the claim.
      db.prepare("DELETE FROM events WHERE kind LIKE 'tool.%'").run();
      appendEvents(db, sessionId, [
        toolEditEvent(
          sessionId,
          projectId,
          "evt_imported",
          TAKEN_AT.toISOString(),
          join(root, "notes.txt"),
          "2020-01-01T00:00:00.000Z",
        ),
      ]);
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      const files = (first.artifact?.changes ?? []).flatMap((change) =>
        change.files.map((file) => file.path),
      );
      expect(files).toContain("notes.txt");
    } finally {
      db.close();
    }
  });

  it("regenerates pre-gate artifacts missing the gate marker", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService({ db, dataDir, log: silentLog });
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      // Simulate a pre-gate artifact: same content, marker stripped.
      const path = join(dataDir, "projects", projectId, "sessions", sessionId, "changes.json");
      const stored = JSON.parse(readFileSync(path, "utf8")) as {
        diagnostics: string[];
      };
      expect(stored.diagnostics).toContain("changes_evidence_gated_v2");
      stored.diagnostics = stored.diagnostics.filter((d) => d !== "changes_evidence_gated_v2");
      writeFileSync(path, JSON.stringify(stored));
      expect(service.findSessionNeedingChanges(false)).toEqual({ sessionId, reason: "stale" });
      const second = await service.maybeGenerateChanges(sessionId);
      expect(second.outcome).toBe("generated");
      expect(second.artifact?.diagnostics).toContain("changes_evidence_gated_v2");
      expect(service.findSessionNeedingChanges(false)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("skips live sessions with an artifact until their tape goes quiet", async () => {
    const { db, dataDir, projectId, sessionId } = await seedTwoSnapshots();
    try {
      const T = new Date("2026-11-02T12:00:00.000Z").getTime();
      const service = createChangesService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, clock: () => new Date(T) },
      );
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      // Title missing so a quiet tape would flag this session for naming;
      // a tape that moved 10s ago must still win over that reason.
      db.prepare("UPDATE sessions SET title = NULL WHERE id = ?").run(sessionId);
      appendEvents(db, sessionId, [
        livePromptEvent(sessionId, projectId, "evt_live", new Date(T - 10_000).toISOString()),
      ]);
      expect(service.findSessionNeedingChanges(true)).toBeNull();
      // Same tape, quiet 2 minutes later: the naming gap flags it again.
      const quiet = createChangesService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, clock: () => new Date(T + 120_000) },
      );
      expect(quiet.findSessionNeedingChanges(true)).toEqual({ sessionId, reason: "meta" });
    } finally {
      db.close();
    }
  });

  it("cools down fill passes on unchanged snapshots", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      // Model off first: every row stays a skeleton, so fill has work.
      const off = createChangesService({ db, dataDir, log: silentLog }, { env: OFF_ENV });
      const first = await off.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      expect(
        (first.artifact?.changes ?? []).every((c) => (c.origin ?? "skeleton") === "skeleton"),
      ).toBe(true);
      // Model on with a failing stub: narration keeps failing, so skeletons
      // remain and every tick would re-diff without the cooldown.
      let now = new Date("2026-11-02T12:00:00.000Z").getTime();
      const { fetchImpl, calls } = stubFetchSequence([{ nope: true }]);
      const service = createChangesService(
        { db, dataDir, log: silentLog },
        {
          env: { ...MODEL_ENV, ECHO_MODEL_PROVIDER: "meta" },
          fetchImpl,
          clock: () => new Date(now),
        },
      );
      const second = await service.maybeGenerateChanges(sessionId);
      // Fill attempted (narration calls happened) but every draft failed, so
      // rows stay skeletons and the outcome is fresh, not generated.
      expect(second.outcome).toBe("fresh");
      const afterFill = calls();
      expect(afterFill).toBeGreaterThan(0);
      // Same snapshots, same minute: the cooldown skips the pair loop, so no
      // more diffs and no more model calls.
      const third = await service.maybeGenerateChanges(sessionId);
      expect(third.outcome).toBe("fresh");
      expect(calls()).toBe(afterFill);
      // Past the cooldown with snapshots still unchanged: fill retries.
      now += 11 * 60 * 1000;
      await service.maybeGenerateChanges(sessionId);
      expect(calls()).toBeGreaterThan(afterFill);
    } finally {
      db.close();
    }
  });
});
