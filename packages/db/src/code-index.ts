import type { CodeEdge, CodeFile, CodeIndexState, CodeSymbol } from "@echo/contracts";
import { type EchoDb, withTransaction } from "./database";

export interface CodeFileRow {
  path: string;
  language: string;
  size: number;
  sha256: string;
  parsed: boolean;
}

export interface CodeIndexInput {
  files: Array<{
    file: CodeFileRow;
    symbols: CodeSymbol[];
    edges: CodeEdge[];
  }>;
  state: Omit<CodeIndexState, "projectId">;
}

function edgeId(edge: CodeEdge): string {
  return [
    edge.fromFile,
    edge.kind,
    edge.toFile ?? "",
    edge.externalModule ?? "",
    [...edge.names].sort().join(","),
    edge.resolved ? "1" : "0",
  ].join("\0");
}

function toCodeFile(row: CodeFileRow & { symbolCount: number; importCount: number }): CodeFile {
  return {
    path: row.path,
    language: row.language as CodeFile["language"],
    size: row.size,
    sha256: row.sha256,
    parsed: row.parsed,
    symbolCount: row.symbolCount,
    importCount: row.importCount,
  };
}

export function replaceProjectCodeIndex(
  db: EchoDb,
  projectId: string,
  input: CodeIndexInput,
): void {
  withTransaction(db, () => {
    db.prepare("DELETE FROM code_edges WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM code_symbols WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM code_files WHERE project_id = ?").run(projectId);
    const insertFile = db.prepare(
      `INSERT INTO code_files (project_id, path, language, size, sha256, parsed, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSymbol = db.prepare(
      `INSERT INTO code_symbols (id, project_id, file, name, kind, exported, line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEdge = db.prepare(
      `INSERT INTO code_edges (id, project_id, from_file, to_file, external_module, kind, names_json, resolved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const entry of input.files) {
      insertFile.run(
        projectId,
        entry.file.path,
        entry.file.language,
        entry.file.size,
        entry.file.sha256,
        entry.file.parsed ? 1 : 0,
        now,
      );
      for (const symbol of entry.symbols) {
        insertSymbol.run(
          symbol.id,
          projectId,
          symbol.file,
          symbol.name,
          symbol.kind,
          symbol.exported ? 1 : 0,
          symbol.line,
        );
      }
      const seen = new Set<string>();
      for (const edge of entry.edges) {
        const id = edgeId(edge);
        if (seen.has(id)) continue;
        seen.add(id);
        insertEdge.run(
          id,
          projectId,
          edge.fromFile,
          edge.toFile,
          edge.externalModule,
          edge.kind,
          JSON.stringify(edge.names),
          edge.resolved ? 1 : 0,
        );
      }
    }
    db.prepare(
      `INSERT INTO code_index_state
         (project_id, files_hash, file_count, symbol_count, edge_count, stack_json, indexed_at, parser)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         files_hash = excluded.files_hash, file_count = excluded.file_count,
         symbol_count = excluded.symbol_count, edge_count = excluded.edge_count,
         stack_json = excluded.stack_json, indexed_at = excluded.indexed_at,
         parser = excluded.parser`,
    ).run(
      projectId,
      input.state.filesHash,
      input.state.fileCount,
      input.state.symbolCount,
      input.state.edgeCount,
      input.state.stackJson,
      input.state.indexedAt,
      input.state.parser,
    );
  });
}

export function getCodeIndexState(db: EchoDb, projectId: string): CodeIndexState | null {
  const row = db
    .prepare(
      `SELECT project_id AS projectId, files_hash AS filesHash, file_count AS fileCount,
              symbol_count AS symbolCount, edge_count AS edgeCount, stack_json AS stackJson,
              indexed_at AS indexedAt, parser
       FROM code_index_state WHERE project_id = ?`,
    )
    .get(projectId) as CodeIndexState | undefined;
  return row ?? null;
}

export function listCodeFiles(
  db: EchoDb,
  projectId: string,
  limit: number,
): { files: CodeFile[]; truncated: boolean } {
  const rows = db
    .prepare(
      `SELECT f.path AS path, f.language AS language, f.size AS size, f.sha256 AS sha256,
              f.parsed AS parsed,
              (SELECT COUNT(*) FROM code_symbols s WHERE s.project_id = f.project_id AND s.file = f.path) AS symbolCount,
              (SELECT COUNT(*) FROM code_edges e WHERE e.project_id = f.project_id AND e.from_file = f.path) AS importCount
       FROM code_files f WHERE f.project_id = ? ORDER BY f.path LIMIT ?`,
    )
    .all(projectId, limit + 1) as Array<{
    path: string;
    language: string;
    size: number;
    sha256: string;
    parsed: number;
    symbolCount: number;
    importCount: number;
  }>;
  const truncated = rows.length > limit;
  const files = rows.slice(0, limit).map((row) =>
    toCodeFile({
      path: row.path,
      language: row.language,
      size: row.size,
      sha256: row.sha256,
      parsed: row.parsed === 1,
      symbolCount: row.symbolCount,
      importCount: row.importCount,
    }),
  );
  return { files, truncated };
}

function rowToSymbol(row: {
  id: string;
  file: string;
  name: string;
  kind: string;
  exported: number;
  line: number;
}): CodeSymbol {
  return {
    id: row.id as CodeSymbol["id"],
    file: row.file,
    name: row.name,
    kind: row.kind as CodeSymbol["kind"],
    exported: row.exported === 1,
    line: row.line,
  };
}

function rowToEdge(row: {
  fromFile: string;
  toFile: string | null;
  externalModule: string | null;
  kind: string;
  namesJson: string;
  resolved: number;
}): CodeEdge {
  return {
    fromFile: row.fromFile,
    toFile: row.toFile,
    externalModule: row.externalModule,
    kind: row.kind as CodeEdge["kind"],
    names: JSON.parse(row.namesJson) as string[],
    resolved: row.resolved === 1,
  };
}

const SYMBOL_COLUMNS = "id, file, name, kind, exported, line";
const EDGE_COLUMNS =
  "from_file AS fromFile, to_file AS toFile, external_module AS externalModule, kind, names_json AS namesJson, resolved";

export function searchCodeSymbols(
  db: EchoDb,
  projectId: string,
  query: string,
  limit: number,
): { symbols: CodeSymbol[]; truncated: boolean } {
  const rows = db
    .prepare(
      `SELECT ${SYMBOL_COLUMNS} FROM code_symbols
       WHERE project_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY name, file LIMIT ?`,
    )
    .all(projectId, `${query.replace(/[\\%_]/g, "\\$&")}%`, limit + 1) as Array<{
    id: string;
    file: string;
    name: string;
    kind: string;
    exported: number;
    line: number;
  }>;
  const truncated = rows.length > limit;
  return { symbols: rows.slice(0, limit).map(rowToSymbol), truncated };
}

export function listFileSymbols(db: EchoDb, projectId: string, path: string): CodeSymbol[] {
  const rows = db
    .prepare(
      `SELECT ${SYMBOL_COLUMNS} FROM code_symbols
       WHERE project_id = ? AND file = ? ORDER BY line`,
    )
    .all(projectId, path) as Array<{
    id: string;
    file: string;
    name: string;
    kind: string;
    exported: number;
    line: number;
  }>;
  return rows.map(rowToSymbol);
}

export function listFileImports(db: EchoDb, projectId: string, path: string): CodeEdge[] {
  const rows = db
    .prepare(
      `SELECT ${EDGE_COLUMNS} FROM code_edges
       WHERE project_id = ? AND from_file = ? ORDER BY to_file, external_module`,
    )
    .all(projectId, path) as Array<{
    fromFile: string;
    toFile: string | null;
    externalModule: string | null;
    kind: string;
    namesJson: string;
    resolved: number;
  }>;
  return rows.map(rowToEdge);
}

export function listFileImportedBy(db: EchoDb, projectId: string, path: string): CodeEdge[] {
  const rows = db
    .prepare(
      `SELECT ${EDGE_COLUMNS} FROM code_edges
       WHERE project_id = ? AND to_file = ? ORDER BY from_file`,
    )
    .all(projectId, path) as Array<{
    fromFile: string;
    toFile: string | null;
    externalModule: string | null;
    kind: string;
    namesJson: string;
    resolved: number;
  }>;
  return rows.map(rowToEdge);
}

export function getCodeFile(db: EchoDb, projectId: string, path: string): CodeFile | null {
  const row = db
    .prepare(
      `SELECT f.path AS path, f.language AS language, f.size AS size, f.sha256 AS sha256,
              f.parsed AS parsed,
              (SELECT COUNT(*) FROM code_symbols s WHERE s.project_id = f.project_id AND s.file = f.path) AS symbolCount,
              (SELECT COUNT(*) FROM code_edges e WHERE e.project_id = f.project_id AND e.from_file = f.path) AS importCount
       FROM code_files f WHERE f.project_id = ? AND f.path = ?`,
    )
    .get(projectId, path) as
    | {
        path: string;
        language: string;
        size: number;
        sha256: string;
        parsed: number;
        symbolCount: number;
        importCount: number;
      }
    | undefined;
  if (!row) return null;
  return toCodeFile({
    path: row.path,
    language: row.language,
    size: row.size,
    sha256: row.sha256,
    parsed: row.parsed === 1,
    symbolCount: row.symbolCount,
    importCount: row.importCount,
  });
}

export function listExternalModules(
  db: EchoDb,
  projectId: string,
): Array<{ module: string; fileCount: number }> {
  const rows = db
    .prepare(
      `SELECT external_module AS module, COUNT(DISTINCT from_file) AS fileCount
       FROM code_edges WHERE project_id = ? AND external_module IS NOT NULL
       GROUP BY external_module ORDER BY fileCount DESC, module`,
    )
    .all(projectId) as Array<{ module: string; fileCount: number }>;
  return rows;
}
