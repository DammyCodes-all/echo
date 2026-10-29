import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodeFileDetailSchema,
  CodeFilesResponseSchema,
  CodeGraphResponseSchema,
  CodeIndexStateSchema,
  CodeSymbolsResponseSchema,
} from "@echo/contracts";
import { type EchoDb, openEchoDb, upsertProject } from "@echo/db";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeIndexService } from "./code-index";

const openDbs: EchoDb[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function seedRepo(): { db: EchoDb; root: string; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), "echo-codeindex-"));
  const db = openEchoDb(join(dir, "echo.sqlite"));
  openDbs.push(db);
  const root = join(dir, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
  writeFileSync(
    join(root, "src", "a.ts"),
    'import { b } from "./b";\nexport function alpha() {\n  return b();\n}\n',
  );
  writeFileSync(join(root, "src", "b.ts"), "export function b() {\n  return 1;\n}\n");
  writeFileSync(join(root, "src", "broken.ts"), "function (broken");
  writeFileSync(join(root, "README.md"), "# test\n");
  const projectId = "prj_code";
  upsertProject(db, { id: projectId, root, name: "code" });
  return { db, root, projectId };
}

describe("code index service", () => {
  it("indexes a repo: state, files, symbols, edges, stack, failures", () => {
    const { db, projectId } = seedRepo();
    const service = createCodeIndexService({ db });
    const result = service.reindex(projectId);
    expect(result).not.toBeNull();
    expect(result?.rebuilt).toBe(true);
    expect(CodeIndexStateSchema.parse(result?.state)).toBeTruthy();
    expect(result?.state.fileCount).toBe(5);
    expect(result?.state.symbolCount).toBe(2);
    expect(result?.failed).toEqual([{ path: "src/broken.ts", reason: "syntax-error" }]);
    expect(JSON.parse(result?.state.stackJson ?? "{}").frameworks).toEqual(["Next.js"]);

    const files = service.files(projectId, 10);
    expect(
      CodeFilesResponseSchema.parse({ projectId, files: files?.files, truncated: false }),
    ).toBeTruthy();
    expect(files?.files.map((file) => file.path).sort()).toEqual([
      "README.md",
      "package.json",
      "src/a.ts",
      "src/b.ts",
      "src/broken.ts",
    ]);
    expect(files?.files.find((file) => file.path === "README.md")?.parsed).toBe(false);
    expect(files?.files.find((file) => file.path === "src/broken.ts")?.parsed).toBe(false);

    const symbols = service.symbols(projectId, "alp", 10);
    expect(
      CodeSymbolsResponseSchema.parse({
        projectId,
        query: "alp",
        symbols: symbols?.symbols,
        truncated: false,
      }),
    ).toBeTruthy();
    expect(symbols?.symbols.map((symbol) => symbol.name)).toEqual(["alpha"]);

    const detail = service.fileDetail(projectId, "src/a.ts");
    expect(CodeFileDetailSchema.parse(detail)).toBeTruthy();
    expect(detail?.imports.map((edge) => edge.toFile)).toEqual(["src/b.ts"]);
    const backlink = service.fileDetail(projectId, "src/b.ts");
    expect(backlink?.importedBy.map((edge) => edge.fromFile)).toEqual(["src/a.ts"]);
    expect(service.fileDetail(projectId, "src/missing.ts")).toBeNull();
  });

  it("skips rebuilds when the tree is unchanged and rebuilds on change", () => {
    const { db, root, projectId } = seedRepo();
    const service = createCodeIndexService({ db });
    expect(service.reindex(projectId)?.rebuilt).toBe(true);
    expect(service.reindex(projectId)?.rebuilt).toBe(false);
    expect(service.reindex(projectId, { force: true })?.rebuilt).toBe(true);
    writeFileSync(join(root, "src", "c.ts"), "export const c = 1;\n");
    const after = service.reindex(projectId);
    expect(after?.rebuilt).toBe(true);
    expect(after?.state.fileCount).toBe(6);
  });

  it("walks the import graph with depth and truncation", () => {
    const { db, projectId } = seedRepo();
    const service = createCodeIndexService({ db });
    const depth0 = service.graph(projectId, "src/b.ts", 0, 100);
    expect(CodeGraphResponseSchema.parse(depth0)).toBeTruthy();
    expect(depth0?.files).toEqual(["src/b.ts"]);
    expect(depth0?.edges).toEqual([]);
    const depth1 = service.graph(projectId, "src/b.ts", 1, 100);
    expect(depth1?.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(depth1?.truncated).toBe(false);
    const tiny = service.graph(projectId, "src/b.ts", 5, 1);
    expect(tiny?.files).toEqual(["src/b.ts"]);
    expect(tiny?.truncated).toBe(true);
    expect(service.graph(projectId, "src/missing.ts", 1, 100)).toBeNull();
  });

  it("returns null for unknown projects and throws for unreadable roots", () => {
    const { db } = seedRepo();
    const service = createCodeIndexService({ db });
    expect(service.reindex("prj_missing")).toBeNull();
    expect(service.state("prj_missing")).toBeNull();
    expect(service.files("prj_missing", 10)).toBeNull();
    upsertProject(db, { id: "prj_gone", root: join(tmpdir(), "echo-no-such-dir"), name: null });
    expect(() => service.reindex("prj_gone")).toThrow("code_index_root_unreadable");
  });
});
