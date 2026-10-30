import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TapeEvent } from "@echo/contracts";
import { describe, expect, it } from "vitest";
import {
  appendEvents,
  deleteEchoSession,
  deriveEngagementTiers,
  ensureIngestProject,
  getArtifactRef,
  getReaderCheckpoint,
  getReviewTransition,
  getSession,
  getSessionBuildPin,
  getSessionEventIds,
  getSessionSummary,
  getSnapshotByCommit,
  getStackRegenState,
  hasEventKind,
  insertSnapshot,
  latestSnapshot,
  listBuildVersions,
  listEngagementEvents,
  listProjects,
  listReaderCheckpoints,
  listSessions,
  listSnapshotFiles,
  MIGRATIONS,
  openEchoDb,
  pruneReaderCheckpoints,
  putReviewTransition,
  REVIEW_CACHE_VERSION,
  readAllEvents,
  readEvents,
  recordEngagementEvents,
  saveStackRegenState,
  sessionHasUserData,
  setSessionCheckStatus,
  setSessionStoryState,
  upsertArtifactRef,
  upsertProject,
  upsertReaderCheckpoint,
  upsertSession,
  upsertSessionBuildPin,
} from "./index";

function makeEvent(seq: number, overrides: Partial<TapeEvent> = {}): TapeEvent {
  return {
    v: 1,
    tape_seq: seq,
    event_id: `evt_test_${seq}`,
    record_key: null,
    session_id: "ses_1",
    project_id: "prj_1",
    kind: "tool.completed",
    ts: "2026-10-27T10:00:00.000Z",
    observed_at: "2026-10-27T10:00:00.050Z",
    source: {
      agent: "opencode",
      adapter: "opencode-sqlite",
      adapter_version: "0.1.0",
      build: null,
      schema: "opencode.db/session_v2",
      record_type: "assistant",
      payload_type: null,
      sequence: seq,
      durability: null,
      origin: "import",
    },
    links: {
      turn_id: null,
      tool_call_id: `prt_${seq}`,
      batch_id: null,
      parent_session_id: null,
      subagent_id: null,
      snapshot: null,
    },
    payload: { name: "read", outcome: "ok" },
    redaction: { version: "r1", findings: 0 },
    diagnostics: [],
    ...overrides,
  };
}

function openTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "echo-db-"));
  return openEchoDb(join(dir, "echo.sqlite"));
}

function seed(db: ReturnType<typeof openTestDb>, captureQuality = "import_only"): void {
  upsertProject(db, {
    id: "prj_1",
    root: "/repo",
    remoteUrl: "github.com/example/echo",
    name: "repo",
  });
  upsertSession(db, {
    id: "ses_1",
    projectId: "prj_1",
    agent: "opencode",
    model: '{"id":"gpt-6.1-sol"}',
    directory: "/repo",
    title: "spike",
    startedAt: "2026-10-27T09:00:00.000Z",
    tapePath: "/data/tape.jsonl",
    captureQuality,
  });
}

describe("openEchoDb migrations", () => {
  it("is idempotent across reopens", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-db-"));
    const path = join(dir, "echo.sqlite");
    const first = openEchoDb(path);
    first.close();
    const second = openEchoDb(path);
    const rows = second.prepare("SELECT version FROM schema_migrations").all() as Array<{
      version: number;
    }>;
    second.close();
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("waits on locked writers instead of failing fast", () => {
    const db = openTestDb();
    const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(row.timeout).toBeGreaterThan(0);
    db.close();
  });

  it("heals databases migrated when remote_url was version 3", () => {
    // Merge c6b7479 renumbered v3 (remote_url -> reader_checkpoints, remote_url
    // -> v4). A database migrated on the old branch records v3 with the
    // remote_url column present and no reader_checkpoints table; opening it
    // must backfill checkpoints and record v4+ instead of duplicate-column.
    const dir = mkdtempSync(join(tmpdir(), "echo-db-legacy-"));
    const path = join(dir, "echo.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    legacy.exec(MIGRATIONS[0]?.sql as string);
    legacy.exec(MIGRATIONS[1]?.sql as string);
    legacy.exec(
      "ALTER TABLE projects ADD COLUMN remote_url TEXT; CREATE UNIQUE INDEX idx_projects_remote_url ON projects(remote_url) WHERE remote_url IS NOT NULL;",
    );
    const now = new Date().toISOString();
    legacy
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?), (2, ?), (3, ?)")
      .run(now, now, now);
    legacy.close();

    const db = openEchoDb(path);
    const rows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
      version: number;
    }>;
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const checkpoints = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reader_checkpoints'",
      )
      .get() as { name?: string } | null;
    expect(checkpoints?.name).toBe("reader_checkpoints");
    const projectColumns = db
      .prepare("SELECT name FROM pragma_table_info('projects')")
      .all() as Array<{
      name: string;
    }>;
    expect(projectColumns.map((column) => column.name)).toContain("remote_url");
    db.close();

    const reopened = openEchoDb(path);
    reopened.close();
  });

  it("heals databases migrated when project_architecture_versions was version 11", () => {
    // The architecture branch shipped its table as v11 while main shipped
    // review_transition_cache as v11; the architecture table moved to v12. A
    // database migrated on the architecture branch records v11 with the
    // architecture table present and no review_transition_cache table;
    // opening it must backfill the cache table and record v12.
    const dir = mkdtempSync(join(tmpdir(), "echo-db-legacy-v11-"));
    const path = join(dir, "echo.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const migration of MIGRATIONS) {
      if (migration.version === 11) continue;
      // Mirror migrate(): statements run one at a time so a repeated ADD
      // COLUMN (v9 heals the in-place v7 edit that already ships the column)
      // is skipped instead of failing the replay.
      for (const statement of migration.sql.split(";")) {
        const trimmed = statement.trim();
        if (trimmed === "") continue;
        try {
          legacy.exec(trimmed);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const duplicateColumn = /duplicate column/i.test(message);
          const addColumn = /^alter\s+table\s+\S+\s+add\s+column\s+/i.test(trimmed);
          if (!(duplicateColumn && addColumn)) throw error;
        }
      }
    }
    const now = new Date().toISOString();
    legacy
      .prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?), (2, ?), (3, ?), (4, ?), (5, ?), (6, ?), (7, ?), (8, ?), (9, ?), (10, ?), (11, ?)",
      )
      .run(now, now, now, now, now, now, now, now, now, now, now);
    legacy.close();

    const db = openEchoDb(path);
    const rows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
      version: number;
    }>;
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const cache = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_transition_cache'",
      )
      .get() as { name?: string } | null;
    expect(cache?.name).toBe("review_transition_cache");
    const arch = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_architecture_versions'",
      )
      .get() as { name?: string } | null;
    expect(arch?.name).toBe("project_architecture_versions");
    db.close();
  });
});

describe("repositories", () => {
  it("appends events with sequential tape_seq and dedupes by event id", () => {
    const db = openTestDb();
    seed(db);
    expect(appendEvents(db, "ses_1", [makeEvent(0), makeEvent(1)])).toBe(2);
    expect(appendEvents(db, "ses_1", [makeEvent(0), makeEvent(1)])).toBe(0);
    expect(getSessionEventIds(db, "ses_1").size).toBe(2);

    const page = readEvents(db, "ses_1", 0, 10);
    expect(page.map((row) => row.tape_seq)).toEqual([1, 2]);
    expect(readAllEvents(db, "ses_1", true, 1).map((row) => row.event_id)).toEqual([
      "evt_test_0",
      "evt_test_1",
    ]);
    expect(page[0]?.kind).toBe("tool.completed");
    expect(page[0]?.tool_call_id).toBe("prt_0");
    expect(hasEventKind(db, "ses_1", "tool.completed")).toBe(true);
    expect(hasEventKind(db, "ses_1", "capture.reconciled")).toBe(false);
    expect(hasEventKind(db, "ses_missing", "tool.completed")).toBe(false);
    db.close();
  });

  it("lists projects with counts and sessions with logical event counts", () => {
    const db = openTestDb();
    seed(db);
    appendEvents(db, "ses_1", [makeEvent(0)]);

    const projects = listProjects(db);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: "prj_1",
      root: "/repo",
      remoteUrl: "github.com/example/echo",
      sessionCount: 1,
    });

    const sessions = listSessions(db, "prj_1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "ses_1", eventCount: 1, title: "spike" });
    db.close();
  });

  it("returns a single session summary and null for unknown sessions", () => {
    const db = openTestDb();
    seed(db);
    appendEvents(db, "ses_1", [makeEvent(0)]);
    expect(getSessionSummary(db, "ses_1")).toMatchObject({
      id: "ses_1",
      projectId: "prj_1",
      captureQuality: "import_only",
      eventCount: 1,
    });
    expect(getSessionSummary(db, "ses_missing")).toBeNull();
    db.close();
  });

  it("reports lastActivity as the latest observed event, else the session touch", () => {
    const db = openTestDb();
    seed(db);
    appendEvents(db, "ses_1", [
      makeEvent(1, {
        event_id: "evt_late",
        ts: "2026-10-28T12:00:00.000Z",
        observed_at: "2026-10-28T12:00:00.050Z",
      }),
      makeEvent(0, { event_id: "evt_early" }),
    ]);
    expect(listSessions(db, "prj_1")[0]?.lastActivity).toBe("2026-10-28T12:00:00.050Z");
    expect(getSessionSummary(db, "ses_1")?.lastActivity).toBe("2026-10-28T12:00:00.050Z");

    upsertSession(db, {
      id: "ses_bare",
      projectId: "prj_1",
      agent: "opencode",
      model: null,
      directory: "/repo",
      title: null,
      startedAt: null,
      tapePath: "/data/bare.jsonl",
      captureQuality: "import_only",
    });
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      "2026-10-26T00:00:00.000Z",
      "ses_bare",
    );
    expect(getSessionSummary(db, "ses_bare")?.lastActivity).toBe("2026-10-26T00:00:00.000Z");
    db.close();
  });

  it("orders sessions by lastActivity, newest first, id tiebreak", () => {
    const db = openTestDb();
    seed(db);
    for (const id of ["ses_2", "ses_3"]) {
      upsertSession(db, {
        id,
        projectId: "prj_1",
        agent: "opencode",
        model: null,
        directory: "/repo",
        title: null,
        startedAt: "2026-10-28T09:00:00.000Z",
        tapePath: `/data/${id}.jsonl`,
        captureQuality: "import_only",
      });
    }
    // ses_1 started first but went active last; ses_2/ses_3 tie.
    appendEvents(db, "ses_1", [
      makeEvent(0, {
        event_id: "evt_newest",
        ts: "2026-10-29T00:00:00.000Z",
        observed_at: "2026-10-29T00:00:00.050Z",
      }),
    ]);
    appendEvents(db, "ses_2", [
      makeEvent(0, {
        event_id: "evt_mid_2",
        session_id: "ses_2",
        ts: "2026-10-28T10:00:00.000Z",
        observed_at: "2026-10-28T10:00:00.050Z",
      }),
    ]);
    appendEvents(db, "ses_3", [
      makeEvent(0, {
        event_id: "evt_mid_3",
        session_id: "ses_3",
        ts: "2026-10-28T10:00:00.000Z",
        observed_at: "2026-10-28T10:00:00.050Z",
      }),
    ]);
    expect(listSessions(db, "prj_1").map((row) => row.id)).toEqual(["ses_1", "ses_2", "ses_3"]);
    db.close();
  });

  it("keeps the same project when its folder moves with the same remote", () => {
    const db = openTestDb();
    seed(db);
    upsertProject(db, {
      id: "prj_1",
      root: "/moved/echo",
      remoteUrl: "github.com/example/echo",
      name: "echo",
    });

    expect(listProjects(db)[0]).toMatchObject({
      id: "prj_1",
      root: "/moved/echo",
      remoteUrl: "github.com/example/echo",
      name: "echo",
    });
    db.close();
  });

  it("adopts the existing row when a later identity claims the same root", () => {
    const db = openTestDb();
    seed(db);
    // A remote that appears mid-life must not split the repo in two: the
    // root-based row wins, keeps its id, and absorbs the remote.
    const resolved = upsertProject(db, {
      id: "prj_remote",
      root: "/repo",
      remoteUrl: "github.com/example/echo",
      name: "repo",
    });

    expect(resolved).toBe("prj_1");
    expect(listProjects(db)).toHaveLength(1);
    expect(listProjects(db)[0]).toMatchObject({
      id: "prj_1",
      root: "/repo",
      remoteUrl: "github.com/example/echo",
    });
    db.close();
  });

  it("keeps the stored remote when a later upsert omits it", () => {
    const db = openTestDb();
    seed(db);
    upsertProject(db, { id: "prj_1", root: "/repo", name: "repo" });

    expect(listProjects(db)[0]).toMatchObject({
      id: "prj_1",
      remoteUrl: "github.com/example/echo",
    });
    db.close();
  });

  it("projects the latest revision per record and keeps history available", () => {
    const db = openTestDb();
    seed(db);
    const pending = makeEvent(0, {
      event_id: "evt_pending",
      record_key: "opencode:ses_1:msg:msg_1:tool:prt_1",
      kind: "tool.requested",
      payload: { status: "running" },
    });
    const completed = makeEvent(1, {
      event_id: "evt_completed",
      record_key: pending.record_key,
      kind: "tool.completed",
      payload: { status: "completed" },
    });
    appendEvents(db, "ses_1", [pending, completed]);

    const latest = readEvents(db, "ses_1", 0, 10);
    expect(latest.map((row) => row.event_id)).toEqual(["evt_completed"]);
    expect(latest.map((row) => row.tape_seq)).toEqual([2]);
    expect(latest.map((row) => row.position_seq)).toEqual([1]);

    const all = readEvents(db, "ses_1", 0, 10, true);
    expect(all.map((row) => row.event_id)).toEqual(["evt_pending", "evt_completed"]);

    expect(listSessions(db, "prj_1")[0]?.eventCount).toBe(1);
    db.close();
  });

  it("pages the projected timeline by position across revisions", () => {
    const db = openTestDb();
    seed(db);
    const revised = "opencode:ses_1:msg:msg_1";
    appendEvents(db, "ses_1", [
      makeEvent(0, { event_id: "evt_rev1", record_key: revised, kind: "tool.requested" }),
      makeEvent(0, { event_id: "evt_other", record_key: "opencode:ses_1:msg:msg_2" }),
      makeEvent(0, { event_id: "evt_rev2", record_key: revised, kind: "tool.completed" }),
    ]);

    const first = readEvents(db, "ses_1", 0, 1);
    expect(first.map((row) => row.event_id)).toEqual(["evt_rev2"]);
    const second = readEvents(db, "ses_1", 1, 1);
    expect(second.map((row) => row.event_id)).toEqual(["evt_other"]);
    db.close();
  });

  it("resolves sessions and snapshots for file views", () => {
    const db = openTestDb();
    seed(db);
    expect(getSession(db, "ses_1")).toEqual({ id: "ses_1", projectId: "prj_1" });
    expect(getSession(db, "ses_missing")).toBeNull();

    insertSnapshot(db, {
      id: "commit_1",
      sessionId: "ses_1",
      commitOid: "commit_1",
      parentOid: null,
      trigger: "baseline",
      eventId: "evt_snapshot",
      takenAt: "2026-10-27T10:05:00.000Z",
      fileCount: 0,
      totalBytes: 0,
      status: "ok",
      diagnostics: [],
      files: [],
    });
    expect(getSnapshotByCommit(db, "ses_1", "commit_1")?.trigger).toBe("baseline");
    expect(getSnapshotByCommit(db, "ses_1", "commit_missing")).toBeNull();
    expect(getSnapshotByCommit(db, "ses_missing", "commit_1")).toBeNull();
    db.close();
  });

  it("stores snapshot commits with per-file capture decisions", () => {
    const db = openTestDb();
    seed(db);
    const inserted = insertSnapshot(db, {
      id: "commit_1",
      sessionId: "ses_1",
      commitOid: "commit_1",
      parentOid: null,
      trigger: "baseline",
      eventId: "evt_snapshot",
      takenAt: "2026-10-27T10:05:00.000Z",
      fileCount: 1,
      totalBytes: 12,
      status: "ok",
      diagnostics: [],
      files: [
        {
          path: "src/index.ts",
          mode: "100644",
          blobOid: "blob_1",
          size: 12,
          sha256: "abc",
          captured: true,
          reason: null,
        },
        {
          path: "assets/logo.png",
          mode: "100644",
          blobOid: null,
          size: 99,
          sha256: null,
          captured: false,
          reason: "binary",
        },
      ],
    });
    expect(inserted).toBe(true);
    expect(
      insertSnapshot(db, {
        id: "commit_1",
        sessionId: "ses_1",
        commitOid: "commit_1",
        parentOid: null,
        trigger: "baseline",
        eventId: "evt_snapshot",
        takenAt: "2026-10-27T10:05:00.000Z",
        fileCount: 0,
        totalBytes: 0,
        status: "ok",
        diagnostics: [],
        files: [],
      }),
    ).toBe(false);

    expect(latestSnapshot(db, "ses_1")?.commitOid).toBe("commit_1");
    expect(latestSnapshot(db, "ses_1", "final")).toBeNull();
    const files = listSnapshotFiles(db, "commit_1");
    expect(files.map((file) => [file.path, file.captured, file.reason])).toEqual([
      ["assets/logo.png", false, "binary"],
      ["src/index.ts", true, null],
    ]);
    db.close();
  });

  it("round-trips reader checkpoints per lane and prunes dead child lanes", () => {
    const db = openTestDb();
    seed(db);
    const now = "2026-10-28T10:00:00.000Z";
    expect(getReaderCheckpoint(db, "ses_1", "")).toBeNull();
    upsertReaderCheckpoint(db, {
      sessionId: "ses_1",
      lane: "",
      sourcePath: "/sessions/ses_1/session.jsonl",
      inode: 42,
      offset: 128,
      lastSequence: 7,
      lastEventTs: "2026-10-28T09:59:00.000Z",
      lastMarkerAfter: null,
      markerCount: 1,
      sessionStarted: true,
      schemaVersion: 1,
      adapterVersion: "0.1.0",
      build: null,
      status: "active",
      error: null,
      lastReadAt: now,
    });
    upsertReaderCheckpoint(db, {
      sessionId: "ses_1",
      lane: "child-9",
      sourcePath: "/sessions/ses_1/subagent/child-9/session.jsonl",
      inode: 43,
      offset: 64,
      lastSequence: 3,
      lastEventTs: null,
      lastMarkerAfter: null,
      markerCount: 0,
      sessionStarted: false,
      schemaVersion: 1,
      adapterVersion: "0.1.0",
      build: null,
      status: "active",
      error: null,
      lastReadAt: now,
    });
    expect(getReaderCheckpoint(db, "ses_1", "")).toMatchObject({
      offset: 128,
      lastSequence: 7,
      inode: 42,
      sessionStarted: true,
    });
    expect(listReaderCheckpoints(db, "ses_1").map((row) => row.lane)).toEqual(["", "child-9"]);
    // Resume state survives an update; the parent lane is never pruned.
    upsertReaderCheckpoint(db, {
      ...(getReaderCheckpoint(db, "ses_1", "") as NonNullable<
        ReturnType<typeof getReaderCheckpoint>
      >),
      offset: 256,
    });
    expect(getReaderCheckpoint(db, "ses_1", "")?.offset).toBe(256);
    expect(pruneReaderCheckpoints(db, "ses_1", [])).toBe(1);
    expect(listReaderCheckpoints(db, "ses_1").map((row) => row.lane)).toEqual([""]);
    expect(getReaderCheckpoint(db, "ses_missing", "")).toBeNull();
    db.close();
  });

  it("round-trips session build pins and summarizes versions", () => {
    const db = openTestDb();
    seed(db);
    expect(getSessionBuildPin(db, "ses_1")).toBeNull();
    upsertSessionBuildPin(db, {
      sessionId: "ses_1",
      museVersion: "Muse Code 1.4.13",
      adapterVersion: "0.1.0",
      exportSchemaVersion: null,
      observedAt: "2026-10-28T10:00:00.000Z",
    });
    expect(getSessionBuildPin(db, "ses_1")).toMatchObject({
      museVersion: "Muse Code 1.4.13",
      exportSchemaVersion: null,
    });
    // Export reconciliation fills in the schema version without losing the pin.
    upsertSessionBuildPin(db, {
      sessionId: "ses_1",
      museVersion: "Muse Code 1.4.13",
      adapterVersion: "0.1.0",
      exportSchemaVersion: 1,
      observedAt: "2026-10-28T11:00:00.000Z",
    });
    expect(getSessionBuildPin(db, "ses_1")?.exportSchemaVersion).toBe(1);
    expect(listBuildVersions(db)).toEqual([
      { museVersion: "Muse Code 1.4.13", sessions: 1, lastObserved: "2026-10-28T11:00:00.000Z" },
    ]);
    expect(getSessionBuildPin(db, "ses_missing")).toBeNull();
    db.close();
  });

  it("defaults check status and capture state on new sessions", () => {
    const db = openTestDb();
    seed(db);
    // No story artifact yet → still-recording (Q47), even with import_only quality.
    const summary = getSessionSummary(db, "ses_1");
    expect(summary).toMatchObject({
      checkStatus: "not_checked",
      summary: null,
      highRiskCount: 0,
      captureState: "recording",
    });
    expect(listSessions(db, "prj_1")[0]).toMatchObject({
      checkStatus: "not_checked",
      captureState: "recording",
    });
    db.close();
  });

  it("round-trips check status", () => {
    const db = openTestDb();
    seed(db);
    setSessionCheckStatus(db, "ses_1", "checked");
    expect(getSessionSummary(db, "ses_1")?.checkStatus).toBe("checked");
    setSessionCheckStatus(db, "ses_1", "skipped");
    expect(getSessionSummary(db, "ses_1")?.checkStatus).toBe("skipped");
    db.close();
  });

  it("round-trips story state", () => {
    const db = openTestDb();
    seed(db);
    setSessionStoryState(db, "ses_1", { summary: "Root cause: race in import.", highRiskCount: 2 });
    expect(getSessionSummary(db, "ses_1")).toMatchObject({
      summary: "Root cause: race in import.",
      highRiskCount: 2,
    });
    setSessionStoryState(db, "ses_1", { summary: null, highRiskCount: 0 });
    expect(getSessionSummary(db, "ses_1")).toMatchObject({ summary: null, highRiskCount: 0 });
    db.close();
  });

  it("dedupes engagement events by id and derives tiers with engaged precedence", () => {
    const db = openTestDb();
    seed(db);
    const first = recordEngagementEvents(db, "ses_1", [
      { id: "eng_1", cardId: "card_a", kind: "card_seen", occurredAt: "2026-10-28T10:00:00.000Z" },
      { id: "eng_2", cardId: "card_a", kind: "code_shown", occurredAt: "2026-10-28T10:01:00.000Z" },
      { id: "eng_3", cardId: "card_b", kind: "card_seen", occurredAt: "2026-10-28T10:02:00.000Z" },
      { id: "eng_4", cardId: null, kind: "story_opened", occurredAt: "2026-10-28T10:03:00.000Z" },
    ]);
    expect(first).toBe(4);
    const second = recordEngagementEvents(db, "ses_1", [
      { id: "eng_1", cardId: "card_a", kind: "card_seen", occurredAt: "2026-10-28T10:00:00.000Z" },
      { id: "eng_2", cardId: "card_a", kind: "code_shown", occurredAt: "2026-10-28T10:01:00.000Z" },
    ]);
    expect(second).toBe(0);

    const events = listEngagementEvents(db, "ses_1");
    expect(events.map((row) => row.id)).toEqual(["eng_1", "eng_2", "eng_3", "eng_4"]);
    expect(events[0]).toMatchObject({ sessionId: "ses_1", cardId: "card_a", kind: "card_seen" });

    expect(deriveEngagementTiers(db, "ses_1", ["card_a", "card_b", "card_c"])).toEqual({
      card_a: "engaged",
      card_b: "seen",
      card_c: "unseen",
    });
    db.close();
  });

  it("upserts artifact refs and returns null for missing kinds", () => {
    const db = openTestDb();
    seed(db);
    expect(getArtifactRef(db, "ses_1", "story")).toBeNull();
    upsertArtifactRef(db, {
      sessionId: "ses_1",
      kind: "story",
      path: "/data/story_v1.md",
      tapeWatermark: { eventCount: 10, sha256: "aaa" },
      generator: "storyteller-0.1",
      generatedAt: "2026-10-28T10:00:00.000Z",
    });
    expect(getArtifactRef(db, "ses_1", "story")).toMatchObject({
      sessionId: "ses_1",
      kind: "story",
      path: "/data/story_v1.md",
      tapeWatermark: { eventCount: 10, sha256: "aaa" },
    });
    upsertArtifactRef(db, {
      sessionId: "ses_1",
      kind: "story",
      path: "/data/story_v2.md",
      tapeWatermark: { eventCount: 12, sha256: "bbb" },
      generator: "storyteller-0.2",
      generatedAt: "2026-10-28T11:00:00.000Z",
    });
    expect(getArtifactRef(db, "ses_1", "story")).toMatchObject({
      path: "/data/story_v2.md",
      tapeWatermark: { eventCount: 12, sha256: "bbb" },
      generator: "storyteller-0.2",
    });
    expect(getArtifactRef(db, "ses_1", "checks_v2")).toBeNull();
    db.close();
  });

  it("derives inbox capture state from the story artifact watermark", () => {
    const db = openTestDb();
    seed(db, "full");
    appendEvents(db, "ses_1", [makeEvent(0), makeEvent(1)]);

    // (1) Fresh session with no story artifact → still-recording.
    expect(getSessionSummary(db, "ses_1")).toMatchObject({ eventCount: 2 });
    expect(getSessionSummary(db, "ses_1")?.captureState).toBe("recording");

    // (2) Story artifact watermarked at the current tape → quality-derived state.
    upsertArtifactRef(db, {
      sessionId: "ses_1",
      kind: "story",
      path: "/data/story_v1.md",
      tapeWatermark: { eventCount: 2, sha256: "aaa" },
      generator: "storyteller-0.1",
      generatedAt: "2026-10-28T10:00:00.000Z",
    });
    expect(getSessionSummary(db, "ses_1")?.captureState).toBe("ready");
    expect(listSessions(db, "prj_1")[0]?.captureState).toBe("ready");

    // (3) Tape grows past the watermark without a story refresh → recording again.
    appendEvents(db, "ses_1", [makeEvent(2)]);
    expect(getSessionSummary(db, "ses_1")).toMatchObject({ eventCount: 3 });
    expect(getSessionSummary(db, "ses_1")?.captureState).toBe("recording");

    // (4) listSessions reflects the same stale-watermark state for the row.
    const rows = listSessions(db, "prj_1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "ses_1", eventCount: 3, captureState: "recording" });
    db.close();
  });
});

describe("ensureIngestProject", () => {
  it("keeps the historic id when a remote appears on the same root", () => {
    const db = openTestDb();
    try {
      upsertProject(db, { id: "prj_root", root: "/repo", remoteUrl: null, name: "repo" });
      upsertSession(db, {
        id: "ses_old",
        projectId: "prj_root",
        agent: "opencode",
        model: null,
        directory: "/repo",
        title: null,
        startedAt: null,
        tapePath: "/data/tape.jsonl",
        captureQuality: "import_only",
      });
      // Remote added later: derived id changes, but the row (and its
      // sessions) must stay joined instead of throwing UNIQUE(canonical_root).
      const effective = ensureIngestProject(db, {
        id: "prj_remote",
        root: "/repo",
        remoteUrl: "github.com/example/echo",
        name: "repo",
      });
      expect(effective).toBe("prj_root");
      const projects = listProjects(db);
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({
        id: "prj_root",
        remoteUrl: "github.com/example/echo",
      });
      expect(listSessions(db, "prj_root")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("adopts a moved root when the remote matches", () => {
    const db = openTestDb();
    try {
      upsertProject(db, {
        id: "prj_remote",
        root: "/old/repo",
        remoteUrl: "github.com/example/echo",
        name: "repo",
      });
      const effective = ensureIngestProject(db, {
        id: "prj_remote",
        root: "/new/repo",
        remoteUrl: "github.com/example/echo",
        name: "repo",
      });
      expect(effective).toBe("prj_remote");
      expect(listProjects(db)[0]).toMatchObject({ id: "prj_remote", root: "/new/repo" });
    } finally {
      db.close();
    }
  });

  it("inserts truly new repositories", () => {
    const db = openTestDb();
    try {
      const effective = ensureIngestProject(db, {
        id: "prj_new",
        root: "/other",
        remoteUrl: null,
        name: "other",
      });
      expect(effective).toBe("prj_new");
      expect(listProjects(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("project stack regen state", () => {
  it("round-trips the change counter per project", () => {
    const db = openTestDb();
    try {
      upsertProject(db, { id: "prj_stack", root: "/repo", name: "repo" });
      expect(getStackRegenState(db, "prj_stack")).toBeNull();
      saveStackRegenState(db, {
        projectId: "prj_stack",
        lastFilesHash: "abc",
        pendingChanges: 2,
      });
      expect(getStackRegenState(db, "prj_stack")).toEqual({
        projectId: "prj_stack",
        lastFilesHash: "abc",
        pendingChanges: 2,
      });
      saveStackRegenState(db, {
        projectId: "prj_stack",
        lastFilesHash: "def",
        pendingChanges: 0,
      });
      expect(getStackRegenState(db, "prj_stack")).toEqual({
        projectId: "prj_stack",
        lastFilesHash: "def",
        pendingChanges: 0,
      });
    } finally {
      db.close();
    }
  });
});

describe("session title stability", () => {
  it("keeps the first title while other fields update", () => {
    const db = openTestDb();
    try {
      upsertProject(db, { id: "prj_1", root: "/repo", name: "repo" });
      const base = {
        id: "ses_title",
        projectId: "prj_1",
        agent: "opencode",
        model: "model-a",
        directory: "/repo",
        title: "First title",
        startedAt: "2026-10-27T09:00:00.000Z",
        tapePath: "/data/a.jsonl",
        captureQuality: "import_only",
      } as const;
      upsertSession(db, { ...base });
      // A later poll renames the session upstream and moves fields: the
      // title stays, everything else follows.
      upsertSession(db, {
        ...base,
        model: "model-b",
        directory: "/repo/sub",
        title: "Renamed title",
        tapePath: "/data/b.jsonl",
      });
      expect(getSessionSummary(db, "ses_title")).toMatchObject({
        title: "First title",
        model: "model-b",
        directory: "/repo/sub",
      });
      // A null title never clears an established one.
      upsertSession(db, { ...base, model: "model-c", title: null });
      expect(getSessionSummary(db, "ses_title")?.title).toBe("First title");
    } finally {
      db.close();
    }
  });

  it("adopts the first non-empty title, then freezes", () => {
    const db = openTestDb();
    try {
      upsertProject(db, { id: "prj_1", root: "/repo", name: "repo" });
      const base = {
        id: "ses_late",
        projectId: "prj_1",
        agent: "muse",
        model: null,
        directory: "/repo",
        startedAt: null,
        tapePath: "/data/a.jsonl",
        captureQuality: "import_only",
      } as const;
      upsertSession(db, { ...base, title: null });
      expect(getSessionSummary(db, "ses_late")?.title).toBeNull();
      upsertSession(db, { ...base, title: "Late title" });
      expect(getSessionSummary(db, "ses_late")?.title).toBe("Late title");
      upsertSession(db, { ...base, title: "Another rename" });
      expect(getSessionSummary(db, "ses_late")?.title).toBe("Late title");
    } finally {
      db.close();
    }
  });

  it("marks summarySkeleton from the story artifact generator", () => {
    const db = openTestDb();
    try {
      upsertProject(db, { id: "prj_1", root: "/repo", name: "repo" });
      const base = {
        projectId: "prj_1",
        agent: "opencode",
        model: null,
        directory: "/repo",
        title: "Agent title",
        startedAt: null,
        tapePath: "/data/a.jsonl",
        captureQuality: "import_only",
      } as const;
      const artifact = (sessionId: string, generator: string) =>
        upsertArtifactRef(db, {
          sessionId,
          kind: "story",
          path: `/data/${sessionId}.json`,
          tapeWatermark: { eventCount: 1, sha256: "x" },
          generator,
          generatedAt: "2026-10-29T00:00:00.000Z",
        });
      upsertSession(db, { ...base, id: "ses_skel" });
      upsertSession(db, { ...base, id: "ses_model" });
      upsertSession(db, { ...base, id: "ses_none" });
      artifact("ses_skel", "skeleton-v2");
      artifact("ses_model", "muse-spark-1.3-contributor");
      const byId = new Map(listSessions(db, "prj_1").map((session) => [session.id, session]));
      expect(byId.get("ses_skel")).toMatchObject({ summarySkeleton: true });
      expect(byId.get("ses_model")).toMatchObject({ summarySkeleton: false });
      expect(byId.get("ses_none")).toMatchObject({ summarySkeleton: false });
      expect(getSessionSummary(db, "ses_skel")?.summarySkeleton).toBe(true);
      expect(getSessionSummary(db, "ses_model")?.summarySkeleton).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("review transition cache", () => {
  it("round-trips a cached transition", () => {
    const db = openTestDb();
    try {
      const hunks = JSON.stringify([{ path: "src/a.ts", added: 3, removed: 1 }]);
      putReviewTransition(db, {
        sessionId: "ses_1",
        parentCommit: "aaa",
        childCommit: "bbb",
        hunksJson: hunks,
        codeVersion: REVIEW_CACHE_VERSION,
      });
      expect(getReviewTransition(db, "ses_1", "aaa", "bbb")).toEqual({
        hunksJson: hunks,
        codeVersion: "1",
      });
    } finally {
      db.close();
    }
  });

  it("misses on unknown session or commit pair", () => {
    const db = openTestDb();
    try {
      putReviewTransition(db, {
        sessionId: "ses_1",
        parentCommit: "aaa",
        childCommit: "bbb",
        hunksJson: "[]",
        codeVersion: REVIEW_CACHE_VERSION,
      });
      expect(getReviewTransition(db, "ses_1", "aaa", "ccc")).toBeNull();
      expect(getReviewTransition(db, "ses_1", "ccc", "bbb")).toBeNull();
      expect(getReviewTransition(db, "ses_missing", "aaa", "bbb")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("overwrites the same key with the newest write", () => {
    const db = openTestDb();
    try {
      putReviewTransition(db, {
        sessionId: "ses_1",
        parentCommit: "aaa",
        childCommit: "bbb",
        hunksJson: JSON.stringify([{ path: "old.ts" }]),
        codeVersion: "1",
      });
      putReviewTransition(db, {
        sessionId: "ses_1",
        parentCommit: "aaa",
        childCommit: "bbb",
        hunksJson: JSON.stringify([{ path: "new.ts" }]),
        codeVersion: "2",
      });
      expect(getReviewTransition(db, "ses_1", "aaa", "bbb")).toEqual({
        hunksJson: JSON.stringify([{ path: "new.ts" }]),
        codeVersion: "2",
      });
    } finally {
      db.close();
    }
  });

  it("stores code_version verbatim and keys rows per commit pair", () => {
    const db = openTestDb();
    try {
      putReviewTransition(db, {
        sessionId: "ses_1",
        parentCommit: "aaa",
        childCommit: "bbb",
        hunksJson: "[]",
        codeVersion: "custom-stamp",
      });
      putReviewTransition(db, {
        sessionId: "ses_1",
        parentCommit: "bbb",
        childCommit: "ccc",
        hunksJson: "[]",
        codeVersion: "other-stamp",
      });
      expect(getReviewTransition(db, "ses_1", "aaa", "bbb")?.codeVersion).toBe("custom-stamp");
      expect(getReviewTransition(db, "ses_1", "bbb", "ccc")?.codeVersion).toBe("other-stamp");
    } finally {
      db.close();
    }
  });
});

describe("subagent orphan cleanup", () => {
  it("reports user data only after engagement or artifacts", () => {
    const db = openTestDb();
    try {
      seed(db);
      expect(sessionHasUserData(db, "ses_1")).toBe(false);
      // An auto-generated story alone is not user data: it rebuilds.
      upsertArtifactRef(db, {
        sessionId: "ses_1",
        kind: "story",
        path: "/data/story.json",
        tapeWatermark: { eventCount: 3, sha256: "abc" },
        generator: "story-v1",
        generatedAt: "2026-10-28T10:00:00.000Z",
      });
      expect(sessionHasUserData(db, "ses_1")).toBe(false);
      recordEngagementEvents(db, "ses_1", [
        {
          id: "eng_lane",
          cardId: null,
          kind: "story_opened",
          occurredAt: "2026-10-28T10:00:00.000Z",
        },
      ]);
      expect(sessionHasUserData(db, "ses_1")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("deletes a derived session with its events and engagement rows", () => {
    const db = openTestDb();
    try {
      seed(db);
      appendEvents(db, "ses_1", [makeEvent(1), makeEvent(2)]);
      recordEngagementEvents(db, "ses_1", [
        {
          id: "eng_lane",
          cardId: null,
          kind: "story_opened",
          occurredAt: "2026-10-28T10:00:00.000Z",
        },
      ]);
      expect(getSession(db, "ses_1")).not.toBeNull();
      deleteEchoSession(db, "ses_1");
      expect(getSession(db, "ses_1")).toBeNull();
      expect(getSessionEventIds(db, "ses_1").size).toBe(0);
      expect(listEngagementEvents(db, "ses_1")).toEqual([]);
      // The project row survives: only the derived session is removed.
      expect(listProjects(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
