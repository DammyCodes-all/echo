import type {
  ArtifactKind,
  CaptureState,
  EngagementKind,
  EngagementTier,
  SessionCheckStatus,
  TapeEvent,
  TapeWatermark,
} from "@echo/contracts";
import { type EchoDb, withTransaction } from "./database";

export interface ProjectSummary {
  id: string;
  root: string;
  remoteUrl: string | null;
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
  summary: string | null;
  checkStatus: SessionCheckStatus;
  highRiskCount: number;
  captureState: CaptureState;
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

// Identity converges on one row per repository even when adapters disagree
// about the remote (or it appears mid-life): the first row to claim a
// canonical root wins and keeps its id; a later identity for the same root
// (or the same remote from a moved folder) adopts that row instead of
// throwing on the UNIQUE indexes and aborting the ingest poll — which used
// to strand sessions with advanced reader checkpoints but no session row.
// Returns the id the caller must use for sessions/tapes/paths; it can
// differ from input.id when an older row already owns the root or remote.
export function upsertProject(
  db: EchoDb,
  input: { id: string; root: string; remoteUrl?: string | null; name: string | null },
): string {
  const byRoot = db.prepare(`SELECT id FROM projects WHERE canonical_root = ?`).get(input.root) as
    | { id: string }
    | undefined;
  if (byRoot && byRoot.id !== input.id) {
    db.prepare(
      `UPDATE projects SET remote_url = COALESCE(remote_url, ?), name = COALESCE(?, name) WHERE id = ?`,
    ).run(input.remoteUrl ?? null, input.name, byRoot.id);
    return byRoot.id;
  }
  const remote = input.remoteUrl ?? null;
  if (remote !== null) {
    const byRemote = db.prepare(`SELECT id FROM projects WHERE remote_url = ?`).get(remote) as
      | { id: string }
      | undefined;
    if (byRemote && byRemote.id !== input.id) {
      db.prepare(
        `UPDATE projects SET canonical_root = ?, name = COALESCE(?, name) WHERE id = ?`,
      ).run(input.root, input.name, byRemote.id);
      return byRemote.id;
    }
  }
  db.prepare(
    `INSERT INTO projects (id, canonical_root, remote_url, name, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET canonical_root = excluded.canonical_root, remote_url = COALESCE(excluded.remote_url, projects.remote_url), name = excluded.name`,
  ).run(input.id, input.root, remote, input.name, nowIso());
  return input.id;
}

// Ingest-side project registration. The derived id changes when a remote is
// added/removed (hash of remote ?? root) or the folder moves, but ARCHITECTURE
// says one row per repository — and tapes, shadow repos, artifacts and the
// code index are all keyed by project id on disk. So an existing row wins over
// a fresh id: same root keeps its historic id (remote/name refresh), same
// remote adopts a moved root. Truly new repos insert. Returns the effective id
// the caller must use for sessions, tapes and snapshots. Without this the
// bare upsertProject throws UNIQUE(canonical_root) on the first poll after a
// remote appears, and the throw aborts the whole scan (every session starves).
export function ensureIngestProject(
  db: EchoDb,
  input: { id: string; root: string; remoteUrl?: string | null; name: string | null },
): string {
  const remoteUrl = input.remoteUrl ?? null;
  const byId = db.prepare("SELECT id, canonical_root FROM projects WHERE id = ?").get(input.id) as
    | { id: string; canonical_root: string }
    | undefined;
  if (byId) {
    // Same id, folder moved under a stable remote: adopt the new root when
    // no other row holds it; otherwise keep the stored root, never crash.
    if (byId.canonical_root !== input.root) {
      const clash = db
        .prepare("SELECT id FROM projects WHERE canonical_root = ?")
        .get(input.root) as { id: string } | undefined;
      if (!clash) {
        db.prepare("UPDATE projects SET canonical_root = ? WHERE id = ?").run(input.root, input.id);
      }
    }
    db.prepare("UPDATE projects SET remote_url = ?, name = ? WHERE id = ?").run(
      remoteUrl,
      input.name,
      input.id,
    );
    return input.id;
  }
  const byRoot = db.prepare("SELECT id FROM projects WHERE canonical_root = ?").get(input.root) as
    | { id: string }
    | undefined;
  if (byRoot) {
    db.prepare("UPDATE projects SET remote_url = ?, name = ? WHERE id = ?").run(
      remoteUrl,
      input.name,
      byRoot.id,
    );
    return byRoot.id;
  }
  if (remoteUrl) {
    const byRemote = db.prepare("SELECT id FROM projects WHERE remote_url = ?").get(remoteUrl) as
      | { id: string }
      | undefined;
    if (byRemote) {
      db.prepare("UPDATE projects SET canonical_root = ?, name = ? WHERE id = ?").run(
        input.root,
        input.name,
        byRemote.id,
      );
      return byRemote.id;
    }
  }
  upsertProject(db, input);
  return input.id;
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

export interface SessionRow {
  id: string;
  projectId: string;
}

export function getSession(db: EchoDb, sessionId: string): SessionRow | null {
  const row = db.prepare("SELECT id, project_id FROM sessions WHERE id = ?").get(sessionId) as
    | { id: string; project_id: string }
    | undefined;
  return row ? { id: row.id, projectId: row.project_id } : null;
}

export function getSessionEventIds(db: EchoDb, sessionId: string): Set<string> {
  const rows = db.prepare("SELECT id FROM events WHERE session_id = ?").all(sessionId) as Array<{
    id: string;
  }>;
  return new Set(rows.map((row) => row.id));
}

export function hasEventKind(db: EchoDb, sessionId: string, kind: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM events WHERE session_id = ? AND kind = ? LIMIT 1")
    .get(sessionId, kind) as { ok: number } | undefined;
  return row !== undefined;
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

export interface ReaderCheckpoint {
  sessionId: string;
  lane: string;
  sourcePath: string;
  inode: number | null;
  offset: number;
  lastSequence: number | null;
  lastEventTs: string | null;
  lastMarkerAfter: number | null;
  markerCount: number;
  sessionStarted: boolean;
  schemaVersion: number | null;
  adapterVersion: string | null;
  build: string | null;
  status: string;
  error: string | null;
  lastReadAt: string;
}

function checkpointFrom(row: Record<string, unknown>): ReaderCheckpoint {
  return {
    sessionId: String(row.session_id),
    lane: String(row.lane),
    sourcePath: String(row.source_path),
    inode: row.inode === null ? null : Number(row.inode),
    offset: Number(row.offset),
    lastSequence: row.last_sequence === null ? null : Number(row.last_sequence),
    lastEventTs: row.last_event_ts === null ? null : String(row.last_event_ts),
    lastMarkerAfter: row.last_marker_after === null ? null : Number(row.last_marker_after),
    markerCount: Number(row.marker_count),
    sessionStarted: Number(row.session_started) === 1,
    schemaVersion: row.schema_version === null ? null : Number(row.schema_version),
    adapterVersion: row.adapter_version === null ? null : String(row.adapter_version),
    build: row.build === null ? null : String(row.build),
    status: String(row.status),
    error: row.error === null ? null : String(row.error),
    lastReadAt: String(row.last_read_at),
  };
}

export function getReaderCheckpoint(
  db: EchoDb,
  sessionId: string,
  lane: string,
): ReaderCheckpoint | null {
  const row = db
    .prepare("SELECT * FROM reader_checkpoints WHERE session_id = ? AND lane = ?")
    .get(sessionId, lane) as Record<string, unknown> | undefined;
  return row ? checkpointFrom(row) : null;
}

export function listReaderCheckpoints(db: EchoDb, sessionId: string): ReaderCheckpoint[] {
  const rows = db
    .prepare("SELECT * FROM reader_checkpoints WHERE session_id = ? ORDER BY lane")
    .all(sessionId) as Array<Record<string, unknown>>;
  return rows.map(checkpointFrom);
}

export function upsertReaderCheckpoint(db: EchoDb, checkpoint: ReaderCheckpoint): void {
  db.prepare(
    `INSERT INTO reader_checkpoints
      (session_id, lane, source_path, inode, offset, last_sequence, last_event_ts,
       last_marker_after, marker_count, session_started, schema_version,
       adapter_version, build, status, error, last_read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, lane) DO UPDATE SET
      source_path = excluded.source_path,
      inode = excluded.inode,
      offset = excluded.offset,
      last_sequence = excluded.last_sequence,
      last_event_ts = excluded.last_event_ts,
      last_marker_after = excluded.last_marker_after,
      marker_count = excluded.marker_count,
      session_started = excluded.session_started,
      schema_version = excluded.schema_version,
      adapter_version = excluded.adapter_version,
      build = excluded.build,
      status = excluded.status,
      error = excluded.error,
      last_read_at = excluded.last_read_at`,
  ).run(
    checkpoint.sessionId,
    checkpoint.lane,
    checkpoint.sourcePath,
    checkpoint.inode,
    checkpoint.offset,
    checkpoint.lastSequence,
    checkpoint.lastEventTs,
    checkpoint.lastMarkerAfter,
    checkpoint.markerCount,
    checkpoint.sessionStarted ? 1 : 0,
    checkpoint.schemaVersion,
    checkpoint.adapterVersion,
    checkpoint.build,
    checkpoint.status,
    checkpoint.error,
    checkpoint.lastReadAt,
  );
}

// Drop checkpoints for lanes that no longer exist (deleted child logs).
// The parent lane ('') is never pruned here; only listed child lanes survive.
export function pruneReaderCheckpoints(db: EchoDb, sessionId: string, keepLanes: string[]): number {
  if (keepLanes.length === 0) {
    const result = db
      .prepare("DELETE FROM reader_checkpoints WHERE session_id = ? AND lane != ''")
      .run(sessionId);
    return Number(result.changes);
  }
  const placeholders = keepLanes.map(() => "?").join(", ");
  const result = db
    .prepare(
      `DELETE FROM reader_checkpoints
       WHERE session_id = ? AND lane != '' AND lane NOT IN (${placeholders})`,
    )
    .run(sessionId, ...keepLanes);
  return Number(result.changes);
}

export interface SessionBuildPin {
  sessionId: string;
  museVersion: string | null;
  adapterVersion: string | null;
  exportSchemaVersion: number | null;
  observedAt: string;
}

export function upsertSessionBuildPin(db: EchoDb, pin: SessionBuildPin): void {
  db.prepare(
    `INSERT INTO session_build_pins
      (session_id, muse_version, adapter_version, export_schema_version, observed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
      muse_version = excluded.muse_version,
      adapter_version = excluded.adapter_version,
      export_schema_version = excluded.export_schema_version,
      observed_at = excluded.observed_at`,
  ).run(
    pin.sessionId,
    pin.museVersion,
    pin.adapterVersion,
    pin.exportSchemaVersion,
    pin.observedAt,
  );
}

export function getSessionBuildPin(db: EchoDb, sessionId: string): SessionBuildPin | null {
  const row = db.prepare("SELECT * FROM session_build_pins WHERE session_id = ?").get(sessionId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    sessionId: String(row.session_id),
    museVersion: row.muse_version === null ? null : String(row.muse_version),
    adapterVersion: row.adapter_version === null ? null : String(row.adapter_version),
    exportSchemaVersion:
      row.export_schema_version === null ? null : Number(row.export_schema_version),
    observedAt: String(row.observed_at),
  };
}

export interface BuildVersionSummary {
  museVersion: string | null;
  sessions: number;
  lastObserved: string;
}

export function listBuildVersions(db: EchoDb, limit = 5): BuildVersionSummary[] {
  const rows = db
    .prepare(
      `SELECT muse_version, COUNT(*) AS sessions, MAX(observed_at) AS last_observed
       FROM session_build_pins GROUP BY muse_version ORDER BY last_observed DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    museVersion: row.muse_version === null ? null : String(row.muse_version),
    sessions: Number(row.sessions),
    lastObserved: String(row.last_observed),
  }));
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
      `SELECT p.id, p.canonical_root AS root, p.remote_url AS remote_url, p.name,
              COUNT(s.id) AS session_count, MAX(s.updated_at) AS last_activity
       FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
       GROUP BY p.id
       ORDER BY last_activity DESC`,
    )
    .all() as Array<{
    id: string;
    root: string;
    remote_url: string | null;
    name: string | null;
    session_count: number;
    last_activity: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    root: row.root,
    remoteUrl: row.remote_url,
    name: row.name,
    sessionCount: Number(row.session_count),
    lastActivity: row.last_activity,
  }));
}

export function getProject(db: EchoDb, projectId: string): ProjectSummary | null {
  const row = db
    .prepare(
      `SELECT p.id, p.canonical_root AS root, p.remote_url AS remote_url, p.name,
              COUNT(s.id) AS session_count, MAX(s.updated_at) AS last_activity
       FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
       WHERE p.id = ? GROUP BY p.id`,
    )
    .get(projectId) as
    | {
        id: string;
        root: string;
        remote_url: string | null;
        name: string | null;
        session_count: number;
        last_activity: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    root: row.root,
    remoteUrl: row.remote_url,
    name: row.name,
    sessionCount: Number(row.session_count),
    lastActivity: row.last_activity,
  };
}

export interface ProjectFileTouch {
  path: string;
  sessionCount: number;
  lastTouched: string;
}

// Agent-touched overlay (ARCHITECTURE §16): aggregate snapshot_files per
// project. Deterministic, no model input. Capped with truncation flag so the
// Architecture tab stays fast on large repos.
export function listProjectTouchedFiles(
  db: EchoDb,
  projectId: string,
  limit = 500,
): { files: ProjectFileTouch[]; truncated: boolean } {
  const bounded = Math.min(Math.max(limit, 1), 2000);
  const rows = db
    .prepare(
      `SELECT sf.path AS path,
              COUNT(DISTINCT s.id) AS session_count,
              MAX(sn.taken_at) AS last_touched
       FROM snapshot_files sf
       JOIN snapshots sn ON sn.id = sf.snapshot_id
       JOIN sessions s ON s.id = sn.session_id
       WHERE s.project_id = ?
       GROUP BY sf.path
       ORDER BY session_count DESC, last_touched DESC
       LIMIT ?`,
    )
    .all(projectId, bounded + 1) as Array<{
    path: string;
    session_count: number;
    last_touched: string;
  }>;
  const truncated = rows.length > bounded;
  return {
    files: rows.slice(0, bounded).map((row) => ({
      path: row.path,
      sessionCount: Number(row.session_count),
      lastTouched: row.last_touched,
    })),
    truncated,
  };
}

export function listSessions(db: EchoDb, projectId: string): SessionSummary[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.project_id, s.title, s.model, s.directory, s.started_at, s.ended_at,
              s.status, s.capture_quality, s.check_status, s.story_summary, s.high_risk_count,
              (SELECT COUNT(DISTINCT COALESCE(e.record_key, e.id)) FROM events e WHERE e.session_id = s.id) AS event_count
       FROM sessions s WHERE s.project_id = ? ORDER BY s.updated_at DESC`,
    )
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const base = toSessionSummary(row);
    return { ...base, captureState: resolveCaptureState(db, String(row.id), row) };
  });
}

export function getSessionSummary(db: EchoDb, sessionId: string): SessionSummary | null {
  const rows = db
    .prepare(
      `SELECT s.id, s.project_id, s.title, s.model, s.directory, s.started_at, s.ended_at,
              s.status, s.capture_quality, s.check_status, s.story_summary, s.high_risk_count,
              (SELECT COUNT(DISTINCT COALESCE(e.record_key, e.id)) FROM events e WHERE e.session_id = s.id) AS event_count
       FROM sessions s WHERE s.id = ?`,
    )
    .all(sessionId) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  const base = toSessionSummary(row);
  return { ...base, captureState: resolveCaptureState(db, String(row.id), row) };
}

function deriveCaptureState(status: string, captureQuality: string): CaptureState {
  if (status === "recording") return "recording";
  if (captureQuality === "import_only") return "import_only";
  if (captureQuality === "partial") return "partial";
  if (captureQuality === "degraded") return "degraded";
  return "ready";
}

// Q47 + ARCHITECTURE §13/§16: inbox rows for sessions with no story artifact yet
// read as still-recording; a stale story (tape grew past the artifact watermark)
// also reads as recording/growing. No artifact → "recording" always (overrides
// the quality derivation, even import_only — predictable over precise).
// N+1 artifact lookups are acceptable for inbox scale.
function resolveCaptureState(
  db: EchoDb,
  sessionId: string,
  row: Record<string, unknown>,
): CaptureState {
  const artifact = getArtifactRef(db, sessionId, "story");
  if (!artifact) return "recording";
  const eventCount = Number(row.event_count);
  if (eventCount !== artifact.tapeWatermark.eventCount) return "recording";
  return deriveCaptureState(String(row.status), String(row.capture_quality));
}

function toSessionSummary(row: Record<string, unknown>): SessionSummary {
  const status = String(row.status);
  const captureQuality = String(row.capture_quality);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: row.title === null ? null : String(row.title),
    model: row.model === null ? null : String(row.model),
    directory: row.directory === null ? null : String(row.directory),
    startedAt: row.started_at === null ? null : String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    status,
    captureQuality,
    eventCount: Number(row.event_count),
    summary: row.story_summary === null ? null : String(row.story_summary),
    checkStatus: String(row.check_status) as SessionCheckStatus,
    highRiskCount: Number(row.high_risk_count),
    captureState: deriveCaptureState(status, captureQuality),
  };
}

export function setSessionCheckStatus(
  db: EchoDb,
  sessionId: string,
  status: SessionCheckStatus,
): void {
  db.prepare("UPDATE sessions SET check_status = ?, updated_at = ? WHERE id = ?").run(
    status,
    nowIso(),
    sessionId,
  );
}

export function setSessionStoryState(
  db: EchoDb,
  sessionId: string,
  state: { summary: string | null; highRiskCount: number },
): void {
  db.prepare(
    "UPDATE sessions SET story_summary = ?, high_risk_count = ?, updated_at = ? WHERE id = ?",
  ).run(state.summary, state.highRiskCount, nowIso(), sessionId);
}

export interface EngagementEventInput {
  id: string;
  cardId: string | null;
  kind: EngagementKind;
  occurredAt: string;
}

export interface EngagementEventRow {
  id: string;
  sessionId: string;
  cardId: string | null;
  kind: EngagementKind;
  occurredAt: string;
}

export function recordEngagementEvents(
  db: EchoDb,
  sessionId: string,
  events: EngagementEventInput[],
): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO engagement_events
       (id, session_id, card_id, kind, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = nowIso();
  return withTransaction(db, () => {
    let inserted = 0;
    for (const event of events) {
      const result = insert.run(
        event.id,
        sessionId,
        event.cardId,
        event.kind,
        event.occurredAt,
        now,
      );
      inserted += Number(result.changes);
    }
    return inserted;
  });
}

export function listEngagementEvents(db: EchoDb, sessionId: string): EngagementEventRow[] {
  const rows = db
    .prepare(
      `SELECT id, session_id, card_id, kind, occurred_at
       FROM engagement_events WHERE session_id = ? ORDER BY occurred_at, rowid`,
    )
    .all(sessionId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    sessionId: String(row.session_id),
    cardId: row.card_id === null ? null : String(row.card_id),
    kind: String(row.kind) as EngagementKind,
    occurredAt: String(row.occurred_at),
  }));
}

const ENGAGED_KINDS: ReadonlySet<string> = new Set(["card_expanded", "code_shown", "ask_opened"]);

export function deriveEngagementTiers(
  db: EchoDb,
  sessionId: string,
  cardIds: string[],
): Record<string, EngagementTier> {
  const rows = db
    .prepare("SELECT card_id, kind FROM engagement_events WHERE session_id = ?")
    .all(sessionId) as Array<{ card_id: string | null; kind: string }>;
  const seen = new Set<string>();
  const engaged = new Set<string>();
  for (const row of rows) {
    if (row.card_id === null) continue;
    if (ENGAGED_KINDS.has(row.kind)) engaged.add(row.card_id);
    else if (row.kind === "card_seen") seen.add(row.card_id);
  }
  const tiers: Record<string, EngagementTier> = {};
  for (const cardId of cardIds) {
    if (engaged.has(cardId)) tiers[cardId] = "engaged";
    else if (seen.has(cardId)) tiers[cardId] = "seen";
    else tiers[cardId] = "unseen";
  }
  return tiers;
}

export interface ArtifactRefRow {
  sessionId: string;
  kind: ArtifactKind;
  path: string;
  tapeWatermark: TapeWatermark;
  generator: string;
  generatedAt: string;
}

export function upsertArtifactRef(db: EchoDb, ref: ArtifactRefRow): void {
  db.prepare(
    `INSERT INTO session_artifacts
       (session_id, kind, path, tape_event_count, tape_sha256, generator, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, kind) DO UPDATE SET
       path = excluded.path,
       tape_event_count = excluded.tape_event_count,
       tape_sha256 = excluded.tape_sha256,
       generator = excluded.generator,
       generated_at = excluded.generated_at`,
  ).run(
    ref.sessionId,
    ref.kind,
    ref.path,
    ref.tapeWatermark.eventCount,
    ref.tapeWatermark.sha256,
    ref.generator,
    ref.generatedAt,
  );
}

export function getArtifactRef(
  db: EchoDb,
  sessionId: string,
  kind: ArtifactKind,
): ArtifactRefRow | null {
  const row = db
    .prepare("SELECT * FROM session_artifacts WHERE session_id = ? AND kind = ?")
    .get(sessionId, kind) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    sessionId: String(row.session_id),
    kind: String(row.kind) as ArtifactKind,
    path: String(row.path),
    tapeWatermark: {
      eventCount: Number(row.tape_event_count),
      sha256: String(row.tape_sha256),
    },
    generator: String(row.generator),
    generatedAt: String(row.generated_at),
  };
}

export interface ProjectArtifactRefRow {
  projectId: string;
  kind: string;
  path: string;
  watermark: string;
  generator: string;
  generatedAt: string;
}

export function upsertProjectArtifactRef(db: EchoDb, ref: ProjectArtifactRefRow): void {
  db.prepare(
    `INSERT INTO project_artifacts
       (project_id, kind, path, watermark, generator, generated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, kind) DO UPDATE SET
       path = excluded.path,
       watermark = excluded.watermark,
       generator = excluded.generator,
       generated_at = excluded.generated_at`,
  ).run(ref.projectId, ref.kind, ref.path, ref.watermark, ref.generator, ref.generatedAt);
}

export function getProjectArtifactRef(
  db: EchoDb,
  projectId: string,
  kind: string,
): ProjectArtifactRefRow | null {
  const row = db
    .prepare("SELECT * FROM project_artifacts WHERE project_id = ? AND kind = ?")
    .get(projectId, kind) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    projectId: String(row.project_id),
    kind: String(row.kind),
    path: String(row.path),
    watermark: String(row.watermark),
    generator: String(row.generator),
    generatedAt: String(row.generated_at),
  };
}

export function readEvents(
  db: EchoDb,
  sessionId: string,
  afterSeq = 0,
  limit = 500,
  includeRevisions = false,
  maxLimit = 1000,
): StoredEvent[] {
  const bounded = Math.min(Math.max(limit, 1), Math.max(1, maxLimit));
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

export function readAllEvents(
  db: EchoDb,
  sessionId: string,
  includeRevisions = false,
  pageSize = 1000,
): StoredEvent[] {
  const boundedPage = Math.min(Math.max(pageSize, 1), 10_000);
  const events: StoredEvent[] = [];
  let after = 0;
  for (;;) {
    const page = readEvents(db, sessionId, after, boundedPage, includeRevisions, boundedPage);
    if (page.length === 0) break;
    events.push(...page);
    const last = page[page.length - 1];
    if (!last || page.length < boundedPage) break;
    after = last.position_seq;
    if (events.length > 100_000) break;
  }
  return events;
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

export function getSnapshotByCommit(
  db: EchoDb,
  sessionId: string,
  commitOid: string,
): SnapshotRow | null {
  const row = db
    .prepare("SELECT * FROM snapshots WHERE session_id = ? AND commit_oid = ?")
    .get(sessionId, commitOid) as Record<string, unknown> | undefined;
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
