import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openEchoDb } from "./database";
import {
  getChangeRefs,
  getProgress,
  getResumePointer,
  recordChangeRef,
  recordProgress,
  upsertProject,
  upsertSession,
} from "./repositories";

function openTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "echo-db-reader-"));
  return openEchoDb(join(dir, "echo.sqlite"));
}

function seed(db: ReturnType<typeof openTestDb>): void {
  upsertProject(db, { id: "prj_1", root: "/repo", name: "repo" });
  upsertSession(db, {
    id: "ses_1",
    projectId: "prj_1",
    agent: "muse",
    model: null,
    directory: "/repo",
    title: null,
    startedAt: null,
    tapePath: "/data/tape.jsonl",
    captureQuality: "full",
  });
}

describe("review-reader change storage", () => {
  it("creates the change tables via the additive migration", () => {
    const db = openTestDb();
    try {
      const names = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('change_refs', 'change_progress') ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(names.map((row) => row.name)).toEqual(["change_progress", "change_refs"]);
      const versions = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
        version: number;
      }>;
      expect(versions.map((row) => row.version)).toContain(13);
    } finally {
      db.close();
    }
  });

  it("records change refs with id/version identity and keeps old versions on regen", () => {
    const db = openTestDb();
    try {
      seed(db);
      expect(getChangeRefs(db, "ses_1")).toEqual([]);
      recordChangeRef(db, {
        sessionId: "ses_1",
        changeId: "c_aaaaaaaaaaaaaaaa",
        version: 1,
        prevOid: "aaa",
        nextOid: "bbb",
      });
      // Same span, different hash: new version row, old row kept.
      recordChangeRef(db, {
        sessionId: "ses_1",
        changeId: "c_aaaaaaaaaaaaaaaa",
        version: 2,
        prevOid: "aaa",
        nextOid: "ccc",
      });
      recordChangeRef(db, {
        sessionId: "ses_1",
        changeId: "c_bbbbbbbbbbbbbbbb",
        version: 1,
        prevOid: "bbb",
        nextOid: "ddd",
      });
      const refs = getChangeRefs(db, "ses_1");
      expect(refs.map((row) => [row.changeId, row.version, row.prevOid, row.nextOid])).toEqual([
        ["c_aaaaaaaaaaaaaaaa", 1, "aaa", "bbb"],
        ["c_aaaaaaaaaaaaaaaa", 2, "aaa", "ccc"],
        ["c_bbbbbbbbbbbbbbbb", 1, "bbb", "ddd"],
      ]);
      // Re-recording the identical key dedupes and keeps the original row.
      const before = refs[0]?.createdAt;
      recordChangeRef(db, {
        sessionId: "ses_1",
        changeId: "c_aaaaaaaaaaaaaaaa",
        version: 1,
        prevOid: "aaa",
        nextOid: "bbb",
      });
      expect(getChangeRefs(db, "ses_1")).toHaveLength(3);
      expect(getChangeRefs(db, "ses_1")[0]?.createdAt).toBe(before);
      expect(getChangeRefs(db, "ses_missing")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("stores only ids and oids in change refs, never code bodies", () => {
    const db = openTestDb();
    try {
      seed(db);
      recordChangeRef(db, {
        sessionId: "ses_1",
        changeId: "c_aaaaaaaaaaaaaaaa",
        version: 1,
        prevOid: "aaa",
        nextOid: "bbb",
      });
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('change_refs')")
        .all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        "session_id",
        "change_id",
        "version",
        "prev_oid",
        "next_oid",
        "created_at",
      ]);
      const progressColumns = db
        .prepare("SELECT name FROM pragma_table_info('change_progress')")
        .all() as Array<{ name: string }>;
      expect(progressColumns.map((column) => column.name)).toEqual([
        "session_id",
        "change_id",
        "version",
        "state",
        "updated_at",
      ]);
    } finally {
      db.close();
    }
  });

  it("records progress per (id, version) with latest write winning", () => {
    const db = openTestDb();
    try {
      seed(db);
      expect(getProgress(db, "ses_1")).toEqual([]);
      recordProgress(db, {
        sessionId: "ses_1",
        changeId: "c_aaaaaaaaaaaaaaaa",
        version: 1,
        state: "viewed",
      });
      recordProgress(db, {
        sessionId: "ses_1",
        changeId: "c_aaaaaaaaaaaaaaaa",
        version: 1,
        state: "understood",
      });
      recordProgress(db, {
        sessionId: "ses_1",
        changeId: "c_aaaaaaaaaaaaaaaa",
        version: 2,
        state: "viewed",
      });
      // Old version progress is never reset by regen: v1 stays understood.
      expect(getProgress(db, "ses_1").map((row) => [row.changeId, row.version, row.state])).toEqual(
        [
          ["c_aaaaaaaaaaaaaaaa", 1, "understood"],
          ["c_aaaaaaaaaaaaaaaa", 2, "viewed"],
        ],
      );
      expect(getProgress(db, "ses_missing")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("resumes at the first not-understood change in order", () => {
    const db = openTestDb();
    try {
      seed(db);
      const order = ["c_aaaaaaaaaaaaaaaa", "c_bbbbbbbbbbbbbbbb"];
      expect(getResumePointer(db, "ses_1", order)).toBe("c_aaaaaaaaaaaaaaaa");
      expect(getResumePointer(db, "ses_1", [])).toBe(null);
      for (const changeId of order) {
        recordChangeRef(db, {
          sessionId: "ses_1",
          changeId,
          version: 1,
          prevOid: "a",
          nextOid: "b",
        });
      }
      recordProgress(db, {
        sessionId: "ses_1",
        changeId: "c_aaaaaaaaaaaaaaaa",
        version: 1,
        state: "understood",
      });
      expect(getResumePointer(db, "ses_1", order)).toBe("c_bbbbbbbbbbbbbbbb");
      // Skipped still counts as not-understood.
      recordProgress(db, {
        sessionId: "ses_1",
        changeId: "c_bbbbbbbbbbbbbbbb",
        version: 1,
        state: "skipped",
      });
      expect(getResumePointer(db, "ses_1", order)).toBe("c_bbbbbbbbbbbbbbbb");
      recordProgress(db, {
        sessionId: "ses_1",
        changeId: "c_bbbbbbbbbbbbbbbb",
        version: 1,
        state: "understood",
      });
      expect(getResumePointer(db, "ses_1", order)).toBe(null);
    } finally {
      db.close();
    }
  });

  it("points at a regen version until the new version is understood", () => {
    const db = openTestDb();
    try {
      seed(db);
      const order = ["c_aaaaaaaaaaaaaaaa"];
      recordChangeRef(db, {
        sessionId: "ses_1",
        changeId: "c_aaaaaaaaaaaaaaaa",
        version: 1,
        prevOid: "a",
        nextOid: "b",
      });
      recordProgress(db, {
        sessionId: "ses_1",
        changeId: "c_aaaaaaaaaaaaaaaa",
        version: 1,
        state: "understood",
      });
      expect(getResumePointer(db, "ses_1", order)).toBe(null);
      // Regen: same span, new hash, new version. Old progress stays but the
      // pointer moves back to the change until v2 is understood.
      recordChangeRef(db, {
        sessionId: "ses_1",
        changeId: "c_aaaaaaaaaaaaaaaa",
        version: 2,
        prevOid: "a",
        nextOid: "c",
      });
      expect(getResumePointer(db, "ses_1", order)).toBe("c_aaaaaaaaaaaaaaaa");
      recordProgress(db, {
        sessionId: "ses_1",
        changeId: "c_aaaaaaaaaaaaaaaa",
        version: 2,
        state: "understood",
      });
      expect(getResumePointer(db, "ses_1", order)).toBe(null);
    } finally {
      db.close();
    }
  });
});
