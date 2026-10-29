import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TapeEnvelopeSchema } from "@echo/contracts";
import {
  appendEvents,
  insertSnapshot,
  openEchoDb,
  REVIEW_CACHE_VERSION,
  upsertProject,
  upsertSession,
} from "@echo/db";
import type { SnapshotResult } from "@echo/snapshots";
import { snapshotWorkingTree } from "@echo/snapshots";
import { describe, expect, it } from "vitest";
import { buildSessionReview } from "./review-index";
import { makeSnapshotEvent } from "./tape-events";

const TAKEN_AT = new Date("2026-10-28T10:00:00.000Z");

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

function toolEvent(sessionId: string, projectId: string, eventId: string) {
  return TapeEnvelopeSchema.parse({
    v: 1,
    tape_seq: 0,
    event_id: eventId,
    record_key: `test:${eventId}`,
    session_id: sessionId,
    project_id: projectId,
    kind: "tool.completed",
    ts: TAKEN_AT.toISOString(),
    observed_at: TAKEN_AT.toISOString(),
    source: {
      agent: "opencode",
      adapter: "test",
      adapter_version: "0.1.0",
      build: null,
      schema: null,
      record_type: "test",
      payload_type: null,
      sequence: 1,
      durability: null,
      origin: "import",
    },
    links: {
      turn_id: null,
      tool_call_id: "prt_notes",
      batch_id: null,
      parent_session_id: null,
      subagent_id: null,
      snapshot: null,
    },
    payload: { name: "write", input: { path: "notes.txt" }, status: "completed" },
    redaction: { version: "r1", findings: 0 },
    diagnostics: [],
  });
}

describe("buildSessionReview", () => {
  it("links final hunks to introducing snapshots and reverted attempts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-review-data-"));
    const root = mkdtempSync(join(tmpdir(), "echo-review-root-"));
    const projectId = "prj_review";
    const sessionId = "ses_review";
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
    try {
      upsertProject(db, { id: projectId, root, name: "review" });
      upsertSession(db, {
        id: sessionId,
        projectId,
        agent: "opencode",
        model: null,
        directory: root,
        title: "review",
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
        toolEvent(sessionId, projectId, "evt_tool"),
      ]);

      const review = await buildSessionReview(db, dataDir, sessionId);
      expect(review.baselineCommit).toBe(baseline.commitOid);
      expect(review.finalCommit).toBe(final.commitOid);
      expect(review.hunks).toHaveLength(1);
      expect(review.attempts.map((attempt) => attempt.status)).toEqual([
        "baseline",
        "replaced",
        "landed",
      ]);
      const hunkId = review.hunks[0]?.id;
      if (!hunkId) throw new Error("review hunk missing");
      const evidence = review.evidenceByHunk[hunkId] ?? [];
      expect(
        evidence.some(
          (entry) => entry.relation === "introduced_by" && entry.snapshotId === final.commitOid,
        ),
      ).toBe(true);
      expect(evidence.some((entry) => entry.relation === "reverted_attempt")).toBe(true);
      expect(
        evidence.some(
          (entry) => entry.relation === "related_event" && entry.eventId === "evt_tool",
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("buildSessionReview budget", () => {
  async function seedTwoSnapshots() {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-review-budget-data-"));
    const root = mkdtempSync(join(tmpdir(), "echo-review-budget-root-"));
    const projectId = "prj_review_budget";
    const sessionId = "ses_review_budget";
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
    upsertProject(db, { id: projectId, root, name: "review-budget" });
    upsertSession(db, {
      id: sessionId,
      projectId,
      agent: "opencode",
      model: null,
      directory: root,
      title: "review budget",
      startedAt: TAKEN_AT.toISOString(),
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
    return { dataDir, db, sessionId };
  }

  it("finishes small sessions inside the default budget with no diagnostic", async () => {
    const { dataDir, db, sessionId } = await seedTwoSnapshots();
    try {
      const review = await buildSessionReview(db, dataDir, sessionId);
      expect(review.hunks).toHaveLength(1);
      expect(review.diagnostics).not.toContain("review_budget_exceeded");
    } finally {
      db.close();
    }
  });

  it("degrades to a valid review with a diagnostic when the budget is already spent", async () => {
    const { dataDir, db, sessionId } = await seedTwoSnapshots();
    try {
      // A negative budget puts the deadline in the past, so every loop
      // trips deterministically on its first check.
      const review = await buildSessionReview(db, dataDir, sessionId, { budgetMs: -1 });
      expect(review.diagnostics).toContain("review_budget_exceeded");
      expect(review.hunks).toEqual([]);
      expect(review.attempts).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("buildSessionReview whole-tree diffs", () => {
  async function seedTransition(
    baselineFiles: Record<string, string>,
    finalFiles: Record<string, string>,
  ) {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-review-trees-data-"));
    const root = mkdtempSync(join(tmpdir(), "echo-review-trees-root-"));
    const projectId = "prj_review_trees";
    const sessionId = "ses_review_trees";
    for (const [name, content] of Object.entries(baselineFiles)) {
      writeFileSync(join(root, name), content);
    }
    const shadowDir = join(dataDir, "projects", projectId, "shadow.git");
    const limits = { maxFileBytes: 4 * 1024 * 1024 };
    const baseline = await snapshotWorkingTree({
      shadowDir,
      root,
      dataDir,
      sessionId,
      projectId,
      trigger: "baseline",
      eventId: "evt_base",
      takenAt: TAKEN_AT,
      limits,
    });
    for (const name of Object.keys(baselineFiles)) {
      if (!(name in finalFiles)) rmSync(join(root, name));
    }
    for (const [name, content] of Object.entries(finalFiles)) {
      writeFileSync(join(root, name), content);
    }
    const final = await snapshotWorkingTree({
      shadowDir,
      root,
      dataDir,
      sessionId,
      projectId,
      trigger: "final",
      eventId: "evt_final",
      takenAt: TAKEN_AT,
      limits,
    });
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    upsertProject(db, { id: projectId, root, name: "review-trees" });
    upsertSession(db, {
      id: sessionId,
      projectId,
      agent: "opencode",
      model: null,
      directory: root,
      title: "review trees",
      startedAt: TAKEN_AT.toISOString(),
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
    return { dataDir, db, sessionId };
  }

  it("splits one transition across every changed path", async () => {
    const { dataDir, db, sessionId } = await seedTransition(
      { "a.txt": "a\n", "b.txt": "x\n" },
      { "a.txt": "a\nb\n", "b.txt": "x\ny\n" },
    );
    try {
      const review = await buildSessionReview(db, dataDir, sessionId);
      expect(review.hunks.map((hunk) => hunk.path).sort()).toEqual(["a.txt", "b.txt"]);
      expect(review.attempts.map((attempt) => `${attempt.path}:${attempt.status}`)).toEqual([
        "a.txt:baseline",
        "a.txt:landed",
        "b.txt:baseline",
        "b.txt:landed",
      ]);
      expect(review.diagnostics).not.toContain("review_budget_exceeded");
    } finally {
      db.close();
    }
  });

  it("maps a moved file to delete+add hunks on both paths", async () => {
    const { dataDir, db, sessionId } = await seedTransition(
      { "old.txt": "same\n" },
      { "new.txt": "same\n" },
    );
    try {
      const review = await buildSessionReview(db, dataDir, sessionId);
      const byPath = new Map(review.hunks.map((hunk) => [hunk.path, hunk]));
      expect([...byPath.keys()].sort()).toEqual(["new.txt", "old.txt"]);
      expect(byPath.get("old.txt")).toMatchObject({ addedLines: 0, removedLines: 1 });
      expect(byPath.get("new.txt")).toMatchObject({ addedLines: 1, removedLines: 0 });
      expect(
        review.attempts
          .filter((attempt) => attempt.status === "landed")
          .map((attempt) => attempt.path),
      ).toEqual(["new.txt"]);
    } finally {
      db.close();
    }
  });

  it("falls back to per-path diffs when a whole-tree diff blows the buffer", async () => {
    // Each per-path diff (~6MB) fits the 10MB git buffer while the combined
    // whole-tree diff (~12MB) exceeds it, forcing the fallback path.
    // Generous budget: this test measures fallback correctness, and a loaded
    // CI machine must not trip the 10s default mid-fallback.
    const big = (char: string) => `${char.repeat(3 * 1024 * 1024)}\n`;
    const { dataDir, db, sessionId } = await seedTransition(
      { "big1.txt": big("a"), "big2.txt": big("b") },
      { "big1.txt": big("c"), "big2.txt": big("d") },
    );
    try {
      const review = await buildSessionReview(db, dataDir, sessionId, { budgetMs: 120_000 });
      expect(review.hunks.map((hunk) => hunk.path).sort()).toEqual(["big1.txt", "big2.txt"]);
      expect(review.diagnostics).not.toContain("review_diff_failed:big1.txt");
      expect(review.diagnostics).not.toContain("review_diff_failed:big2.txt");
      expect(review.attempts.map((attempt) => attempt.status)).toEqual([
        "baseline",
        "landed",
        "baseline",
        "landed",
      ]);
    } finally {
      db.close();
    }
  }, 120_000);
});

describe("buildSessionReview transition cache", () => {
  async function seedCached() {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-review-cache-data-"));
    const root = mkdtempSync(join(tmpdir(), "echo-review-cache-root-"));
    const projectId = "prj_review_cache";
    const sessionId = "ses_review_cache";
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
    upsertProject(db, { id: projectId, root, name: "review-cache" });
    upsertSession(db, {
      id: sessionId,
      projectId,
      agent: "opencode",
      model: null,
      directory: root,
      title: "review cache",
      startedAt: TAKEN_AT.toISOString(),
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
    return { dataDir, db, sessionId };
  }

  function cacheRows(db: ReturnType<typeof openEchoDb>, sessionId: string) {
    return db
      .prepare(
        "SELECT parent_commit, child_commit, code_version FROM review_transition_cache WHERE session_id = ?",
      )
      .all(sessionId) as Array<{
      parent_commit: string;
      child_commit: string;
      code_version: string;
    }>;
  }

  it("reuses cached transitions on the second run with identical results", async () => {
    const { dataDir, db, sessionId } = await seedCached();
    try {
      const first = await buildSessionReview(db, dataDir, sessionId);
      expect(first.hunks).toHaveLength(1);
      expect(cacheRows(db, sessionId)).toHaveLength(1);
      const second = await buildSessionReview(db, dataDir, sessionId);
      expect(second.hunks).toEqual(first.hunks);
      expect(second.attempts).toEqual(first.attempts);
      expect(second.diagnostics).not.toContain("review_budget_exceeded");
    } finally {
      db.close();
    }
  });

  it("recomputes and repairs on code version mismatch", async () => {
    const { dataDir, db, sessionId } = await seedCached();
    try {
      const first = await buildSessionReview(db, dataDir, sessionId);
      expect(cacheRows(db, sessionId)).toHaveLength(1);
      db.prepare(
        "UPDATE review_transition_cache SET code_version = ?, hunks_json = ? WHERE session_id = ?",
      ).run("stale-version", JSON.stringify({ "notes.txt": [{ bogus: true }] }), sessionId);
      const second = await buildSessionReview(db, dataDir, sessionId);
      expect(second.hunks).toEqual(first.hunks);
      expect(second.attempts).toEqual(first.attempts);
      const rows = cacheRows(db, sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.code_version).toBe(REVIEW_CACHE_VERSION);
    } finally {
      db.close();
    }
  });
});
