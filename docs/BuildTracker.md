# BuildTracker

Append-only record of what is built. Read before starting work. One entry
per finished unit, written after the gate passes. Never edit or delete
another entry — regressions get a new entry.

Entry fields: item, status (`done` | `partial` | `blocked`), evidence,
notes.

## 2026-10-28 — Sandbox execution ladder (docker, bwrap, WASM)

- item: Phase 0 sandbox backends + Phase 5 sandbox runner
- status: done
- evidence: `pnpm exec vitest run packages/sandbox` → 28 passed; full gate green (typecheck, lint, 122 tests, build)
- notes: Ladder docker → bwrap → wasm, fresh isolation per run, memoized detection. WASM memory cap is best-effort; only large single allocations trip it. WASM snippets must avoid top-level await.

## 2026-10-28 — Sandbox review fixes

- item: firstLine null guard, WASM console parity, remove stale engine hint
- status: done
- evidence: `pnpm exec vitest run packages/sandbox` → 28 passed; `tsc`, `biome` clean
- notes: `warn`/`debug` → stderr, `info` → stdout, matching Node. Probe can no longer throw on null stdout.

## 2026-10-28 — Model client + structured-output probe

- item: Phase 0 model spike, remainder (structured output)
- status: done
- evidence: `pnpm exec vitest run packages/model` → 6 passed; live probe schema adhered, ~7.7 s, 39 prompt / 586 completion tokens (564 reasoning)
- notes: `packages/model` client with injected fetch, caller-supplied parser, one retry on larger budget for length-with-null-content. Default maxTokens 2048 is a floor. Details in `docs/spikes/2026-10-28-model-smoke.md`.

## 2026-10-28 — Fixture tape pack

- item: ARCHITECTURE §22 fixture sequence (synthetic)
- status: done
- evidence: `pnpm exec vitest run packages/fixtures` → 3 passed
- notes: Covers failed tool, reverted edit, shell write, interrupted tool, rapid edit/revert, synthetic secret (`FIXTURE_SYNTHETIC_SECRET`, kept raw for the gate to strip), binary + `.env` skips as diagnostics, subagent session. Full fixture→gate proof belongs in eval/ once wired.

## 2026-10-28 — Checks prototype (targeting, gate, grading)

- item: Phase 5 checks prototype
- status: done
- evidence: `pnpm exec vitest run packages/checks` → 6 passed (wasm runner)
- notes: Static risk ranking, top-N selection, reference-must-pass-twice gate, exact-match grading (no partial credit). Question drafting via model is still open.

## 2026-10-28 — Review UI: scrub + engagement tracking

- item: Phase 3 review UI remainder (timeline scrub, hunk engagement)
- status: done
- evidence: `tsc`, `biome` clean (UI exempt from vitest until Playwright phase)
- notes: Timeline click scrubs file-state to that moment; hunk opens tracked in localStorage, shown as badges, feeds check targeting. Attempt tree is Phase 6 / cut line — not started.

## 2026-10-28 — Pre-existing implementations (verified, not rebuilt today)

- item: redaction gate, tape writer/reader, shadow snapshots, hook ingest, spool handling, web shell
- status: done
- evidence: full suite `pnpm test` → 122 passed
- notes: Landed in earlier commits (redaction, tape, snapshots, capture-muse spool/hook, Dusk web shell). Verified via the passing suite; not re-implemented.

## 2026-10-28 — Model API access + CLI binary name

- item: Phase 0 API credits; CLI binary name decision
- status: done
- evidence: live 200 probe against `api.meta.ai`; `command -v echo-cli` → no clash
- notes: Key in gitignored `.env.local`, credits confirmed by user. Binary name: `echo-cli` (already wired, avoids the `echo` builtin).

## 2026-10-28 — Muse-native capture inputs

- item: session logs, hook payloads, export, show_reasoning
- status: blocked
- evidence: none yet — inputs not in hand
- notes: Blocks spec item 2 and everything downstream of real capture (export reconciliation, demo tape). Synthetic fixtures stand in until it lands.

## 2026-10-27 — Merge origin/main (second divergence)

- item: merge remote model/sandbox/checks/fixtures work into local capture-muse ingest
- status: done
- evidence: `git merge origin/main` → clean, no conflicts; full gate green (typecheck, biome 129 files, `pnpm test` → 23 files / 120 passed + 8 skipped, build)
- notes: Fast-forward-free ort merge, auto-committed as 55ecf62. Local map.ts resolution from prior merge survived byte-identical. 8 skipped tests are pre-existing skips, not from this merge.

## 2026-10-27 — Muse capture correctness fixes (Slice A: gaps as data)

- item: encrypted-content stripping in buildTapeEvent; capture.gap events for non-marker-adjacent sequence jumps; capture.gap for referenced-but-missing child logs (with subagent linkage); finalize diagnostics surfaced via daemon log
- status: done
- evidence: full gate green — `tsc --noEmit` clean, `biome check` clean, `pnpm test` → 23 files / 126 passed + 8 skipped, `pnpm build` clean. New tests: map strip keeps readable text + flags removal (incl. no-false-positive control); finalize gap shape/determinism/marker-adjacency/missing-child (present + absent child); ingest E2E writes one missing_child gap and none for the present child.
- notes: Strip runs before redact and tags `encrypted_content_removed`; fixed a bypass where redactJson ran on the raw input. Gap recordKeys are deterministic (`muse:<sid>:gap:<stream>:<from>-<to>`, `muse:<sid>:gap:missing-child:<id>`) so re-finalization dedupes. Deliberately no contracts change: gap codes stay plain strings consistent with existing muse diagnostics (`unknown_payload_type`, `truncated_tail`); `CaptureGapCode` untouched. childContents is now `{id, content}[]` end to end. Truncated tails remain diagnostics-only (transient by nature). Diagnostics log fires only on changed logs, so no per-poll spam.

## 2026-10-28 — Ownership checks replace puzzle checks

- item: ADR 0010; checks package kinds; spec §3/§7, plan, ARCHITECTURE §check-design
- status: done
- evidence: `pnpm exec vitest run packages/checks` → 9 passed; `tsc`, `biome` clean
- notes: Both puzzle kinds cut with no warm-up round — models answer them unsupervised, so they prove no ownership (new age, new bar). Five kinds ramp consequence → decision → tradeoff → blast_radius → teach_back. Exact grading for runnable only; rubric kinds grade against a rubric, never exact-matched. Attempt tree promoted to primary question source.

## 2026-10-27 — Merge origin/main (third divergence)

- item: merge remote ownership-checks/spec work into local capture correctness fixes
- status: done
- evidence: one conflict (`docs/BuildTracker.md`, adjacent appends) resolved by keeping both entries; full gate green (typecheck, biome 129 files, `pnpm test` → 23 files / 129 passed + 8 skipped, build)
- notes: Append-only rule held — no entry edited or deleted. Merge still open (uncommitted) pending your review.

## 2026-10-28 — Slice C: Muse snapshot triggers (baseline / tool.pre / tool.post / batch.post / final)

- item: `apps/server/src/muse-snapshots.ts` + wiring in `muse-ingest.ts`
- status: done
- evidence: `pnpm exec vitest run apps/server/src/muse-snapshots.test.ts apps/server/src/muse-ingest.test.ts` → 18 passed; `tsc` clean; biome clean on all 7 touched/new Slice C files
- notes: Baseline exactly once per session (latestSnapshot dedupe, spool and native-log paths); tool.pre only for mutating tools with 500ms budget (timeout keeps last snapshot + `stale_pre_state` gap); tool.post fires on completed and failed; one snapshot per batch boundary; final only after session.ended + quiescence, before export. Deterministic recordKeys (`muse:<sid>:snapshot:<trigger>:<key>`) dedupe re-polls. Snapshotter failure → capture.gap, no fabricated state. Existing muse-ingest counts updated +1 for the baseline event. fs.change watcher and reconcile trigger left out per slice scope. No contracts change.

## 2026-10-28 — Slice C: `echo-cli hooks install` installer

- item: `apps/cli/src/hooks-install.ts` + `hooks install` subcommand
- status: done
- evidence: `pnpm exec vitest run apps/cli/src/hooks-install.test.ts` → 4 passed; live `tsx` run installs 19 events, re-run byte-identical, malformed JSON refused with exit 1
- notes: Settings path defaults to `~/.muse/settings.json`, overridable via `ECHO_MUSE_SETTINGS_PATH` (bin via `ECHO_CLI_BIN`); refuses on unparseable JSON; single 0600 backup reused afterwards; all 19 `MUSE_HOOK_EVENTS` ensured with absolute quoted bin path, stale Echo entries replaced, unrelated hooks and ordering preserved. Never-block receiver untouched. Note: the built CLI bundle currently crashes at startup (`Dynamic require of "buffer"` via isomorphic-git) because the in-flight capture-muse `import.ts` barrel export pulls `@echo/snapshots` into the CLI bundle; pre-existing sources verified via `tsx`, bundle fix belongs to that slice.

## 2026-10-28 — Slice C review fixes (late pre-snapshot, poll budget, installer preservation)

- item: reconcile late tool.pre arrivals; per-poll trigger budget; preserve tuned installer entries and settings permissions
- status: done
- evidence: `pnpm exec vitest run apps/server/src/muse-snapshots.test.ts apps/server/src/muse-ingest.test.ts apps/cli/src/hooks-install.test.ts apps/cli/src/hook.test.ts` → 33 passed; `tsc` clean; biome clean on all 7 Slice C files; live `tsx` check confirms tuned timeout preserved and settings perms untouched
- notes: A tool.pre that outruns its 500ms budget still lands its commit, so the timeout path now records the late snapshot idempotently instead of leaving a ref without tape/DB rows. Hook triggers share `MAX_TRIGGER_SNAPSHOTS_PER_POLL` (20) per poll with `snapshot_budget_exhausted` gaps beyond it; baselines/finals exempt (both self-heal). Installer no longer rewrites same-bin entries with hand-tuned fields, carries extra handler keys off replaced stale entries, and no longer chmods the user's settings file (0600 stays backup-only). Verified the concurrent `hookOnly` finalize path still yields `degraded`, matching prior hook-only behavior — no change needed there.

## 2026-10-28 — eval/muse-fixture capture-integrity harness + spec §9 mapping

- item: `eval/muse-fixture/` harness (BUILD-PLAN §6 home): synthetic repo + fake sessions tree + hook payloads + stub export → ingest + snapshotter → assertions + `result.json` + `report.md`
- status: done
- evidence: `pnpm exec vitest run eval/muse-fixture` → 1 passed; sample: 34 tape events, 7 snapshots, 9 snapshot files, 12 drained hooks; quality `partial` persisted by ingest identical to a direct finalizeMuseSession call; reconciled `{added: 1, merged: 1, conflicts: 0, schema: 1}`; raw-secret scan over tape, shadow blobs, spool, SQLite, logs, demo bundle: 0 findings
- notes: Covers all 10 ARCH §22 items: file read, successful edit, failed tool, reverted edit (intermediate absent), shell write (notes/out.txt, no editor event), interrupted tool (failed recorded, completion never fabricated), rapid edit/revert (intermediate unobserved by design, listed missed-state), synthetic secret (zero raw occurrences outside input dir), binary + ignored .env + oversized (captured:false with reasons), subagent lane + missing_child gap; plus sequence-jump gap, marker-adjacent compaction without gap, torn tail dropped with truncated_tail diagnostic, encrypted_content stripped with removal recorded, export recovery as agent.unknown. result.json + report.md cover only capture integrity (sample size, caveats, commit hash); citation/refusal/check-pass-rate/hunk/attempt measures explicitly not implemented — they need real tapes and stay manual. Wired into `pnpm test` via vitest include; `result.json` excluded from biome (generated artifact). Distinguishes 12/14 pass with rapid edit/revert + torn tail as known missed states.

## 2026-10-28 — capture.reconciled conflicts count

- item: conflicts field on the reconciled marker (stays 0 under key-only reconcile)
- status: done
- evidence: `pnpm exec vitest run packages/capture-muse apps/server` green incl. new key-only test; ingest assertion extended to `conflicts: 0`
- notes: `FinalizeResult.reconciled` gains `conflicts: number`, always 0 with a comment explaining why (shared key merges without content comparison; live/export never share a hash domain). `capture.reconciled` payload gains `conflicts` from the same value. No content comparison implemented, per scope. No contracts change: `CaptureGapCode` and `TapeEventKind` untouched, payload shape is free-form.

## 2026-10-28 — captureQuality choke point in finalizeMuseSession

- item: finalizeMuseSession is the single place quality is computed; ingest persists, never recomputes
- status: done
- evidence: colocated tests (hookOnly → degraded; partial snapshot report caps full → partial, never upgrades); spool-bootstrap and export-overwrite paths both route through finalizeMuseSession; full gate green (typecheck, biome 137 files, 27 files / 149 passed + 8 skipped, build)
- notes: New inputs `hookOnly` (no native log seen → degraded floor) and `snapshotReport` (partial caps full → partial, diagnostics appended). The two call sites: spool bootstrap now calls finalizeMuseSession with hookOnly instead of hardcoding "degraded"; export overwrite keeps persisting `finalized.quality`. Import path still marks `import_only` directly — the spec-mandated constant for that path, not a recomputation. No contracts change.

## 2026-10-28 — echo-cli import (import_only) + replay copy + CLI bundle externals

- item: `importMuseSession` in `@echo/capture-muse` + `echo-cli import <session-id|path>` + `GET /api/sessions/:id` + import_only replay banner
- status: done
- evidence: `packages/capture-muse/src/import.test.ts` → 4 passed (final-only snapshot, idempotent re-import, export reconcile, refusal cases); `packages/db` summary test added; full gate green
- notes: Reads the native log (+ optional redacted export, never written raw), takes exactly one final working-tree snapshot (re-import reuses the prior commit — a second snapshot would violate "one"), marks `import_only`, appends a file.snapshot with `import_only: true`. Refuses unattributable logs instead of guessing (`--project` override). Replay banner states "Imported session — final file state only. No intermediate file states are claimed." for import_only sessions. Fixes the CLI bundle startup crash my barrel export introduced (isomorphic-git dynamic require): `apps/cli/tsup.config.ts` now externalizes `isomorphic-git` + `ignore` exactly like the server, and both are declared in `apps/cli/package.json`. Needs `pnpm install` (user step) before the built CLI can boot; import logic itself is covered by vitest. Observed hazard (not mine, not touched): `apps/server` externalizes the same two packages without declaring them — it boots today only via existing node_modules links; a clean install may drop them.

## 2026-10-28 — Addendum: final gate after parallel landings + formatter touches

- item: re-verification of the four units above against the evolved tree
- status: done
- evidence: `pnpm typecheck` clean; `pnpm lint` clean (138 files); `pnpm test` → 27 files / 155 passed + 8 skipped; `pnpm build` exit 0; targeted re-run (eval harness, capture-muse, muse-ingest, db) → 10 files / 61 passed; built-CLI boot + `import` e2e verified after user `pnpm install`
- notes: While this slice ran, parallel slices landed reader checkpoints (db), `MAX_PAYLOAD_BYTES` (map.ts), a `tailer.ts` module, and a muse-ingest trigger refactor — my slice's edits (hookOnly bootstrap, conflicts payload, finalize inputs, import, endpoint, UI copy, harness) all survived intact and the suite stayed green. The final numbers supersede the per-entry counts above (137→138 files, 149→155 tests; the +6 are parallel tests). Mechanical `biome check --write` only (formatter + import sorting, no semantics) was applied to in-flight parallel files to restore a green gate: hooks-install.*, muse-snapshots.ts, tailer.ts, and parallel regions of db/* and muse-ingest.ts. `pnpm install` consumed for the CLI externals fix (links verified read-only afterwards). result.json regenerated by the final suite run and matches HEAD.

## 2026-10-28 — Slice B: incremental Muse tailer with DB-checkpointed offsets

- item: migration v3 `reader_checkpoints` + `packages/capture-muse/src/tailer.ts` (pure chunk parser) + checkpoint-backed scan loop in `muse-ingest.ts`; 256KB payload bound in `buildTapeEvent`
- status: done
- evidence: full gate green — `tsc --noEmit` clean, `biome check` clean (139 files), `pnpm test` → 28 files / 174 passed + 8 skipped, `pnpm build` clean. New tests: 14 tailer unit (append chunks byte-identical to a full finalize incl. boundary gaps, cross-chunk marker adjacency both directions, marker index continuity + child-lane scoping, torn-tail hold, 8MiB skip, per-line invalid keys, session.started exactly once, nonMonotonic flag, child refs), 2 map truncation (over-cap marker + id determinism, under-cap untouched), db checkpoint round-trip + lane prune, ingest restart resume (new instance zero re-ingest, post-restart append picked up once). §22 eval harness green (torn tail dropped + `truncated_tail` kept, zero raw secret).
- notes: Checkpoint key is `(session_id, lane)` (lane `''` parent, child dir name otherwise); columns per ARCH plus `marker_count`/`session_started`/`last_event_ts` for stable keys, no duplicate `session.started`, and boundary-gap timestamps. Quiescence stays in-memory (`stable`); only resume state persists, so restarts re-establish quiescence within 2 polls. 256KB truncation lives in `buildTapeEvent` (uniform across live/import/export/hook); 8MiB line-skips become `truncation` gaps keyed by absolute offset. Chunk-leading markers inherit the persisted `last_sequence`; a persisted trailing marker explains boundary jumps; mixed-stream files may over-flag as visible gaps (never silent). RecordKeys stay byte-identical for events, `sequence_jump`, `missing-child`, and export keys (proven by test); parent marker keys match a full read, child lanes use `marker:<lane>:<N>`, invalid gaps key by absolute line offset (survives re-chunking). `truncated_tail` stays diagnostics-only and transient: excluded from the sticky quality (a mid-write poll must not stain the session partial forever; a full re-read clears it the same way), while persistent gaps keep partial sticky and degraded hook-only sessions upgrade on native arrival. Unattributed logs advance no checkpoint (offset 0), so later project-enablement still ingests full history; disabled projects hold checkpoints. Steady state is one stat + one checkpoint select per lane per poll; spool drain and exportOnce untouched (export still full-reads once per session). Deliberately deferred: `jobs`/`settings` tables. No contracts change. Shared-tree reconciliations kept, not authored: `busy_timeout` pragma + test (assertion fixed: column is `timeout`), reader classifier exports, `firstInvalidOffset` + stack-safe min in tailer (foreign test index fixed to find the gap), `getSessionSummary` dependency, one formatter-only touch to `import.ts`.

## 2026-10-28 — Review fix batch (7 findings + 2 nits)

- item: fixes for the review of all uncommitted changes (import.ts, tailer.ts, reader.ts, database.ts, hooks-install.ts, CLI, eval harness)
- status: done
- evidence: full gate green after fixes — `pnpm typecheck` clean, `pnpm lint` clean (139 files), `pnpm test` → 28 files / 174 passed + 8 skipped, `pnpm build` exit 0; CLI boots; new regression tests for every fix
- notes: (1) Import-vs-daemon SQLITE_BUSY: `PRAGMA busy_timeout = 5000` in openEchoDb, with a test asserting it (parallel slice corrected the assertion to the driver's actual `timeout` column — verified: returns 5000). (2) Harness secret scan now checkpoints WAL (`PRAGMA wal_checkpoint(TRUNCATE)`) before scanning so -wal-resident rows can't hide a leak. (3) tailChunk `Math.min` spread replaced with a loop (would throw on large catch-up chunks). (4) parse-invalid gaps keyed by the offending line's absolute byte offset via shared reader classifiers (exported pure `isRecord`/`tryParseMarker`/`tryParseEvent`), so re-chunked re-reads dedupe; existing key-shape tests unchanged, new absolute-offset test added. (5) Import re-import lookup now queries by record_key directly instead of paging the timeline (LIMIT 1000 broke idempotency at scale). (6) TailChunkResult.quality documented as a per-chunk floor signal with the finalizeMuseSession choke-point pointer for the wiring layer. (7) Stale-hook marker anchored to `" hook muse ` so user entries mentioning hooks in prose are preserved (regression test added). Nits: CLI uses `parseAsync()`; harness polls until reconciled (max 9 polls) instead of assuming 3. One harness failure seen mid-batch was parallel-edit churn (suite run racing an in-flight ingest refactor), not flakiness: deterministic re-runs pass, mechanism verified (poll-1 tails full content; torn-only polls take the combined-empty stable path without resetting quiescence). Stage and commit nothing.
