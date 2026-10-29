import { describe, expect, it } from "vitest";
import { isParsableLanguage, parseFile, resolveSpecifier } from "./parser";

const FILES = new Set([
  "src/a.ts",
  "src/b.ts",
  "src/dir/index.ts",
  "src/util.mts",
  "lib/helper.js",
]);

function parse(path: string, source: string) {
  const outcome = parseFile("prj_1", path, "ts", source, FILES);
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
  return outcome.parsed;
}

describe("resolveSpecifier", () => {
  it("resolves relative imports with extension and index probing", () => {
    expect(resolveSpecifier("src/a.ts", "./b", FILES)).toEqual({
      kind: "file",
      toFile: "src/b.ts",
    });
    expect(resolveSpecifier("src/a.ts", "./b.ts", FILES)).toEqual({
      kind: "file",
      toFile: "src/b.ts",
    });
    // TS-style .js specifier resolving to a .ts file.
    expect(resolveSpecifier("src/a.ts", "./b.js", FILES)).toEqual({
      kind: "file",
      toFile: "src/b.ts",
    });
    expect(resolveSpecifier("src/a.ts", "./dir", FILES)).toEqual({
      kind: "file",
      toFile: "src/dir/index.ts",
    });
    expect(resolveSpecifier("src/a.ts", "../lib/helper.js", FILES)).toEqual({
      kind: "file",
      toFile: "lib/helper.js",
    });
  });

  it("maps bare specifiers to package names and keeps unknown targets null", () => {
    expect(resolveSpecifier("src/a.ts", "react", FILES)).toEqual({
      kind: "external",
      module: "react",
    });
    expect(resolveSpecifier("src/a.ts", "@scope/pkg/sub", FILES)).toEqual({
      kind: "external",
      module: "@scope/pkg",
    });
    expect(resolveSpecifier("src/a.ts", "node:fs", FILES)).toEqual({
      kind: "external",
      module: "fs",
    });
    expect(resolveSpecifier("src/a.ts", "./missing", FILES)).toBeNull();
    expect(resolveSpecifier("src/a.ts", "/absolute", FILES)).toBeNull();
  });
});

describe("parseFile imports", () => {
  it("records static, re-export, dynamic and require edges", () => {
    const parsed = parse(
      "src/a.ts",
      `import { b } from "./b";
import react from "react";
export { b } from "./b";
export * from "./dir";
const lazy = await import("./util.mts");
const dyn = await import(name + "./b");
const req = require("../lib/helper.js");
const reqDyn = require(lookup);
`,
    );
    const byKind = (kind: string) => parsed.edges.filter((edge) => edge.kind === kind);
    expect(byKind("imports")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toFile: "src/b.ts", names: ["b"], resolved: true }),
        expect.objectContaining({
          toFile: null,
          externalModule: "react",
          names: ["react"],
          resolved: true,
        }),
        expect.objectContaining({ toFile: "lib/helper.js", resolved: true }),
      ]),
    );
    expect(parsed.edges).not.toContainEqual(expect.objectContaining({ names: ["lookup"] }));
    expect(
      byKind("reexports")
        .map((edge) => edge.toFile)
        .sort(),
    ).toEqual(["src/b.ts", "src/dir/index.ts"]);
    const dynamic = byKind("dynamic");
    expect(dynamic).toHaveLength(2);
    expect(dynamic).toContainEqual(
      expect.objectContaining({ toFile: "src/util.mts", resolved: true }),
    );
    expect(dynamic).toContainEqual(
      expect.objectContaining({ toFile: null, externalModule: null, resolved: false }),
    );
  });

  it("marks unresolvable relatives as unresolved without a target", () => {
    const parsed = parse("src/a.ts", `import "./missing";\n`);
    expect(parsed.edges).toEqual([
      {
        fromFile: "src/a.ts",
        toFile: null,
        externalModule: null,
        kind: "imports",
        names: [],
        resolved: false,
      },
    ]);
  });
});

describe("parseFile symbols", () => {
  it("extracts top-level declarations with export flags and lines", () => {
    const parsed = parse(
      "src/a.ts",
      `export function alpha() {}
class Beta {}
export interface Gamma {}
export type Delta = string;
export enum Epsilon { A }
const zeta = 1;
export const eta = 2;
export { Beta, zeta };
function theta() {}
export default theta;
`,
    );
    const byName = new Map(parsed.symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.get("alpha")).toMatchObject({ kind: "function", exported: true, line: 1 });
    expect(byName.get("Beta")).toMatchObject({ kind: "class", exported: true, line: 2 });
    expect(byName.get("Gamma")).toMatchObject({ kind: "interface", exported: true, line: 3 });
    expect(byName.get("Delta")).toMatchObject({ kind: "type", exported: true, line: 4 });
    expect(byName.get("Epsilon")).toMatchObject({ kind: "enum", exported: true, line: 5 });
    expect(byName.get("zeta")).toMatchObject({ kind: "const", exported: true, line: 6 });
    expect(byName.get("eta")).toMatchObject({ kind: "const", exported: true, line: 7 });
    // `export default theta` marks the existing declaration, no pseudo-symbol.
    expect(byName.get("theta")).toMatchObject({ kind: "function", exported: true, line: 9 });
    expect(byName.has("default")).toBe(false);
    for (const symbol of parsed.symbols) {
      expect(symbol.id).toMatch(/^sym_[0-9a-f]{16}$/);
      expect(symbol.file).toBe("src/a.ts");
    }
  });

  it("names anonymous default exports `default`", () => {
    const parsed = parse("src/a.ts", `export default function () {}\n`);
    expect(parsed.symbols).toHaveLength(1);
    expect(parsed.symbols[0]).toMatchObject({ name: "default", kind: "function", exported: true });
  });

  it("produces stable symbol ids across runs", () => {
    const first = parse("src/a.ts", `export function alpha() {}\n`);
    const second = parse("src/a.ts", `export function alpha() {}\n`);
    expect(first.symbols.map((symbol) => symbol.id)).toEqual(
      second.symbols.map((symbol) => symbol.id),
    );
  });
});

describe("parseFile failures", () => {
  it("fails closed on syntax errors and non-parsable languages", () => {
    expect(parseFile("prj_1", "src/a.ts", "ts", "function (broken", FILES)).toEqual({
      ok: false,
      reason: "syntax-error",
    });
    expect(parseFile("prj_1", "README.md", "md", "# hi", FILES)).toEqual({
      ok: false,
      reason: "not-parsable",
    });
    expect(isParsableLanguage("json")).toBe(false);
    expect(isParsableLanguage("tsx")).toBe(true);
  });
});
