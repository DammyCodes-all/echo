import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getProject,
  insertSnapshot,
  listProjectTouchedFiles,
  openEchoDb,
  upsertProject,
  upsertSession,
} from "./index";

function openTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "echo-proj-"));
  return openEchoDb(join(dir, "echo.sqlite"));
}

describe("project overview queries", () => {
  it("returns null for unknown projects", () => {
    const db = openTestDb();
    try {
      expect(getProject(db, "missing")).toBeNull();
      expect(listProjectTouchedFiles(db, "missing").files).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("aggregates touched files across sessions newest-touch last", () => {
    const db = openTestDb();
    try {
      upsertProject(db, { id: "prj_1", root: "/repo", name: "repo" });
      for (const sid of ["ses_a", "ses_b"]) {
        upsertSession(db, {
          id: sid,
          projectId: "prj_1",
          agent: "muse",
          model: null,
          directory: "/repo",
          title: null,
          startedAt: "2026-10-28T10:00:00.000Z",
          tapePath: `/tmp/${sid}.jsonl`,
          captureQuality: "full",
        });
      }
      insertSnapshot(db, {
        id: "snap_a",
        sessionId: "ses_a",
        commitOid: "aaa",
        parentOid: null,
        trigger: "final",
        eventId: null,
        takenAt: "2026-10-28T10:00:00.000Z",
        fileCount: 2,
        totalBytes: 10,
        status: "ok",
        diagnostics: [],
        files: [
          {
            path: "src/a.ts",
            mode: null,
            blobOid: "b1",
            size: 5,
            sha256: "s1",
            captured: true,
            reason: null,
          },
          {
            path: "src/shared.ts",
            mode: null,
            blobOid: "b2",
            size: 5,
            sha256: "s2",
            captured: true,
            reason: null,
          },
        ],
      });
      insertSnapshot(db, {
        id: "snap_b",
        sessionId: "ses_b",
        commitOid: "bbb",
        parentOid: null,
        trigger: "final",
        eventId: null,
        takenAt: "2026-10-28T11:00:00.000Z",
        fileCount: 1,
        totalBytes: 5,
        status: "ok",
        diagnostics: [],
        files: [
          {
            path: "src/shared.ts",
            mode: null,
            blobOid: "b3",
            size: 5,
            sha256: "s3",
            captured: true,
            reason: null,
          },
        ],
      });
      const project = getProject(db, "prj_1");
      expect(project?.sessionCount).toBe(2);
      const { files, truncated } = listProjectTouchedFiles(db, "prj_1");
      expect(truncated).toBe(false);
      expect(files[0]).toMatchObject({ path: "src/shared.ts", sessionCount: 2 });
      expect(files).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
