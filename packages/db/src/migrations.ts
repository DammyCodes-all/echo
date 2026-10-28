export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  canonical_root TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  agent TEXT NOT NULL,
  model TEXT,
  directory TEXT,
  title TEXT,
  started_at TEXT,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'imported',
  tape_path TEXT NOT NULL,
  capture_quality TEXT NOT NULL DEFAULT 'import_only',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  tape_seq INTEGER NOT NULL,
  source_sequence INTEGER,
  kind TEXT NOT NULL,
  ts TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  tool_call_id TEXT,
  payload_json TEXT NOT NULL,
  redaction_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, tape_seq)
);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE events ADD COLUMN record_key TEXT;
CREATE INDEX idx_events_record ON events (session_id, record_key, tape_seq);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  commit_oid TEXT NOT NULL,
  parent_oid TEXT,
  trigger TEXT NOT NULL,
  event_id TEXT,
  taken_at TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE snapshot_files (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  path TEXT NOT NULL,
  mode TEXT,
  blob_oid TEXT,
  size INTEGER,
  sha256 TEXT,
  captured INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY (snapshot_id, path)
);
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE reader_checkpoints (
  session_id TEXT NOT NULL,
  lane TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL,
  inode INTEGER,
  offset INTEGER NOT NULL DEFAULT 0,
  last_sequence INTEGER,
  last_event_ts TEXT,
  last_marker_after INTEGER,
  marker_count INTEGER NOT NULL DEFAULT 0,
  session_started INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER,
  adapter_version TEXT,
  build TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  error TEXT,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (session_id, lane)
);
`,
  },
  {
    version: 4,
    sql: `
ALTER TABLE projects ADD COLUMN remote_url TEXT;
CREATE UNIQUE INDEX idx_projects_remote_url ON projects(remote_url) WHERE remote_url IS NOT NULL;
`,
  },
  {
    version: 5,
    sql: `
CREATE TABLE session_build_pins (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  muse_version TEXT,
  adapter_version TEXT,
  export_schema_version INTEGER,
  observed_at TEXT NOT NULL
);
`,
  },
];
