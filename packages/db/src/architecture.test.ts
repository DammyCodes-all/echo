import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getArchitectureVersion,
  getLatestArchitectureVersion,
  insertArchitectureVersion,
  insertSnapshot,
  listProjectSessionFiles,
  openEchoDb,
  upsertProject,
  upsertSession,
} from "./index";

function openTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "echo-arch-"));
  return openEchoDb(join(dir, "echo.sqlite"));
}

function seedSession(db: Parameters<typeof upsertSession>[0], sessionId: string) {
  upsertSession(db, {
    id: sessionId,
    projectId: "prj_1",
    agent: "muse",
    model: null,
    directory: "/repo",
    title: null,
    startedAt: "2026-10-28T10:00:00.000Z",
    tapePath: `/tmp/${sessionId}.jsonl`,
    captureQuality: "full",
  });
}

describe("architecture versions", () => {
  it("stores versions append-only and serves latest + by-number", () => {
    const db = openTestDb();
    try {
      upsertProject(db, { id: "prj_1", root: "/repo", name: "repo" });
      expect(getLatestArchitectureVersion(db, "prj_1")).toBeNull();
      insertArchitectureVersion(db, {
        projectId: "prj_1",
        version: 1,
        payloadJson: '{"version":1}',
        generator: "model",
      });
      insertArchitectureVersion(db, {
        projectId: "prj_1",
        version: 2,
        payloadJson: '{"version":2}',
        generator: "chat",
      });
      expect(getLatestArchitectureVersion(db, "prj_1")?.version).toBe(2);
      expect(getArchitectureVersion(db, "prj_1", 1)?.payloadJson).toBe('{"version":1}');
      expect(getArchitectureVersion(db, "prj_1", 9)).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("listProjectSessionFiles", () => {
  it("returns one row per session+path with the latest touch", () => {
    const db = openTestDb();
    try {
      upsertProject(db, { id: "prj_1", root: "/repo", name: "repo" });
      seedSession(db, "ses_a");
      seedSession(db, "ses_b");
      const file = (path: string) => ({
        path,
        mode: null,
        blobOid: null,
        size: null,
        sha256: null,
        captured: true,
        reason: null,
      });
      insertSnapshot(db, {
        id: "snap_a1",
        sessionId: "ses_a",
        commitOid: "a1",
        parentOid: null,
        trigger: "baseline",
        eventId: null,
        takenAt: "2026-10-28T10:00:00.000Z",
        fileCount: 1,
        totalBytes: 10,
        status: "ok",
        diagnostics: [],
        files: [file("src/a.ts")],
      });
      insertSnapshot(db, {
        id: "snap_a2",
        sessionId: "ses_a",
        commitOid: "a2",
        parentOid: "a1",
        trigger: "final",
        eventId: null,
        takenAt: "2026-10-28T12:00:00.000Z",
        fileCount: 2,
        totalBytes: 20,
        status: "ok",
        diagnostics: [],
        files: [file("src/a.ts"), file("src/b.ts")],
      });
      insertSnapshot(db, {
        id: "snap_b1",
        sessionId: "ses_b",
        commitOid: "b1",
        parentOid: null,
        trigger: "final",
        eventId: null,
        takenAt: "2026-10-28T11:00:00.000Z",
        fileCount: 1,
        totalBytes: 10,
        status: "ok",
        diagnostics: [],
        files: [file("src/a.ts")],
      });

      const { rows, truncated } = listProjectSessionFiles(db, "prj_1");
      expect(truncated).toBe(false);
      expect(rows).toEqual([
        { sessionId: "ses_a", path: "src/a.ts", takenAt: "2026-10-28T12:00:00.000Z" },
        { sessionId: "ses_a", path: "src/b.ts", takenAt: "2026-10-28T12:00:00.000Z" },
        { sessionId: "ses_b", path: "src/a.ts", takenAt: "2026-10-28T11:00:00.000Z" },
      ]);
      expect(listProjectSessionFiles(db, "prj_1", 2).truncated).toBe(true);
    } finally {
      db.close();
    }
  });
});
