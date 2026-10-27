import type { TapeEvent } from "@echo/contracts";
import { type EchoDb, withTransaction } from "./database";

export interface ProjectSummary {
  id: string;
  root: string;
  name: string | null;
  sessionCount: number;
  lastActivity: string | null;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string | null;
  model: string | null;
  directory: string | null;
  startedAt: string | null;
  endedAt: string | null;
  status: string;
  captureQuality: string;
  eventCount: number;
}

export interface StoredEvent {
  event_id: string;
  tape_seq: number;
  position_seq: number;
  record_key: string | null;
  kind: string;
  ts: string;
  observed_at: string;
  tool_call_id: string | null;
  payload: unknown;
  redaction: unknown;
}

export interface SnapshotFileRow {
  path: string;
  mode: string | null;
  blobOid: string | null;
  size: number | null;
  sha256: string | null;
  captured: boolean;
  reason: string | null;
}

export interface SnapshotRow {
  id: string;
  sessionId: string;
  commitOid: string;
  parentOid: string | null;
  trigger: string;
  eventId: string | null;
  takenAt: string;
  fileCount: number;
  totalBytes: number;
  status: string;
  diagnostics: string[];
}

export interface SnapshotInsert {
  id: string;
  sessionId: string;
  commitOid: string;
  parentOid: string | null;
  trigger: string;
  eventId: string | null;
  takenAt: string;
  fileCount: number;
  totalBytes: number;
  status: string;
  diagnostics: string[];
  files: SnapshotFileRow[];
}

function nowIso(): string {
  return new Date().toISOString();
}

export function upsertProject(
  db: EchoDb,
  input: { id: string; root: string; name: string | null },
): void {
  db.prepare(
    `INSERT INTO projects (id, canonical_root, name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET canonical_root = excluded.canonical_root, name = excluded.name`,
  ).run(input.id, input.root, input.name, nowIso());
}

export function upsertSession(
  db: EchoDb,
  input: {
    id: string;
    projectId: string;
    agent: string;
    model: string | null;
    directory: string | null;
    title: string | null;
    startedAt: string | null;
    tapePath: string;
    captureQuality: string;
  },
): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO sessions (id, project_id, agent, model, directory, title, started_at, status, tape_path, capture_quality, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'imported', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       model = excluded.model,
       directory = excluded.directory,
       title = excluded.title,
       started_at = excluded.started_at,
       tape_path = excluded.tape_path,
       capture_quality = excluded.capture_quality,
       updated_at = excluded.updated_at`,
  ).run(
    input.id,
    input.projectId,
    input.agent,
    input.model,
    input.directory,
    input.title,
    input.startedAt,
    input.tapePath,
    input.captureQuality,
    now,
    now,
  );
}

export function getSessionEventIds(db: EchoDb, sessionId: string): Set<string> {
  const rows = db.prepare("SELECT id FROM events WHERE session_id = ?").all(sessionId) as Array<{
    id: string;
  }>;
  return new Set(rows.map((row) => row.id));
}

export function maxTapeSeq(db: EchoDb, sessionId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(tape_seq), 0) AS maxSeq FROM events WHERE session_id = ?")
    .get(sessionId) as { maxSeq: number };
  return Number(row.maxSeq);
}

export function maxSourceSequence(db: EchoDb, sessionId: string): number | null {
  const row = db
    .prepare("SELECT MAX(source_sequence) AS maxSeq FROM events WHERE session_id = ?")
    .get(sessionId) as { maxSeq: number | null };
  return row.maxSeq === null ? null : Number(row.maxSeq);
}

export function getSessionRecordKeys(db: EchoDb, sessionId: string): Set<string> {
  const rows = db
    .prepare(
      "SELECT DISTINCT record_key FROM events WHERE session_id = ? AND record_key IS NOT NULL",
    )
    .all(sessionId) as Array<{ record_key: string }>;
  return new Set(rows.map((row) => row.record_key));
}

export function insertStampedEvents(db: EchoDb, sessionId: string, events: TapeEvent[]): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (id, session_id, tape_seq, source_sequence, record_key, kind, ts, observed_at, tool_call_id, payload_json, redaction_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = nowIso();
  return withTransaction(db, () => {
    let inserted = 0;
    for (const event of events) {
      const result = insert.run(
        event.event_id,
        sessionId,
        event.tape_seq,
        event.source.sequence,
        event.record_key,
        event.kind,
        event.ts,
        event.observed_at,
        event.links.tool_call_id,
        JSON.stringify(event.payload),
        JSON.stringify(event.redaction),
        now,
      );
      inserted += Number(result.changes);
    }
    return inserted;
  });
}

export function appendEvents(db: EchoDb, sessionId: string, events: TapeEvent[]): number {
  let seq = maxTapeSeq(db, sessionId);
  for (const event of events) {
    seq += 1;
    event.tape_seq = seq;
  }
  return insertStampedEvents(db, sessionId, events);
}

export function listProjects(db: EchoDb): ProjectSummary[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.canonical_root AS root, p.name,
              COUNT(s.id) AS session_count, MAX(s.updated_at) AS last_activity
       FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
       GROUP BY p.id
       ORDER BY last_activity DESC`,
    )
    .all() as Array<{
    id: string;
    root: string;
    name: string | null;
    session_count: number;
    last_activity: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    root: row.root,
    name: row.name,
    sessionCount: Number(row.session_count),
    lastActivity: row.last_activity,
  }));
}

export function listSessions(db: EchoDb, projectId: string): SessionSummary[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.project_id, s.title, s.model, s.directory, s.started_at, s.ended_at,
              s.status, s.capture_quality,
              (SELECT COUNT(DISTINCT COALESCE(e.record_key, e.id)) FROM events e WHERE e.session_id = s.id) AS event_count
       FROM sessions s WHERE s.project_id = ? ORDER BY s.updated_at DESC`,
    )
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    title: row.title === null ? null : String(row.title),
    model: row.model === null ? null : String(row.model),
    directory: row.directory === null ? null : String(row.directory),
    startedAt: row.started_at === null ? null : String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    status: String(row.status),
    captureQuality: String(row.capture_quality),
    eventCount: Number(row.event_count),
  }));
}

export function readEvents(
  db: EchoDb,
  sessionId: string,
  afterSeq = 0,
  limit = 500,
  includeRevisions = false,
): StoredEvent[] {
  const bounded = Math.min(Math.max(limit, 1), 1000);
  const sql = includeRevisions
    ? `SELECT id, tape_seq, tape_seq AS position_seq, record_key, kind, ts, observed_at,
              tool_call_id, payload_json, redaction_json
       FROM events WHERE session_id = ? AND tape_seq > ? ORDER BY tape_seq LIMIT ?`
    : `SELECT id, tape_seq, position_seq, record_key, kind, ts, observed_at,
              tool_call_id, payload_json, redaction_json
       FROM (
         SELECT id, tape_seq, record_key, kind, ts, observed_at, tool_call_id,
                payload_json, redaction_json,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(record_key, id) ORDER BY tape_seq DESC
                ) AS revision_rank,
                MIN(tape_seq) OVER (
                  PARTITION BY COALESCE(record_key, id)
                ) AS position_seq
         FROM events WHERE session_id = ?
       )
       WHERE revision_rank = 1 AND position_seq > ?
       ORDER BY position_seq, tape_seq LIMIT ?`;
  const rows = db.prepare(sql).all(sessionId, afterSeq, bounded) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    event_id: String(row.id),
    tape_seq: Number(row.tape_seq),
    position_seq: Number(row.position_seq),
    record_key: row.record_key === null ? null : String(row.record_key),
    kind: String(row.kind),
    ts: String(row.ts),
    observed_at: String(row.observed_at),
    tool_call_id: row.tool_call_id === null ? null : String(row.tool_call_id),
    payload: JSON.parse(String(row.payload_json)),
    redaction: JSON.parse(String(row.redaction_json)),
  }));
}

export function insertSnapshot(db: EchoDb, input: SnapshotInsert): boolean {
  const snapshotInsert = db.prepare(
    `INSERT OR IGNORE INTO snapshots
       (id, session_id, commit_oid, parent_oid, trigger, event_id, taken_at, file_count, total_bytes, status, diagnostics_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const fileInsert = db.prepare(
    `INSERT OR IGNORE INTO snapshot_files
       (snapshot_id, path, mode, blob_oid, size, sha256, captured, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return withTransaction(db, () => {
    const result = snapshotInsert.run(
      input.id,
      input.sessionId,
      input.commitOid,
      input.parentOid,
      input.trigger,
      input.eventId,
      input.takenAt,
      input.fileCount,
      input.totalBytes,
      input.status,
      JSON.stringify(input.diagnostics),
    );
    if (Number(result.changes) === 0) return false;
    for (const file of input.files) {
      fileInsert.run(
        input.id,
        file.path,
        file.mode,
        file.blobOid,
        file.size,
        file.sha256,
        file.captured ? 1 : 0,
        file.reason,
      );
    }
    return true;
  });
}

function snapshotRowFrom(row: Record<string, unknown>): SnapshotRow {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    commitOid: String(row.commit_oid),
    parentOid: row.parent_oid === null ? null : String(row.parent_oid),
    trigger: String(row.trigger),
    eventId: row.event_id === null ? null : String(row.event_id),
    takenAt: String(row.taken_at),
    fileCount: Number(row.file_count),
    totalBytes: Number(row.total_bytes),
    status: String(row.status),
    diagnostics: JSON.parse(String(row.diagnostics_json)) as string[],
  };
}

export function listSnapshots(db: EchoDb, sessionId: string): SnapshotRow[] {
  const rows = db
    .prepare("SELECT * FROM snapshots WHERE session_id = ? ORDER BY taken_at, rowid")
    .all(sessionId) as Array<Record<string, unknown>>;
  return rows.map(snapshotRowFrom);
}

export function latestSnapshot(
  db: EchoDb,
  sessionId: string,
  trigger?: string,
): SnapshotRow | null {
  const sql =
    trigger === undefined
      ? "SELECT * FROM snapshots WHERE session_id = ? ORDER BY taken_at DESC, rowid DESC LIMIT 1"
      : "SELECT * FROM snapshots WHERE session_id = ? AND trigger = ? ORDER BY taken_at DESC, rowid DESC LIMIT 1";
  const row = (
    trigger === undefined ? db.prepare(sql).get(sessionId) : db.prepare(sql).get(sessionId, trigger)
  ) as Record<string, unknown> | undefined;
  return row ? snapshotRowFrom(row) : null;
}

export function listSnapshotFiles(db: EchoDb, snapshotId: string): SnapshotFileRow[] {
  const rows = db
    .prepare(
      "SELECT path, mode, blob_oid, size, sha256, captured, reason FROM snapshot_files WHERE snapshot_id = ? ORDER BY path",
    )
    .all(snapshotId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    path: String(row.path),
    mode: row.mode === null ? null : String(row.mode),
    blobOid: row.blob_oid === null ? null : String(row.blob_oid),
    size: row.size === null ? null : Number(row.size),
    sha256: row.sha256 === null ? null : String(row.sha256),
    captured: Number(row.captured) === 1,
    reason: row.reason === null ? null : String(row.reason),
  }));
}
