import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getCodeFile,
  getCodeIndexState,
  listCodeFiles,
  listExternalModules,
  listFileImportedBy,
  listFileImports,
  listFileSymbols,
  openEchoDb,
  replaceProjectCodeIndex,
  searchCodeSymbols,
  upsertProject,
} from "./index";

function openTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "echo-codeidx-"));
  return openEchoDb(join(dir, "echo.sqlite"));
}

function seed(db: ReturnType<typeof openTestDb>) {
  upsertProject(db, { id: "prj_1", root: "/repo", name: "repo" });
  replaceProjectCodeIndex(db, "prj_1", {
    files: [
      {
        file: { path: "src/a.ts", language: "ts", size: 10, sha256: "aaa", parsed: true },
        symbols: [
          {
            id: "sym_0000000000000001",
            file: "src/a.ts",
            name: "alpha",
            kind: "function",
            exported: true,
            line: 1,
          },
        ],
        edges: [
          {
            fromFile: "src/a.ts",
            toFile: "src/b.ts",
            externalModule: null,
            kind: "imports",
            names: ["beta"],
            resolved: true,
          },
          {
            fromFile: "src/a.ts",
            toFile: null,
            externalModule: "react",
            kind: "imports",
            names: [],
            resolved: false,
          },
        ],
      },
      {
        file: { path: "src/b.ts", language: "ts", size: 8, sha256: "bbb", parsed: true },
        symbols: [
          {
            id: "sym_0000000000000002",
            file: "src/b.ts",
            name: "beta",
            kind: "function",
            exported: true,
            line: 3,
          },
        ],
        edges: [],
      },
    ],
    state: {
      filesHash: "hash1",
      fileCount: 2,
      symbolCount: 2,
      edgeCount: 2,
      stackJson: "{}",
      indexedAt: "2026-10-29T00:00:00.000Z",
      parser: "test",
    },
  });
}

describe("project code index", () => {
  it("round-trips files, symbols, edges and state", () => {
    const db = openTestDb();
    try {
      seed(db);
      expect(getCodeIndexState(db, "prj_1")).toMatchObject({
        projectId: "prj_1",
        filesHash: "hash1",
        fileCount: 2,
        symbolCount: 2,
        edgeCount: 2,
      });
      const { files, truncated } = listCodeFiles(db, "prj_1", 10);
      expect(truncated).toBe(false);
      expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
      expect(files[0]).toMatchObject({ symbolCount: 1, importCount: 2, parsed: true });
      expect(listFileSymbols(db, "prj_1", "src/a.ts").map((s) => s.name)).toEqual(["alpha"]);
      expect(listFileImports(db, "prj_1", "src/a.ts")).toHaveLength(2);
      expect(listFileImportedBy(db, "prj_1", "src/b.ts").map((e) => e.fromFile)).toEqual([
        "src/a.ts",
      ]);
      expect(searchCodeSymbols(db, "prj_1", "alp", 10).symbols.map((s) => s.name)).toEqual([
        "alpha",
      ]);
      // Prefix semantics: mid-name fragments do not match.
      expect(searchCodeSymbols(db, "prj_1", "pha", 10).symbols).toEqual([]);
      expect(listExternalModules(db, "prj_1")).toEqual([{ module: "react", fileCount: 1 }]);
      expect(getCodeFile(db, "prj_1", "src/nope.ts")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("escapes LIKE wildcards in symbol search", () => {
    const db = openTestDb();
    try {
      seed(db);
      expect(searchCodeSymbols(db, "prj_1", "%", 10).symbols).toEqual([]);
      expect(searchCodeSymbols(db, "prj_1", "_", 10).symbols).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("replaces the whole project index on reindex", () => {
    const db = openTestDb();
    try {
      seed(db);
      replaceProjectCodeIndex(db, "prj_1", {
        files: [
          {
            file: { path: "src/c.ts", language: "ts", size: 5, sha256: "ccc", parsed: true },
            symbols: [],
            edges: [],
          },
        ],
        state: {
          filesHash: "hash2",
          fileCount: 1,
          symbolCount: 0,
          edgeCount: 0,
          stackJson: "{}",
          indexedAt: "2026-10-29T01:00:00.000Z",
          parser: "test",
        },
      });
      expect(listCodeFiles(db, "prj_1", 10).files.map((f) => f.path)).toEqual(["src/c.ts"]);
      expect(searchCodeSymbols(db, "prj_1", "alp", 10).symbols).toEqual([]);
      expect(listFileImportedBy(db, "prj_1", "src/b.ts")).toEqual([]);
      expect(getCodeIndexState(db, "prj_1")).toMatchObject({ filesHash: "hash2", fileCount: 1 });
    } finally {
      db.close();
    }
  });

  it("dedupes identical edges within a file", () => {
    const db = openTestDb();
    try {
      upsertProject(db, { id: "prj_1", root: "/repo", name: "repo" });
      const edge = {
        fromFile: "src/a.ts",
        toFile: "src/b.ts",
        externalModule: null,
        kind: "imports" as const,
        names: ["beta"],
        resolved: true,
      };
      replaceProjectCodeIndex(db, "prj_1", {
        files: [
          {
            file: { path: "src/a.ts", language: "ts", size: 1, sha256: "a", parsed: true },
            symbols: [],
            edges: [edge, edge],
          },
        ],
        state: {
          filesHash: "h",
          fileCount: 1,
          symbolCount: 0,
          edgeCount: 1,
          stackJson: "{}",
          indexedAt: "2026-10-29T00:00:00.000Z",
          parser: "test",
        },
      });
      expect(listFileImports(db, "prj_1", "src/a.ts")).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
