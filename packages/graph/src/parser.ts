import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CodeEdge, CodeLanguage, CodeSymbol, CodeSymbolKind } from "@echo/contracts";
import { parseSync, visitorKeys } from "oxc-parser";

export const PARSER_NAME = "oxc";

const PARSABLE: ReadonlySet<CodeLanguage> = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);

export function isParsableLanguage(language: CodeLanguage): boolean {
  return PARSABLE.has(language);
}

export type ResolvedTarget =
  | { kind: "file"; toFile: string }
  | { kind: "external"; module: string };

const PROBE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

function stripQuery(specifier: string): string {
  const cut = specifier.search(/[?#]/);
  return cut < 0 ? specifier : specifier.slice(0, cut);
}

function packageName(specifier: string): string {
  const bare = specifier.replace(/^node:/, "");
  if (!bare.startsWith("@")) return bare.split("/")[0] ?? bare;
  const parts = bare.split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : bare;
}

function jsToTsCandidates(specifier: string): string[] {
  if (specifier.endsWith(".js")) {
    const base = specifier.slice(0, -3);
    return [`${base}.ts`, `${base}.tsx`, `${base}.d.ts`];
  }
  if (specifier.endsWith(".jsx")) return [`${specifier.slice(0, -4)}.tsx`];
  if (specifier.endsWith(".mjs")) return [`${specifier.slice(0, -4)}.mts`];
  if (specifier.endsWith(".cjs")) return [`${specifier.slice(0, -4)}.cts`];
  return [];
}

/** Resolve an import specifier against the inventoried file set. */
export function resolveSpecifier(
  fromFile: string,
  rawSpecifier: string,
  files: ReadonlySet<string>,
): ResolvedTarget | null {
  const specifier = stripQuery(rawSpecifier);
  if (!specifier.startsWith(".")) {
    if (specifier.startsWith("/") || specifier.includes("://") || specifier === "") return null;
    return { kind: "external", module: packageName(specifier) };
  }
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const candidates = [base, ...jsToTsCandidates(base)];
  for (const candidate of candidates) {
    if (files.has(candidate)) return { kind: "file", toFile: candidate };
  }
  for (const candidate of [base, ...candidates.slice(1)]) {
    for (const extension of PROBE_EXTENSIONS) {
      const probed = `${candidate}${extension}`;
      if (files.has(probed)) return { kind: "file", toFile: probed };
    }
    for (const extension of PROBE_EXTENSIONS) {
      const probed = `${candidate}/index${extension}`;
      if (files.has(probed)) return { kind: "file", toFile: probed };
    }
  }
  return null;
}

export function symbolIdFor(
  projectId: string,
  path: string,
  name: string,
  kind: CodeSymbolKind,
  line: number,
): string {
  return `sym_${createHash("sha256")
    .update(`${projectId}\0${path}\0${name}\0${kind}\0${line}`)
    .digest("hex")
    .slice(0, 16)}`;
}

type NodeRecord = Record<string, unknown> & { type: string };

function isNode(value: unknown): value is NodeRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).type === "string"
  );
}

function identifierName(value: unknown): string | null {
  if (!isNode(value) || value.type !== "Identifier") return null;
  return typeof value.name === "string" ? value.name : null;
}

function stringLiteralValue(value: unknown): string | null {
  // String literals surface as `Literal` (ESTree flavor); accept the
  // `StringLiteral` spelling too for other parser flavors.
  if (!isNode(value) || (value.type !== "Literal" && value.type !== "StringLiteral")) return null;
  return typeof value.value === "string" ? value.value : null;
}

function nodeStart(value: NodeRecord): number {
  return typeof value.start === "number" ? value.start : 0;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = source.indexOf("\n"); index >= 0; index = source.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function lineForOffset(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function walk(node: unknown, visit: (node: NodeRecord) => void): void {
  if (!isNode(node)) return;
  visit(node);
  const keys = visitorKeys[node.type] ?? [];
  for (const key of keys) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const entry of child) walk(entry, visit);
    } else {
      walk(child, visit);
    }
  }
}

interface DeclaredSymbol {
  name: string;
  kind: CodeSymbolKind;
  offset: number;
}

function declarationSymbol(node: NodeRecord): DeclaredSymbol | null {
  const offset = nodeStart(node);
  switch (node.type) {
    case "FunctionDeclaration": {
      const name = identifierName(node.id);
      return name ? { name, kind: "function", offset } : null;
    }
    case "ClassDeclaration": {
      const name = identifierName(node.id);
      return name ? { name, kind: "class", offset } : null;
    }
    case "TSInterfaceDeclaration": {
      const name = identifierName(node.id);
      return name ? { name, kind: "interface", offset } : null;
    }
    case "TSTypeAliasDeclaration": {
      const name = identifierName(node.id);
      return name ? { name, kind: "type", offset } : null;
    }
    case "TSEnumDeclaration": {
      const name = identifierName(node.id);
      return name ? { name, kind: "enum", offset } : null;
    }
    default:
      return null;
  }
}

interface TopLevelScan {
  declared: DeclaredSymbol[];
  exportedLocals: Set<string>;
  defaultExported: DeclaredSymbol[];
  requireSpecifiers: string[];
}

function scanTopLevel(body: unknown[]): TopLevelScan {
  const declared: DeclaredSymbol[] = [];
  const exportedLocals = new Set<string>();
  const defaultExported: DeclaredSymbol[] = [];
  const requireSpecifiers: string[] = [];
  const collectRequire = (node: NodeRecord): void => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (!isNode(callee) || callee.type !== "Identifier" || callee.name !== "require") return;
    const args = node.arguments;
    if (!Array.isArray(args) || args.length === 0) return;
    const specifier = stringLiteralValue(args[0]);
    if (specifier) requireSpecifiers.push(specifier);
  };
  for (const statement of body) {
    if (!isNode(statement)) continue;
    walk(statement, collectRequire);
    if (statement.type === "VariableDeclaration") {
      const declarators = statement.declarations;
      if (!Array.isArray(declarators)) continue;
      for (const declarator of declarators) {
        if (!isNode(declarator)) continue;
        const name = identifierName(declarator.id);
        if (name) declared.push({ name, kind: "const", offset: nodeStart(declarator) });
      }
      continue;
    }
    if (statement.type === "ExportNamedDeclaration") {
      const inner = statement.declaration;
      if (isNode(inner)) {
        if (inner.type === "VariableDeclaration" && Array.isArray(inner.declarations)) {
          for (const declarator of inner.declarations) {
            if (!isNode(declarator)) continue;
            const name = identifierName(declarator.id);
            if (name) {
              declared.push({ name, kind: "const", offset: nodeStart(declarator) });
              exportedLocals.add(name);
            }
          }
        } else {
          const symbol = declarationSymbol(inner);
          if (symbol) {
            declared.push(symbol);
            exportedLocals.add(symbol.name);
          }
        }
      } else if (statement.source === null && Array.isArray(statement.specifiers)) {
        for (const specifier of statement.specifiers) {
          if (!isNode(specifier)) continue;
          const local = identifierName(specifier.local);
          if (local) exportedLocals.add(local);
        }
      }
      continue;
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const inner = statement.declaration;
      if (isNode(inner)) {
        const reexported = identifierName(inner);
        if (reexported) {
          exportedLocals.add(reexported);
          continue;
        }
        const symbol = declarationSymbol(inner);
        if (symbol) defaultExported.push(symbol);
        else
          defaultExported.push({
            name: "default",
            kind: inner.type === "FunctionDeclaration" ? "function" : "const",
            offset: nodeStart(inner),
          });
      }
      continue;
    }
    const symbol = declarationSymbol(statement);
    if (symbol) declared.push(symbol);
  }
  return { declared, exportedLocals, defaultExported, requireSpecifiers };
}

export interface ParsedFile {
  symbols: CodeSymbol[];
  edges: CodeEdge[];
}

export type ParseOutcome = { ok: true; parsed: ParsedFile } | { ok: false; reason: string };

function langFor(language: CodeLanguage): "js" | "jsx" | "ts" | "tsx" {
  switch (language) {
    case "tsx":
      return "tsx";
    case "jsx":
      return "jsx";
    case "js":
    case "mjs":
    case "cjs":
      return "js";
    default:
      return "ts";
  }
}

function dynamicSpecifier(source: string, start: number, end: number): string | null {
  const slice = source.slice(start, end).trim();
  if (slice.length < 2) return null;
  const quote = slice[0];
  if ((quote !== '"' && quote !== "'" && quote !== "`") || !slice.endsWith(quote)) return null;
  if (quote === "`" && slice.includes("${")) return null;
  return slice.slice(1, -1);
}

function edgeForSpecifier(
  fromFile: string,
  kind: CodeEdge["kind"],
  specifier: string,
  names: string[],
  files: ReadonlySet<string>,
): CodeEdge {
  const resolved = resolveSpecifier(fromFile, specifier, files);
  if (resolved?.kind === "file") {
    return {
      fromFile,
      toFile: resolved.toFile,
      externalModule: null,
      kind,
      names,
      resolved: true,
    };
  }
  if (resolved?.kind === "external") {
    return {
      fromFile,
      toFile: null,
      externalModule: resolved.module,
      kind,
      names,
      resolved: true,
    };
  }
  return { fromFile, toFile: null, externalModule: null, kind, names, resolved: false };
}

/**
 * Parse one file: top-level symbols plus import edges. Edges come from the
 * module record (plus a `require()` walk); symbols from a top-level AST scan.
 * Any syntax error fails the whole file — no partial claims are stored.
 */
export function parseFile(
  projectId: string,
  path: string,
  language: CodeLanguage,
  source: string,
  files: ReadonlySet<string>,
): ParseOutcome {
  if (!isParsableLanguage(language)) return { ok: false, reason: "not-parsable" };
  let result: ReturnType<typeof parseSync>;
  try {
    result = parseSync(path, source, {
      lang: langFor(language),
      sourceType: language === "cjs" ? "commonjs" : "module",
    });
  } catch {
    return { ok: false, reason: "parser-exception" };
  }
  if (result.errors.some((error) => error.severity === "Error")) {
    return { ok: false, reason: "syntax-error" };
  }
  const starts = lineStarts(source);
  const body = Array.isArray(result.program.body) ? result.program.body : [];
  const scan = scanTopLevel(body as unknown[]);
  const symbols: CodeSymbol[] = [];
  for (const declaredSymbol of [...scan.declared, ...scan.defaultExported]) {
    const line = lineForOffset(starts, declaredSymbol.offset);
    symbols.push({
      id: symbolIdFor(projectId, path, declaredSymbol.name, declaredSymbol.kind, line),
      file: path,
      name: declaredSymbol.name,
      kind: declaredSymbol.kind,
      exported: scan.exportedLocals.has(declaredSymbol.name),
      line,
    });
  }
  // Default exports are exported even though they carry no local binding name.
  for (const symbol of symbols) {
    if (scan.defaultExported.some((entry) => entry.name === symbol.name)) symbol.exported = true;
  }
  const edges: CodeEdge[] = [];
  const importNames = new Map<string, Set<string>>();
  for (const imp of result.module.staticImports) {
    const specifier = imp.moduleRequest.value;
    let names = importNames.get(specifier);
    if (!names) {
      names = new Set<string>();
      importNames.set(specifier, names);
    }
    for (const entry of imp.entries) {
      if (entry.localName.value.length > 0) names.add(entry.localName.value);
    }
  }
  for (const [specifier, names] of importNames) {
    edges.push(edgeForSpecifier(path, "imports", specifier, [...names].sort(), files));
  }
  const reexportNames = new Map<string, Set<string>>();
  for (const exp of result.module.staticExports) {
    for (const entry of exp.entries) {
      // Local exports carry no module request (undefined at runtime despite
      // the `| null` in the type surface).
      const request = entry.moduleRequest;
      if (request === null || request === undefined) continue;
      let names = reexportNames.get(request.value);
      if (!names) {
        names = new Set<string>();
        reexportNames.set(request.value, names);
      }
      if (typeof entry.exportName.name === "string" && entry.exportName.name.length > 0) {
        names.add(entry.exportName.name);
      }
    }
  }
  for (const [specifier, names] of reexportNames) {
    edges.push(edgeForSpecifier(path, "reexports", specifier, [...names].sort(), files));
  }
  for (const dynamic of result.module.dynamicImports) {
    const specifier = dynamicSpecifier(
      source,
      dynamic.moduleRequest.start,
      dynamic.moduleRequest.end,
    );
    if (specifier === null) {
      edges.push({
        fromFile: path,
        toFile: null,
        externalModule: null,
        kind: "dynamic",
        names: [],
        resolved: false,
      });
    } else {
      edges.push(edgeForSpecifier(path, "dynamic", specifier, [], files));
    }
  }
  for (const specifier of scan.requireSpecifiers) {
    edges.push(edgeForSpecifier(path, "imports", specifier, [], files));
  }
  return { ok: true, parsed: { symbols, edges } };
}
