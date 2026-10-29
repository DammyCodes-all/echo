export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  canonical_root TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
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

CREATE TABLE IF NOT EXISTS events (
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
CREATE INDEX IF NOT EXISTS idx_events_record ON events (session_id, record_key, tape_seq);

CREATE TABLE IF NOT EXISTS snapshots (
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

CREATE TABLE IF NOT EXISTS snapshot_files (
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
CREATE TABLE IF NOT EXISTS reader_checkpoints (
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_remote_url ON projects(remote_url) WHERE remote_url IS NOT NULL;
`,
  },
  {
    version: 5,
    sql: `
CREATE TABLE IF NOT EXISTS session_build_pins (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  muse_version TEXT,
  adapter_version TEXT,
  export_schema_version INTEGER,
  observed_at TEXT NOT NULL
);
`,
  },
  {
    version: 6,
    sql: `
ALTER TABLE sessions ADD COLUMN check_status TEXT NOT NULL DEFAULT 'not_checked';
ALTER TABLE sessions ADD COLUMN story_summary TEXT;
ALTER TABLE sessions ADD COLUMN high_risk_count INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS engagement_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  card_id TEXT,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engagement_session_card ON engagement_events (session_id, card_id);
CREATE TABLE IF NOT EXISTS session_artifacts (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  tape_event_count INTEGER NOT NULL,
  tape_sha256 TEXT NOT NULL,
  generator TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, kind)
);
`,
  },
  {
    version: 7,
    sql: `
CREATE TABLE IF NOT EXISTS code_files (
  project_id TEXT NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,
  language TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  parsed INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);
CREATE TABLE IF NOT EXISTS code_symbols (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  file TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  exported INTEGER NOT NULL,
  line INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols (project_id, name);
CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols (project_id, file);
CREATE TABLE IF NOT EXISTS code_edges (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  from_file TEXT NOT NULL,
  to_file TEXT,
  external_module TEXT,
  kind TEXT NOT NULL,
  names_json TEXT NOT NULL DEFAULT '[]',
  resolved INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_code_edges_from ON code_edges (project_id, from_file);
CREATE INDEX IF NOT EXISTS idx_code_edges_to ON code_edges (project_id, to_file);
CREATE INDEX IF NOT EXISTS idx_code_edges_external ON code_edges (project_id, external_module);
CREATE TABLE IF NOT EXISTS code_index_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  files_hash TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  symbol_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  stack_json TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  parser TEXT NOT NULL
);
`,
  },
  {
    version: 8,
    sql: `
CREATE TABLE IF NOT EXISTS project_artifacts (
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  watermark TEXT NOT NULL,
  generator TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, kind)
);
`,
  },
  // Heal-forward for the parallel code-index landing: v7's code_edges shipped
  // without the id column on databases migrated before the column was added
  // (CREATE TABLE IF NOT EXISTS never re-ran). Existing rows get a
  // placeholder; the next reindex per project deletes and re-inserts with
  // real ids. Kept comment-free: the runner skips repeated ADD COLUMNs by
  // matching statements that START with ALTER TABLE.
  {
    version: 9,
    sql: `ALTER TABLE code_edges ADD COLUMN id TEXT NOT NULL DEFAULT '';`,
  },
  {
    version: 10,
    sql: `
CREATE TABLE IF NOT EXISTS project_stack_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  last_files_hash TEXT NOT NULL DEFAULT '',
  pending_changes INTEGER NOT NULL DEFAULT 0
);
`,
  },
  {
    version: 11,
    sql: `
CREATE TABLE IF NOT EXISTS review_transition_cache (
  session_id TEXT NOT NULL,
  parent_commit TEXT NOT NULL,
  child_commit TEXT NOT NULL,
  hunks_json TEXT NOT NULL,
  code_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, parent_commit, child_commit)
);
`,
  },
];
