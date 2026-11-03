import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeEdge, CodeFile, CodeSymbol } from "@echo/contracts";
import {
  type EchoDb,
  listCodeFiles,
  openEchoDb,
  replaceProjectCodeIndex,
  upsertProject,
} from "@echo/db";
import { describe, expect, test } from "vitest";
import { buildDrillFileContext, type DrillLimits } from "./architecture-drill";

function symId(n: number): `sym_${string}` {
  return `sym_${n.toString(16).padStart(16, "0")}`;
}

function symbol(
  file: string,
  n: number,
  name: string,
  kind: CodeSymbol["kind"],
  exported: boolean,
): CodeSymbol {
  return { id: symId(n), file, name, kind, exported, line: n };
}

function edge(
  fromFile: string,
  toFile: string | null,
  names: string[] = [],
  extra?: Partial<CodeEdge>,
): CodeEdge {
  return {
    fromFile,
    toFile,
    externalModule: null,
    kind: "imports",
    names,
    resolved: toFile !== null,
    ...extra,
  };
}

function seed(files: Array<{ file: CodeFile; symbols?: CodeSymbol[]; edges?: CodeEdge[] }>): {
  db: EchoDb;
  dir: string;
  root: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "echo-arch-drill-"));
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  const db = openEchoDb(join(dir, "echo.sqlite"));
  upsertProject(db, { id: "prj_1", root, name: "repo" });
  replaceProjectCodeIndex(db, "prj_1", {
    files: files.map((entry) => ({
      file: {
        path: entry.file.path,
        language: entry.file.language,
        size: entry.file.size,
        sha256: entry.file.sha256,
        parsed: entry.file.parsed,
      },
      symbols: entry.symbols ?? [],
      edges: entry.edges ?? [],
    })),
    state: {
      filesHash: "h",
      fileCount: files.length,
      symbolCount: 0,
      edgeCount: 0,
      stackJson: "{}",
      indexedAt: "2026-10-29T00:00:00.000Z",
      parser: "test",
    },
  });
  return { db, dir, root };
}

function codeFile(path: string, size = 100, language = "ts", parsed = true): CodeFile {
  return {
    path,
    language: language as CodeFile["language"],
    size,
    sha256: "x",
    parsed,
    symbolCount: 0,
    importCount: 0,
  };
}

describe("buildDrillFileContext", () => {
  test("lists symbols split into exports and internal with a per-file cap", () => {
    const { db, root } = seed([
      {
        file: codeFile("src/map.ts"),
        symbols: [
          symbol("src/map.ts", 1, "buildTapeEvent", "function", true),
          symbol("src/map.ts", 2, "MAX_PAYLOAD_BYTES", "const", true),
          ...Array.from({ length: 11 }, (_, i) =>
            symbol("src/map.ts", 10 + i, `helper${i}`, "function", false),
          ),
        ],
        edges: [],
      },
    ]);
    try {
      const { files } = listCodeFiles(db, "prj_1", 10);
      const context = buildDrillFileContext(files, 120, { db, projectId: "prj_1", root });
      expect(context).toContain("src/map.ts (ts, 100b)");
      expect(context).toContain("exports: buildTapeEvent (function), MAX_PAYLOAD_BYTES (const)");
      expect(context).toContain("helper0 (function)");
      expect(context).toContain("[+1 more]");
      expect(buildDrillFileContext(files, 120, { db, projectId: "prj_1", root })).toBe(context);
    } finally {
      db.close();
    }
  });

  test("lists in-scope imports and drops out-of-scope, external, and unresolvable", () => {
    const { db, root } = seed([
      {
        file: codeFile("src/a.ts"),
        symbols: [],
        edges: [
          edge("src/a.ts", "src/b.ts", ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]),
          edge("src/a.ts", "src/outside.ts", ["other"]),
          { ...edge("src/a.ts", null, []), externalModule: "react", resolved: true },
          { ...edge("src/a.ts", null, []), resolved: false },
        ],
      },
      { file: codeFile("src/b.ts"), symbols: [], edges: [] },
    ]);
    try {
      const { files } = listCodeFiles(db, "prj_1", 10);
      const scoped = files.filter((file) => file.path !== "src/outside.ts");
      const context = buildDrillFileContext(scoped, 120, { db, projectId: "prj_1", root });
      expect(context).toContain("src/a.ts -> src/b.ts (n1, n2, n3, n4, n5, n6, +2 more)");
      expect(context).not.toContain("src/outside.ts");
      expect(context).not.toContain("react");
      expect(context).toContain("1 import unresolvable");
    } finally {
      db.close();
    }
  });

  test("includes small file contents and skips tests, oversized, config, and missing", () => {
    const { db, root } = seed([
      { file: codeFile("src/small.ts"), symbols: [], edges: [] },
      { file: codeFile("src/big.ts", 5000), symbols: [], edges: [] },
      { file: codeFile("src/helper.test.ts"), symbols: [], edges: [] },
      { file: codeFile("src/data.json", 100, "json"), symbols: [], edges: [] },
      { file: codeFile("src/missing.ts"), symbols: [], edges: [] },
    ]);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "small.ts"), "export const x = 1;\n");
    try {
      const { files } = listCodeFiles(db, "prj_1", 10);
      const context = buildDrillFileContext(files, 120, { db, projectId: "prj_1", root });
      expect(context).toContain("--- src/small.ts\nexport const x = 1;");
      expect(context).not.toContain("--- src/big.ts");
      expect(context).not.toContain("--- src/helper.test.ts");
      expect(context).not.toContain("--- src/data.json");
      expect(context).not.toContain("--- src/missing.ts");
      expect(context).toContain("1 test file shown by name only");
      expect(context).toContain("1 file unreadable, skipped");
    } finally {
      db.close();
    }
  });

  test("never reads outside the project root", () => {
    const { db, dir, root } = seed([]);
    try {
      writeFileSync(join(dir, "sentinel.txt"), "SENTINEL_OUTSIDE_ROOT");
      const scoped = [codeFile("../sentinel.txt", 20, "md")];
      const context = buildDrillFileContext(scoped, 120, { db, projectId: "prj_1", root });
      expect(context).not.toContain("SENTINEL_OUTSIDE_ROOT");
      expect(context).toContain("1 file unreadable, skipped");
    } finally {
      db.close();
    }
  });

  test("caps contents, symbol detail, and edges with honest notes", () => {
    const { db, root } = seed(
      Array.from({ length: 8 }, (_, i) => ({
        file: codeFile(`src/f${i}.ts`),
        symbols: [symbol(`src/f${i}.ts`, i + 1, `fn${i}`, "function", true)],
        edges: [edge(`src/f${i}.ts`, "src/f0.ts", [`fn${i}`])],
      })),
    );
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      for (let i = 0; i < 8; i += 1) {
        writeFileSync(join(root, "src", `f${i}.ts`), `export function fn${i}() {}\n`);
      }
      const { files } = listCodeFiles(db, "prj_1", 10);
      const context = buildDrillFileContext(files, 120, { db, projectId: "prj_1", root });
      expect(context.match(/^--- /gm)?.length).toBe(6);
      expect(context).toContain("contents capped (2 files omitted)");

      const limits: DrillLimits = { structureBudget: 40, edgeLines: 1 };
      const starved = buildDrillFileContext(files, 120, { db, projectId: "prj_1", root }, limits);
      expect(starved).toContain("symbol detail capped");
      expect(starved).toContain("imports capped at 1 of 8");
    } finally {
      db.close();
    }
  });

  test("handles an empty scope and files beyond the list cap", () => {
    const { db, root } = seed([{ file: codeFile("src/a.ts"), symbols: [], edges: [] }]);
    try {
      expect(buildDrillFileContext([], 120, { db, projectId: "prj_1", root })).toBe(
        "Project files in scope (0):",
      );
      const { files } = listCodeFiles(db, "prj_1", 10);
      const context = buildDrillFileContext(files, 0, { db, projectId: "prj_1", root });
      expect(context).toContain("… and 1 file beyond the list cap");
    } finally {
      db.close();
    }
  });
});
