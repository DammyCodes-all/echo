# ADR 0013: Central project code index (oxc parser, FTS now, vectors later)

Status: Accepted, 2026-10-29

## Context

The product is moving from a session story surface toward a learning layer
over the project: overview, agent activity, changes, learn, architecture,
knowledge. Every one of those sections needs the same two halves — what the
code is and what the agent did — and the user explicitly wants one central
store every feature queries, not a different pipeline per section.

The session half exists (tape + shadow Git + SQLite index). The code half
does not: `packages/graph` is an empty stub, and ARCHITECTURE §4 prescribes
ts-morph for the import graph. Two facts force a re-decision:

1. The workspace runs `typescript@^7` (native port), which ships no
   programmatic API; the classic API path is a side-by-side TS 6 install.
2. ts-morph works only by bundling its own TS 6 (~12 MB, second compiler),
   with native-port migration still open upstream.

Evidence: `docs/spikes/2026-10-29-code-index-tooling.md` (primary sources).

## Decision

a. One derived, rebuildable project code index in SQLite (`code_files`,
   `code_symbols`, `code_edges`, `code_index_state`, migration v7), holding
   structure only — paths, symbol names/kinds/lines, import edges — never
   file bodies. All sections (overview rollup, trace, architecture map,
   code-aware retrieval) query these tables; nothing builds a second index.
b. Parser is oxc-parser (NAPI, prebuilt binaries, MIT): ESM module records
   for imports/exports plus one shallow AST walk for top-level symbols and
   `require()` calls. Contained behind `packages/graph/src/parser.ts` so the
   0.x version risk is wrapped at three call sites.
c. Symbol IDs are deterministic (`sym_` + sha of project/path/name/kind/line);
   edges carry `resolved` provenance (dynamic/unresolvable recorded, not
   proven), matching the observed-vs-inferred rule the architecture view needs.
d. Search now is SQLite (indexed prefix queries; persistent FTS5 over the
   structural index next). Vectors (sqlite-vec + local embeddings) are
   deferred until an eval set of "find code about X" queries shows where
   FTS+structure fails. Trigger, not schedule.
e. ts-morph stays the fallback if type-aware resolution is ever needed;
   revisit after TS 7.1 stable and ts-morph's native-port migration land.
   tree-sitter only if non-TS languages get indexed. hnswlib-wasm rejected
   (stale, browser-shaped).

## Consequences

- ARCHITECTURE §4's `ts-morph` row and §12's `centrality` tiebreak source
  now resolve to this index (centrality still unwired; the edge table feeds
  it when wanted).
- Reindexing is whole-project replace (`replaceProjectCodeIndex`) keyed by a
  `files_hash` manifest comparison; per-file incrementality is a later
  optimization, not a correctness requirement.
- The session half (tape/snapshots) is untouched; joining agent touches to
  code nodes (which step touched which symbol) is the next unit, not this one.
