import { z } from "zod";

// Project code index (central substrate, code half). The index is derived and
// rebuildable: inventory + parse the working tree, persist rows, re-derive on
// demand. It stores structure only (paths, symbols, import edges) — never
// file bodies — so there is no raw-source surface to redact.

export const CodeLanguageSchema = z.enum([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "other",
]);
export type CodeLanguage = z.infer<typeof CodeLanguageSchema>;

export const SymbolIdSchema = z.string().regex(/^sym_[0-9a-f]{16}$/);
export type SymbolId = z.infer<typeof SymbolIdSchema>;

export const CodeSymbolKindSchema = z.enum([
  "function",
  "class",
  "interface",
  "type",
  "const",
  "enum",
]);
export type CodeSymbolKind = z.infer<typeof CodeSymbolKindSchema>;

export const CodeFileSchema = z.object({
  path: z.string().min(1),
  language: CodeLanguageSchema,
  size: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  parsed: z.boolean(),
  symbolCount: z.number().int().nonnegative(),
  importCount: z.number().int().nonnegative(),
});
export type CodeFile = z.infer<typeof CodeFileSchema>;

export const CodeSymbolSchema = z.object({
  id: SymbolIdSchema,
  file: z.string().min(1),
  name: z.string().min(1),
  kind: CodeSymbolKindSchema,
  exported: z.boolean(),
  line: z.number().int().positive(),
});
export type CodeSymbol = z.infer<typeof CodeSymbolSchema>;

export const CodeEdgeKindSchema = z.enum(["imports", "reexports", "dynamic"]);
export type CodeEdgeKind = z.infer<typeof CodeEdgeKindSchema>;

export const CodeEdgeSchema = z.object({
  fromFile: z.string().min(1),
  // Null when the target is an external module (bare import) or unresolvable.
  toFile: z.string().min(1).nullable(),
  externalModule: z.string().min(1).nullable(),
  kind: CodeEdgeKindSchema,
  // Named bindings carried by the edge (empty for side-effect imports).
  names: z.array(z.string().min(1)),
  // True when the target is identified (repo file or external package).
  // False records an edge with an unknown target (dynamic non-literal,
  // unresolvable relative) — never a fabricated target.
  resolved: z.boolean(),
});
export type CodeEdge = z.infer<typeof CodeEdgeSchema>;

export const CodeIndexStateSchema = z.object({
  projectId: z.string().min(1),
  filesHash: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  symbolCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  stackJson: z.string().min(1),
  indexedAt: z.string().min(1),
  parser: z.string().min(1),
});
export type CodeIndexState = z.infer<typeof CodeIndexStateSchema>;

export const CodeFilesResponseSchema = z.object({
  projectId: z.string().min(1),
  files: z.array(CodeFileSchema),
  truncated: z.boolean(),
});
export type CodeFilesResponse = z.infer<typeof CodeFilesResponseSchema>;

export const CodeSymbolsResponseSchema = z.object({
  projectId: z.string().min(1),
  query: z.string(),
  symbols: z.array(CodeSymbolSchema),
  truncated: z.boolean(),
});
export type CodeSymbolsResponse = z.infer<typeof CodeSymbolsResponseSchema>;

export const CodeFileDetailSchema = z.object({
  projectId: z.string().min(1),
  file: CodeFileSchema,
  symbols: z.array(CodeSymbolSchema),
  imports: z.array(CodeEdgeSchema),
  importedBy: z.array(CodeEdgeSchema),
});
export type CodeFileDetail = z.infer<typeof CodeFileDetailSchema>;

export const CodeGraphResponseSchema = z.object({
  projectId: z.string().min(1),
  root: z.string().min(1),
  depth: z.number().int().nonnegative(),
  files: z.array(z.string().min(1)),
  edges: z.array(CodeEdgeSchema),
  truncated: z.boolean(),
});
export type CodeGraphResponse = z.infer<typeof CodeGraphResponseSchema>;
