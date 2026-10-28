import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations";

export type EchoDb = DatabaseSync;

export function openEchoDb(path: string): EchoDb {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Writers contend: daemon polls and CLI maintenance (e.g. import) share
  // this file. Wait briefly instead of failing fast with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function tableExists(db: EchoDb, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | null;
  return row?.name === table;
}

function columnExists(db: EchoDb, table: string, column: string): boolean {
  // Table names here are internal migration constants, never user input.
  const rows = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === column);
}

// Merge c6b7479 renumbered version 3: one branch shipped remote_url as v3,
// the other shipped reader_checkpoints as v3. Databases migrated on the
// remote_url branch recorded v3 without ever creating reader_checkpoints,
// then fail on v4 (duplicate column). Backfill the missing table so the
// normal loop can proceed.
function backfillRenumberedV3(db: EchoDb, applied: Set<number>): void {
  if (applied.has(3) && !tableExists(db, "reader_checkpoints")) {
    const v3 = MIGRATIONS.find((migration) => migration.version === 3);
    if (v3) db.exec(v3.sql);
  }
}

const ADD_COLUMN_PATTERN = /^alter\s+table\s+["'`[]?(\w+)["'`\]]?\s+add\s+column\s+["'`[]?(\w+)/i;

function migrate(db: EchoDb): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const appliedRows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => row.version));
  backfillRenumberedV3(db, applied);
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      // Statements run one at a time so a repeated ADD COLUMN (column
      // already present from a pre-renumber database) can be skipped
      // while the rest of the migration still applies. CREATEs are
      // IF NOT EXISTS in the migration SQL and no-op when present.
      for (const statement of migration.sql.split(";")) {
        const trimmed = statement.trim();
        if (trimmed === "") continue;
        const match = ADD_COLUMN_PATTERN.exec(trimmed);
        if (match && columnExists(db, match[1] as string, match[2] as string)) continue;
        db.exec(trimmed);
      }
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
      applied.add(migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function withTransaction<T>(db: EchoDb, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
