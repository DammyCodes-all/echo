import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CodeEdge,
  CodeFile,
  CodeFileDetail,
  CodeGraphResponse,
  CodeIndexState,
  CodeSymbol,
} from "@echo/contracts";
import {
  type EchoDb,
  getCodeFile,
  getCodeIndexState,
  getProject,
  listCodeFiles,
  listFileImportedBy,
  listFileImports,
  listFileSymbols,
  replaceProjectCodeIndex,
  searchCodeSymbols,
} from "@echo/db";
import {
  detectStack,
  inventoryRepo,
  isParsableLanguage,
  PARSER_NAME,
  parseFile,
} from "@echo/graph";

export interface FailedFile {
  path: string;
  reason: string;
}

export interface ReindexResult {
  state: CodeIndexState;
  rebuilt: boolean;
  failed: FailedFile[];
  skipped: FailedFile[];
  truncated: boolean;
}

export interface CodeIndexService {
  reindex(projectId: string, options?: { force?: boolean }): ReindexResult | null;
  state(projectId: string): CodeIndexState | null;
  files(projectId: string, limit: number): { files: CodeFile[]; truncated: boolean } | null;
  symbols(
    projectId: string,
    query: string,
    limit: number,
  ): { symbols: CodeSymbol[]; truncated: boolean } | null;
  fileDetail(projectId: string, path: string): CodeFileDetail | null;
  graph(projectId: string, root: string, depth: number, limit: number): CodeGraphResponse | null;
}

function clampLimit(limit: number, fallback: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return fallback;
  return Math.min(limit, 1000);
}

export function createCodeIndexService(options: { db: EchoDb }): CodeIndexService {
  const { db } = options;

  function reindex(projectId: string, opts?: { force?: boolean }): ReindexResult | null {
    const project = getProject(db, projectId);
    if (!project) return null;
    let inventory: ReturnType<typeof inventoryRepo>;
    try {
      inventory = inventoryRepo(project.root);
    } catch {
      throw new Error("code_index_root_unreadable");
    }
    const stored = getCodeIndexState(db, projectId);
    if (
      !opts?.force &&
      stored &&
      stored.filesHash === inventory.filesHash &&
      stored.parser === PARSER_NAME
    ) {
      return { state: stored, rebuilt: false, failed: [], skipped: [], truncated: false };
    }
    const fileSet = new Set(inventory.files.map((file) => file.path));
    const packageBodies: string[] = [];
    for (const file of inventory.files) {
      if (file.path === "package.json" || file.path.endsWith("/package.json")) {
        try {
          packageBodies.push(readFileSync(join(project.root, file.path), "utf8"));
        } catch {
          // Best effort: a missing package.json just means no stack signals.
        }
      }
    }
    const failed: FailedFile[] = [];
    const entries: Array<{
      file: { path: string; language: string; size: number; sha256: string; parsed: boolean };
      symbols: CodeSymbol[];
      edges: CodeEdge[];
    }> = [];
    let symbolCount = 0;
    let edgeCount = 0;
    for (const file of inventory.files) {
      if (!isParsableLanguage(file.language)) {
        entries.push({ file: { ...file, parsed: false }, symbols: [], edges: [] });
        continue;
      }
      let source: string;
      try {
        source = readFileSync(join(project.root, file.path), "utf8");
      } catch {
        failed.push({ path: file.path, reason: "unreadable" });
        entries.push({ file: { ...file, parsed: false }, symbols: [], edges: [] });
        continue;
      }
      const outcome = parseFile(projectId, file.path, file.language, source, fileSet);
      if (!outcome.ok) {
        failed.push({ path: file.path, reason: outcome.reason });
        entries.push({ file: { ...file, parsed: false }, symbols: [], edges: [] });
        continue;
      }
      symbolCount += outcome.parsed.symbols.length;
      edgeCount += outcome.parsed.edges.length;
      entries.push({
        file: { ...file, parsed: true },
        symbols: outcome.parsed.symbols,
        edges: outcome.parsed.edges,
      });
    }
    const stack = detectStack(inventory, packageBodies);
    const indexedAt = new Date().toISOString();
    replaceProjectCodeIndex(db, projectId, {
      files: entries,
      state: {
        filesHash: inventory.filesHash,
        fileCount: inventory.files.length,
        symbolCount,
        edgeCount,
        stackJson: JSON.stringify(stack),
        indexedAt,
        parser: PARSER_NAME,
      },
    });
    const state = getCodeIndexState(db, projectId);
    if (!state) throw new Error("code_index_state_missing");
    return {
      state,
      rebuilt: true,
      failed,
      skipped: inventory.skipped,
      truncated: inventory.truncated,
    };
  }

  function ensureFresh(projectId: string): boolean {
    const result = reindex(projectId);
    return result !== null;
  }

  return {
    reindex,
    state(projectId) {
      if (!ensureFresh(projectId)) return null;
      return getCodeIndexState(db, projectId);
    },
    files(projectId, limit) {
      if (!ensureFresh(projectId)) return null;
      return listCodeFiles(db, projectId, clampLimit(limit, 200));
    },
    symbols(projectId, query, limit) {
      if (!ensureFresh(projectId)) return null;
      return searchCodeSymbols(db, projectId, query, clampLimit(limit, 50));
    },
    fileDetail(projectId, path) {
      if (!ensureFresh(projectId)) return null;
      const file = getCodeFile(db, projectId, path);
      if (!file) return null;
      return {
        projectId,
        file,
        symbols: listFileSymbols(db, projectId, path),
        imports: listFileImports(db, projectId, path),
        importedBy: listFileImportedBy(db, projectId, path),
      };
    },
    graph(projectId, root, depth, limit) {
      if (!ensureFresh(projectId)) return null;
      const start = getCodeFile(db, projectId, root);
      if (!start) return null;
      const maxDepth = Number.isInteger(depth) && depth >= 0 ? Math.min(depth, 5) : 1;
      const maxNodes = clampLimit(limit, 200);
      const seen = new Set<string>([root]);
      const edges: CodeEdge[] = [];
      const seenEdges = new Set<string>();
      let frontier = [root];
      let truncated = false;
      for (let level = 0; level < maxDepth && frontier.length > 0; level++) {
        const next: string[] = [];
        for (const file of frontier) {
          const neighbors = [...listFileImports(db, projectId, file)].flatMap((edge) =>
            edge.toFile ? [edge] : [],
          );
          const backlinks = listFileImportedBy(db, projectId, file);
          for (const edge of [...neighbors, ...backlinks]) {
            const key = `${edge.fromFile}\0${edge.kind}\0${edge.toFile ?? ""}\0${edge.externalModule ?? ""}`;
            if (!seenEdges.has(key)) {
              seenEdges.add(key);
              edges.push(edge);
            }
            const other = edge.fromFile === file ? edge.toFile : edge.fromFile;
            if (other && !seen.has(other)) {
              if (seen.size >= maxNodes) {
                truncated = true;
                break;
              }
              seen.add(other);
              next.push(other);
            }
          }
          if (truncated) break;
        }
        frontier = next;
      }
      return {
        projectId,
        root,
        depth: maxDepth,
        files: [...seen].sort(),
        edges: edges.sort((a, b) =>
          a.fromFile < b.fromFile ? -1 : a.fromFile > b.fromFile ? 1 : 0,
        ),
        truncated,
      };
    },
  };
}
