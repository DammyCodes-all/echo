import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { CodeEdge, CodeFile } from "@echo/contracts";
import { type EchoDb, listFileImports, listFileSymbols } from "@echo/db";

/** Max symbols shown per file; the rest fold into a "+N more" count. */
export const DRILL_SYMBOLS_PER_FILE = 12;
/** Char budget for the files + symbols section; symbol detail stops when spent. */
export const DRILL_STRUCTURE_BUDGET = 18_000;
/** Max in-scope import lines; the rest fold into a count. */
export const DRILL_EDGE_LINES = 60;
/** Max imported names per edge line; the rest fold into a count. */
export const DRILL_EDGE_NAMES = 6;
/** Max files with full text; small files only, tests never. */
export const DRILL_CONTENT_FILES = 6;
/** Char budget across all included file texts. */
export const DRILL_CONTENT_CHARS = 12_000;
/** Chars of any single file's text. */
export const DRILL_CONTENT_PER_FILE = 3_000;
/** Index-size prefilter for contents; the read itself is char-capped. */
export const DRILL_CONTENT_MAX_BYTES = 3_072;

const CONTENT_LANGUAGES = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "md"]);

export interface DrillFileContextOptions {
  db: EchoDb;
  projectId: string;
  root: string;
  readFile?: (path: string) => string;
}

export interface DrillLimits {
  symbolsPerFile?: number;
  structureBudget?: number;
  edgeLines?: number;
  edgeNames?: number;
  contentFiles?: number;
  contentChars?: number;
  contentPerFile?: number;
  contentMaxBytes?: number;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests?__\/|[^/]*\.(test|spec)\.[^./]+$)/.test(path);
}

function formatEdge(edge: CodeEdge, nameCap: number): string {
  const shown = edge.names.slice(0, nameCap);
  const rest = edge.names.length - shown.length;
  const suffix = rest > 0 ? `, +${rest} more` : "";
  const names = edge.names.length > 0 ? ` (${shown.join(", ")}${suffix})` : "";
  return `${edge.fromFile} -> ${edge.toFile}${names}`;
}

/** Grounded drill context: per-file symbols and in-scope imports from the
 *  code index plus the full text of small files from disk. Deterministic for
 *  a fixed index and tree; every cap and skip is reported in Notes, never
 *  silent. Reads stay under root; anything unreadable is a gap, not an error. */
export function buildDrillFileContext(
  scoped: CodeFile[],
  limit: number,
  options: DrillFileContextOptions,
  overrides: DrillLimits = {},
): string {
  const { db, projectId, root } = options;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const symbolsPerFile = overrides.symbolsPerFile ?? DRILL_SYMBOLS_PER_FILE;
  const structureBudget = overrides.structureBudget ?? DRILL_STRUCTURE_BUDGET;
  const edgeLinesCap = overrides.edgeLines ?? DRILL_EDGE_LINES;
  const edgeNamesCap = overrides.edgeNames ?? DRILL_EDGE_NAMES;
  const contentFilesCap = overrides.contentFiles ?? DRILL_CONTENT_FILES;
  const contentCharsCap = overrides.contentChars ?? DRILL_CONTENT_CHARS;
  const contentPerFile = overrides.contentPerFile ?? DRILL_CONTENT_PER_FILE;
  const contentMaxBytes = overrides.contentMaxBytes ?? DRILL_CONTENT_MAX_BYTES;

  const shown = scoped.slice(0, limit);
  const inScope = new Set(scoped.map((file) => file.path));
  const lines = [`Project files in scope (${scoped.length}):`];
  let unparsed = 0;
  let testOnly = 0;
  let bare = 0;
  let structureChars = 0;

  for (const file of shown) {
    const header = `${file.path} (${file.language}, ${file.size}b)`;
    lines.push(header);
    structureChars += header.length;
    if (!file.parsed) {
      unparsed += 1;
      continue;
    }
    if (isTestPath(file.path)) {
      testOnly += 1;
      continue;
    }
    if (structureChars > structureBudget) {
      bare += 1;
      continue;
    }
    const symbols = listFileSymbols(db, projectId, file.path);
    if (symbols.length === 0) continue;
    const visible = symbols.slice(0, symbolsPerFile);
    const exported = visible
      .filter((entry) => entry.exported)
      .map((entry) => `${entry.name} (${entry.kind})`);
    const internal = visible
      .filter((entry) => !entry.exported)
      .map((entry) => `${entry.name} (${entry.kind})`);
    if (exported.length > 0) {
      const line = `  exports: ${exported.join(", ")}`;
      lines.push(line);
      structureChars += line.length;
    }
    const hidden = symbols.length - visible.length;
    const more = hidden > 0 ? `[+${hidden} more]` : "";
    if (internal.length > 0 || more) {
      const line =
        `  ${internal.length > 0 ? `internal: ${internal.join(", ")}` : ""}${internal.length > 0 && more ? " " : ""}${more}`.trimEnd();
      lines.push(line);
      structureChars += line.length;
    }
  }

  const edgeLines: string[] = [];
  let edgeTotal = 0;
  let unresolved = 0;
  for (const file of shown) {
    for (const edge of listFileImports(db, projectId, file.path)) {
      if (edge.toFile !== null && edge.resolved) {
        if (!inScope.has(edge.toFile)) continue;
        edgeTotal += 1;
        if (edgeLines.length < edgeLinesCap) edgeLines.push(formatEdge(edge, edgeNamesCap));
        continue;
      }
      // External deps are out of scope, not a gap; only a missing target is.
      if (edge.externalModule !== null) continue;
      unresolved += 1;
    }
  }
  if (edgeLines.length > 0) {
    lines.push(`In-scope imports (${edgeTotal}):`, ...edgeLines);
  }

  const contents: string[] = [];
  let contentChars = 0;
  let contentFiles = 0;
  let contentSkipped = 0;
  let unreadable = 0;
  for (const file of shown) {
    if (!CONTENT_LANGUAGES.has(file.language)) continue;
    if (isTestPath(file.path)) continue;
    if (file.size > contentMaxBytes) continue;
    if (contentFiles >= contentFilesCap || contentChars >= contentCharsCap) {
      contentSkipped += 1;
      continue;
    }
    const absolute = resolve(root, file.path);
    if (absolute !== root && relative(root, absolute).startsWith("..")) {
      unreadable += 1;
      continue;
    }
    let text: string;
    try {
      text = readFile(absolute);
    } catch {
      unreadable += 1;
      continue;
    }
    if (text.includes("\0")) {
      unreadable += 1;
      continue;
    }
    const excerpt = text.slice(0, Math.min(contentPerFile, contentCharsCap - contentChars));
    contentChars += excerpt.length;
    contentFiles += 1;
    contents.push(`--- ${file.path}\n${excerpt}`);
  }
  if (contents.length > 0) {
    lines.push("File contents:", ...contents);
  }

  const notes: string[] = [];
  if (unparsed > 0) notes.push(`${plural(unparsed, "file", "files")} unparsed (names only)`);
  if (testOnly > 0) notes.push(`${plural(testOnly, "test file", "test files")} shown by name only`);
  if (bare > 0) notes.push(`symbol detail capped (${plural(bare, "file", "files")} shown bare)`);
  if (unresolved > 0) notes.push(`${plural(unresolved, "import", "imports")} unresolvable`);
  if (edgeTotal > edgeLines.length) notes.push(`imports capped at ${edgeLinesCap} of ${edgeTotal}`);
  if (unreadable > 0) notes.push(`${plural(unreadable, "file", "files")} unreadable, skipped`);
  if (contentSkipped > 0)
    notes.push(`contents capped (${plural(contentSkipped, "file", "files")} omitted)`);
  const beyond = scoped.length - shown.length;
  if (beyond > 0) notes.push(`… and ${plural(beyond, "file", "files")} beyond the list cap`);
  if (notes.length > 0) lines.push(`Notes: ${notes.join("; ")}.`);
  return lines.join("\n");
}
