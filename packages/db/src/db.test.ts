import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TapeEvent } from "@echo/contracts";
import { describe, expect, it } from "vitest";
import {
  appendEvents,
  getSession,
  getSessionEventIds,
  getSnapshotByCommit,
  hasEventKind,
  insertSnapshot,
  latestSnapshot,
  listProjects,
  listSessions,
  listSnapshotFiles,
  openEchoDb,
  readAllEvents,
  readEvents,
  upsertProject,
  upsertSession,
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

function seed(db: ReturnType<typeof openTestDb>): void {
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
    captureQuality: "import_only",
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
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3]);
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
});
