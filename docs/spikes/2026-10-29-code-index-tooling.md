# Code index tooling: parser + local search

Date: 2026-10-29. Status: spike (research only, no code).
Scope: import graph + symbols + tech-stack detection, and local "find code about X" search, for this repo (Node 24, pnpm, `typescript@^7.0.2`, `better-sqlite3@^12.4.1` + Drizzle, FTS5 already used for tape search, no telemetry/cloud, Linux/macOS).
Rule: every factual claim below links its primary source. Judgments are marked (assessment).

## 0. What `typescript@^7` means for compiler-API consumers

This is the binding constraint on every option.

- TypeScript 7.0 is a native Go port ("Corsa") shipping a `tsc` binary with 8–12x full-build speedups, and it ["does not ship with an API"](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/). A "new (and different) API" is expected in 7.1; until then the documented path for programmatic consumers is running TypeScript 6 side-by-side via the `@typescript/typescript6` compat package (`tsc6` binary, re-exports the 6.0 API, npm-alias install) ([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)).
- Tools that embed the compiler (typescript-eslint, Volar/Vue/MDX/Astro/Svelte, Angular templates) must stay on 6.0 until the API lands ([same](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)).
- TypeScript 7.1 Beta (Oct 20, 2026) ships the new API as several entry points (`typescript/sync`, `typescript/async`, `typescript/fs`, `typescript/ast`, `typescript/ast/is`) — new and different, not the old `typescript` module surface ([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)). Still beta at spike time.

Implication: any in-process use of the *classic* compiler API in this repo means adding a JS-based TypeScript 6 alongside the workspace TS 7 (assessment: fine as an isolated dependency, but it is a second compiler to carry).

## 1. Parser comparison

### (a) TS 7 interaction — does it work with the native port or pin its own TS?

| Option | TS-version story |
|---|---|
| ts-morph 28.0.0 | Pins its own: no `peerDependencies`, and [`@ts-morph/common` ships `dist/typescript.js`](https://registry.npmjs.org/@ts-morph/common/latest) (12 MB dist, verified in tarball) built against [`typescript: ~6.0.2`](https://raw.githubusercontent.com/dsherret/ts-morph/latest/packages/ts-morph/package.json). Workspace TS 7 is irrelevant to it. Native-port migration is tracked in [issue #1621](https://github.com/dsherret/ts-morph/issues/1621) (open; maintainer [reported "significant progress" and a coming PR on Jul 26, 2026](https://github.com/dsherret/ts-morph/issues/1621#issuecomment-5085137011)); the TS team [calls breaking ts-morph an explicit anti-goal](https://github.com/microsoft/typescript-go/discussions/455#discussioncomment-12492538) (quoted in the issue). |
| `typescript` API directly | No API exists in 7.0 ([§0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)). Direct use today = add `@typescript/typescript6` side-by-side ([same](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)); the 7.1 replacement API is beta and different ([same](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)). |
| oxc-parser 0.156.0 | Independent of TS entirely: Rust parser via NAPI ([npm: "Oxc Parser Node API"](https://registry.npmjs.org/oxc-parser/latest)). No TS install involved. |
| tree-sitter-typescript 0.23.2 | Independent of TS: C grammar + Node bindings ([README](https://raw.githubusercontent.com/tree-sitter/tree-sitter-typescript/master/README.md)). |

### (b) Accuracy for ESM/CJS import graphs and exported symbols

- ts-morph: full-fidelity by construction — it is a "[TypeScript Compiler API wrapper for static analysis and programmatic code changes](https://github.com/dsherret/ts-morph)" over its bundled TS 6, so module resolution, re-export chains, and aliased symbols resolve the way `tsc` sees them (assessment).
- `typescript` API directly: same fidelity as ts-morph (same compiler), with hand-written binder/checker traversal instead of ts-morph's facade (assessment).
- oxc-parser: returns the ESM module record directly — `ParseResult.module: EcmaScriptModule` with `staticImports`/`staticExports`/`dynamicImports` and spans — "no need to walk the AST" for import/export rewriting ([d.ts in package](https://registry.npmjs.org/oxc-parser/latest), [docs](https://oxc.rs/docs/guide/usage/parser)). `sourceType` accepts `script | module | commonjs | unambiguous` ([d.ts](https://registry.npmjs.org/oxc-parser/latest)). No module *resolution* or type-aware symbol binding: `require()` calls, re-export targets, and CJS/ESM interop need an AST walk over the returned ESTree/TS-ESTree tree (assessment; AST shape per [README](https://registry.npmjs.org/oxc-parser/latest)). `showSemanticErrors` builds symbols/scopes at "a small performance overhead", default off ([d.ts](https://registry.npmjs.org/oxc-parser/latest)).
- tree-sitter: untyped concrete syntax tree; imports/exports/symbols come from pattern queries over CST nodes, with no binding info, so aliased and re-exported symbols cannot be resolved to definitions (assessment; it is a [parser generator + incremental parsing library](https://tree-sitter.github.io/tree-sitter/), not a binder). Two separate grammars (`typescript`, `tsx`) ([README](https://raw.githubusercontent.com/tree-sitter/tree-sitter-typescript/master/README.md)); JS files need a third grammar package (assessment).

### (c) Speed on ~100–500 file repos

- oxc: ["at least 3x faster than swc and 5x faster than Biome"](https://github.com/oxc-project/bench-javascript-parser-written-in-rust) (primary benchmark code + numbers: `cal.com.tsx` 4.0 ms, `typescript.js` 30.3 ms on M2). Assessment: a 500-file repo parses in seconds single-threaded; parse cost is negligible next to I/O and indexing.
- tree-sitter: designed to be "[f]ast enough to parse on every keystroke" and to re-parse incrementally on edit ([docs](https://tree-sitter.github.io/tree-sitter/)). Assessment: same negligible class as oxc for batch indexing; its edge is incremental re-parse of edited files.
- ts-morph / TS API: pays for full program creation and (if used) type-checking. Assessment: slowest of the four, but still not a blocker at 100–500 files — the cost is process weight and complexity, not wall-clock failure.

### (d) Node API ergonomics

- ts-morph: highest-level (`Project`, `SourceFile`, typed wrappers) per its wrapper tagline ([repo](https://github.com/dsherret/ts-morph)); zero setup beyond `npm install` since TS is bundled (assessment).
- `typescript` API: lowest-level — manual `Program`/`Checker`/visitor code against the TS 6 surface, plus the side-by-side install dance (assessment, install per [§0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)).
- oxc-parser: `parseSync(filename, sourceText, options?)` / async `parse()` returning `{ program, module, comments, errors }`, plus an exported `Visitor`, `visitorKeys` for any ESTree walker, and AST types in `@oxc-project/types` 0.156.0 ([d.ts + README in package](https://registry.npmjs.org/oxc-parser/latest), [types](https://registry.npmjs.org/@oxc-project/types/latest)). Prebuilt NAPI binaries for linux/darwin x64+arm64 (and musl/Windows/WASM) ([registry `napi.targets`](https://registry.npmjs.org/oxc-parser/latest)); `engines: node ^20.19 || >=22.12`, so Node 24 is covered ([same](https://registry.npmjs.org/oxc-parser/latest)). No build step on install (assessment: nothing to add to `allowBuilds`).
- tree-sitter: official [`tree-sitter` 0.25.1 Node bindings](https://registry.npmjs.org/tree-sitter/latest) from [node-tree-sitter](https://github.com/tree-sitter/node-tree-sitter) (`new Parser()`, `setLanguage(grammar)`, `parse(source)`); grammar packages install separately, and `tree-sitter-typescript` compiles at install via `"install": "node-gyp-build"` ([package.json](https://registry.npmjs.org/tree-sitter-typescript/latest)) — that needs a toolchain and a pnpm build approval (repo gotcha). WASM alternative `web-tree-sitter` 0.27.1 exists ([registry](https://registry.npmjs.org/web-tree-sitter/latest)).

### (e) License

- ts-morph: MIT ([package.json](https://raw.githubusercontent.com/dsherret/ts-morph/latest/packages/ts-morph/package.json)); bundled TypeScript is [Apache-2.0](https://raw.githubusercontent.com/microsoft/TypeScript/main/LICENSE.txt).
- `typescript` API via TS 6: [Apache-2.0](https://raw.githubusercontent.com/microsoft/TypeScript/main/LICENSE.txt).
- oxc-parser: MIT ([registry](https://registry.npmjs.org/oxc-parser/latest)); `@oxc-project/types`: MIT ([registry](https://registry.npmjs.org/@oxc-project/types/latest)).
- tree-sitter core, `tree-sitter-typescript`, `web-tree-sitter`: all MIT ([registry](https://registry.npmjs.org/tree-sitter/latest), [registry](https://registry.npmjs.org/tree-sitter-typescript/latest), [registry](https://registry.npmjs.org/web-tree-sitter/latest)).

No license conflicts anywhere (assessment: all four are permissive and already compatible with a MIT/Apache-style repo).

## 2. Local search

### sqlite-vec — yes, it loads under better-sqlite3 v12

- `sqlite-vec` 0.1.9 ([registry](https://registry.npmjs.org/sqlite-vec/latest); docs track 0.1.10-alpha.4) is "[a] vector search SQLite extension" in pure C with no dependencies, successor to sqlite-vss ([README](https://raw.githubusercontent.com/asg017/sqlite-vec/main/README.md)): `vec0` virtual tables, float/int8/binary vectors, metadata/auxiliary/partition-key columns ([same](https://raw.githubusercontent.com/asg017/sqlite-vec/main/README.md)). KNN is `WHERE embedding MATCH :query AND k = N`, returning a `distance` column, L2 default with cosine available ([KNN docs](https://alexgarcia.xyz/sqlite-vec/features/knn.html)).
- Node usage is `sqliteVec.load(db)`, documented as compatible with better-sqlite3 ([JS docs](https://alexgarcia.xyz/sqlite-vec/js.html)). The loader source is three lines: `load(db) { db.loadExtension(getLoadablePath()); }`, resolving a prebuilt `vec0.{so,dylib,dll}` from a platform package ([`index.mjs` in the tarball](https://registry.npmjs.org/sqlite-vec/latest)). Platform packages cover linux/darwin x64+arm64 and Windows x64, contain no install scripts ([registry](https://registry.npmjs.org/sqlite-vec-linux-x64/latest)) — no `allowBuilds` entry needed (assessment).
- better-sqlite3 **v12.4.1** (exactly what `@echo/db` pins) documents [`.loadExtension(path, [entryPoint])`](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v12.4.1/docs/api.md) and declares `engines: 20.x || 22.x || 23.x || 24.x` ([package.json at tag](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v12.4.1/package.json)). So: `new Database()` → `sqliteVec.load(db)` → `SELECT vec_version()` works on this stack (assessment from the two sources above).
- Caveats: pre-v1 with ["expect breaking changes"](https://raw.githubusercontent.com/asg017/sqlite-vec/main/README.md); license is dual MIT/Apache-2.0 ([site footer](https://alexgarcia.xyz/sqlite-vec/guides/performance.html), npm `MIT OR Apache`). Vectors also need an embedding model — the extension stores and searches vectors, it does not embed text (assessment).

### hnswlib-wasm — reject

- 0.8.2, Apache-2.0, last published 2023-07-08 ([registry metadata](https://registry.npmjs.org/hnswlib-wasm)): stale 3+ years. A WASM port of hnswlib (HNSW approximate nearest-neighbor) "being built for a use case that requires running hnswlib in the browser", with persistence via the Emscripten virtual FS / IDBFS ([README](https://raw.githubusercontent.com/ShravanSunder/hnswlib-wasm/main/README.md)). Assessment: wrong shape — browser-oriented persistence outside SQLite/Drizzle, unmaintained, and redundant with sqlite-vec.

### FTS5-only — the baseline, already in the repo

- `packages/retrieval/src/fts.ts` already builds an ephemeral per-bundle FTS5 index (`tokenize='porter unicode61'`, prefix queries). FTS5 itself offers phrase/prefix/NEAR/boolean/column-filter query syntax, porter + trigram tokenizers, `bm25()`/`snippet()`/`highlight()` ranking helpers, and external-content tables for indexing without duplicating text ([sqlite.org](https://www.sqlite.org/fts5.html)).
- Assessment: FTS5 answers identifier/keyword queries ("where is `openFts` used") with zero new dependencies. It misses paraphrase queries ("find code about retry backoff" when the code says `withBackoff`) — that gap is what a structural index narrows (symbols/imports as literal index terms) and only embeddings fully close.

## 3. What coding agents typically combine

One paragraph: Continue's `@Codebase` retrieval is "a combination of embeddings-based retrieval and keyword search", with "all embeddings ... calculated locally using `transformers.js` and stored locally" — explicitly aimed at "high-level questions about your codebase" like "is there any code written already to convert HTML to markdown?" ([Continue docs](https://docs.continue.dev/reference/deprecated-codebase)); complementing that, Aider's repo map is a "concise map of your whole git repository" of the most important classes/functions with signatures, ranked by a graph algorithm over the file-dependency graph into a token budget ([Aider docs](https://aider.chat/docs/repomap.html)). Assessment: the standard shape is structural map (what exists, what references what) + keyword/BM25 retrieval + embedding retrieval, fused at query time — no mainstream agent relies on vectors alone.

## Recommendation

- **Parser: oxc-parser.** MIT, prebuilt NAPI binaries for our exact targets, Node 24 in engines, zero interaction with the TS 7 API mess, ESM import/export records without an AST walk, and a standard ESTree/TS-ESTree tree plus visitor for symbols and tech-stack signals (`package.json` deps + import specifiers, not parser magic). The 0.x version is the main risk; contain it by wrapping the three calls we need (`parseSync`, module record, one symbol walk) behind our own module.
- **Search now: persistent FTS5 over the structural index.** Promote the existing `fts.ts` approach from ephemeral-per-bundle to a persistent table indexed over file paths + symbol names + signatures + doc comments + import specifiers, ranked with `bm25()`. No new dependency, fits Drizzle/SQLite, directly answers identifier and keyword queries.
- **Defer: vectors.** Add sqlite-vec (`sqliteVec.load(db)` under our pinned better-sqlite3 v12.4.1) plus a local embedding model (transformers.js is the Continue-cited default) only after a small eval set of "find code about X" queries shows where FTS5+structure fails. Trigger, not schedule.
- **Defer/reject the rest:** ts-morph stays the fallback if we later need type-aware resolution (it works today via bundled TS 6; revisit after TS 7.1 stable + its #1621 migration lands). tree-sitter only if we index non-TS languages. TS 7.1's new API is beta — do not build on it. hnswlib-wasm is rejected (stale, browser-shaped).
