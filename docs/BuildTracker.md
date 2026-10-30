# BuildTracker

Append-only record of what is built. Read before starting work. One entry
per finished unit, written after the gate passes. Never edit or delete
another entry — regressions get a new entry.

Entry fields: item, status (`done` | `partial` | `blocked`), evidence,
notes.

## 2026-10-28 — Spec items 1–2: canonical projects + session understanding

- item: item 1 (canonical repo root + normalized remote identity, remote-aware project rows, workspace UI shows remote) and item 2 (Muse/OpenCode baseline + post-action + final shadow snapshots, deterministic hunk/attempt/evidence review index, `/api/sessions/:id/review`, replay inspector backed by positional line origins)
- status: done
- evidence: full gate green → `tsc` clean, `biome` 136 files clean, `pnpm test` → 27 files / 179 passed, `pnpm build` ok; live-server probe (temp data dir, alt port) listed real projects with normalized `remoteUrl` and joined sessions; review covered by integration tests over real shadow repos (Git diffs, not fixtures)
- notes: Review pass fixed: allowlist scoping (enabled `/repo/docs` no longer captures `/repo/sibling`), removed a dead extra baseline→final diff, changed paths now union all consecutive snapshots (fully reverted files count as attempts), reverted attempts link only to overlapping hunks (file-deletion case links deletion hunks as likely), per-path diff failures degrade to diagnostics instead of 500s, Muse baseline/tool.post/final snapshots with partial-quality on late/failed capture, one tool.post snapshot per session per poll, Windows drive-letter and file:// remote normalization, temp-path test hygiene. Tool→snapshot linkage stays path-level (no turn/batch ids persisted); review caps at 100k events silently. UI verified through build + served endpoints only — no browser interaction available here; items 3–4 untouched.

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
## 2026-10-28 — Q&A retrieval + citation validation (first slice)

- item: Phase 4 retrieval remainder — in-memory evidence bundle, pre-model refusal, citation validation
- status: done
- evidence: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → 24 files / 137 passed, 130 files lint-clean; `pnpm exec vitest run packages/retrieval` → 6 passed
- notes: Deterministic scoring (word overlap gates, kind weight ranks, tape_seq tiebreak); quotes must occur verbatim, quoteless claims stay weak. Caught and fixed during tests: kind weight alone admitted irrelevant events. SQLite FTS5 replaces the inside later without changing the answer shape. Also: AGENTS.md now lets agents run installs themselves, falling back to a user one-liner on failure.

## 2026-10-28 — Retrieval upgrades: summaries, attempt bonus, token budget

- item: Phase 4 retrieval polish — per-kind summaries, reverted-attempt bonus, best-first character budget
- status: done
- evidence: full gate green → 24 files / 140 passed, 130 files lint-clean; `pnpm exec vitest run packages/retrieval` → 9 passed
- notes: Summaries now keep exit codes, commit oids, agent-said text, gap codes. Try-first questions boost superseded writes (earliest attempt ranks first, proven on fixture). Bundle fills best-first within ~48k chars, top hit always survives. Fixed a wrong test assumption (only one fixture line mentions format). FTS5 + embeddings deliberately deferred.

## 2026-10-28 — Strip encrypted reasoning from OpenCode imports

- item: `capture-opencode/map.ts` sanitizeEvidence; live-tape verification
- status: done
- evidence: full gate green → 24 files / 142 passed; live import of `ses_e81ec7e…` → 0 live ciphertext blobs (24 keys, all `[withheld]`); retrieval probes correct (Downloads read top-hit, France refused)
- notes: Ciphertext hid in two places — reasoning parts and tool-result content embedding serialized conversations as text. Readable rationale kept as agent-stated; empty reasoning dropped; string-embedded blobs scrubbed to `[withheld]` keeping strings parseable. Live session is still growing (1158 → 1186 events across trial runs).

## 2026-10-28 — FTS5 retrieval (porter stemmer, prefix terms)

- item: Phase 4 FTS recall — `packages/retrieval/src/fts.ts`, scorer rewired, same answer shape
- status: done
- evidence: full gate green → 24 files / 154 passed (148 + 6 teammate capture-muse tests landed in a concurrent merge), 131 files lint-clean, build ok
- notes: Ephemeral per-bundle index, no migration. Caught an off-by-one in review (FTS rowids are 1-based) — stemming/prefix tests failed until fixed. Live tape: Downloads read top-hit, exec queries hit real shell events, France refused. A concurrent teammate merge left conflict markers mid-gate; resolved on their side, I changed nothing of theirs and staged/committed nothing.

## 2026-10-28 — Merge origin/main (third divergence)

- item: merge remote ingest/export reconciliation into local ownership-checks work
- status: done
- evidence: `git merge origin/main` → BuildTracker append-append conflict resolved by keeping both entries; gate green (typecheck clean, biome 129 files, `pnpm test` → 23 files / 131 passed, build)
- notes: Base cc69334, merged as 695e620. Only docs/BuildTracker.md conflicted; code sides disjoint (local checks/docs, remote muse-ingest/export/finalize/db).

## 2026-10-27 — Muse reader e2e fixes (markers, fork timestamps, session lifecycle)

- item: `capture-muse` reader/map + colocated tests; live-session verification
- status: done
- evidence: `pnpm typecheck` clean, `pnpm lint` 130 files clean, `pnpm test` → 24 files / 146 passed, `pnpm build` ok; `packages/capture-muse` → 29 passed. Live e2e over 11 parent sessions: invalid 45 → 0, big-session markers 0 → 224 with headerFrames 225 → 1, unexplained gaps 101 → 0, `capture.compaction` 0 → 1172, `session.ended` 0 → 6.
- notes: Marker check now precedes the header check (live markers carry `position`, not `sequence`); `recorded_at`-less fork/side lines parse with null timestamp, mapper falls back to `observed_at` + `missing_source_timestamp`; `session.end/resumed/fork/side` map to `session.ended/started/subagent.started/notification` instead of `agent.unknown`. One `sequence_jump` (e.g. 119→122) survives per trimmed session and is reported, not hidden.

## 2026-10-27 — Diff panel crash on uncaptured files

- item: `apps/web` diff-panel comparable guard + error ordering
- status: partial
- evidence: `@echo/web` build ok; crash-shape repro (added/deleted metadata-only file) no longer reaches `parseDiffFromFile`; user dev servers untouched and healthy (5173 → 200, 4783 `/api/health` ok); stray spawned processes reaped.
- notes: `comparable` was `captured !== false`, so undefined-side + uncaptured-side entries called `parseDiffFromFile(null, null)` and threw. Now requires one side `captured === true`, both-null returns null, and load errors render before the loading state. Full gate not re-run: `tsc` currently fails on an unrelated in-flight edit (`packages/snapshots/src/index.ts` imports non-exported `RepositoryIdentity`), untouched by this fix.

## 2026-10-28 — Merge origin/main (fourth divergence)

- item: merge remote finalize/muse-ingest reconciliation into local reader/retrieval work
- status: done
- evidence: `git merge origin/main` → conflicts in map.ts (isoFromUs signature), map.test.ts (both sides added tests), BuildTracker auto-merged; gate green (typecheck clean, biome 131 files, `pnpm test` → 24 files / 154 passed, build)
- notes: Base 695e620, merged as 88c01f8. isoFromUs resolved as exported + null-tolerant (both callers needed it); finalize widened to `number | null` / `string | null`. Kept all four new map tests (lifecycle, fork fallback, two encryption-stripping).

## 2026-10-28 — Q&A wiring (ask endpoint + panel)

- item: Phase 4 wiring — `POST /api/sessions/:id/ask` (retrieval bundle, pre-model refusal, one structured model call, server-side citation validation, in-memory content-hash cache, `ECHO_MODEL=off` fails closed), ask request/response contracts, replay ask panel with citation click-to-scrub
- status: done
- evidence: full gate green → `tsc` clean, `biome` 139 files clean, `pnpm test` → 28 files / 184 passed (+5 ask tests: 404, pre-model refusal with zero model calls, answered+cached, bad-citation refusal, model-off/keyless 503), `pnpm build` ok; live-server probe on temp data dir + alt port returned `not_found` / `invalid_request` shapes correctly
- notes: Answers are JSON, not SSE streaming (arch §17 shows a streaming POST; UI polls nothing here — single round-trip). No cost ledger or `asks`/`citations` tables yet (DB still 5 tables); no Baseten path; eval counts (20/10) not run. Citation chips scrub the timeline to the cited moment, which also covers cut-line item 5 for the ask panel.

## 2026-10-28 — `echo-cli record` wrapper

- item: `apps/cli/src/record.ts` + `record` subcommand (passthrough wrapper around interactive muse)
- status: done
- evidence: `apps/cli/src/record.test.ts` → 4 passed (arg/bin/cwd passthrough with inherited stdio, exit-code propagation, signal death mapping, spawn-failure diagnostic); live stub runs via tsx and the built bundle (`stub got: --model x hello`, exit 3 passes through; missing bin → `record failed`, exit 1); `import --bogus` still strict
- notes: `allowUnknownOption` scoped to `record` only, so muse owns all non-wrapper flags while `--muse-bin` stays parsed; `passThroughOptions` rejected (requires parent opt-in that would disturb `import` parsing — verified against commander 15). Wrapper adds no session linkage of its own: attribution stays in the hook translator via the real cwd (commented at the call site). Exit codes: child code passes through, signal death maps to 130/143 with the name on stderr. The earlier "muse ran instead of echo-cli" scare was pnpm injecting `--` into argv (dev-mode only); the built bundle path is unaffected.

## 2026-10-28 — Muse sessions-dir watcher (poll latency shortcut)

- item: `apps/server/src/muse-watch.ts` + daemon wiring (recursive `node:fs` watch → debounced early `runOnce`)
- status: done
- evidence: `apps/server/src/muse-watch.test.ts` → 4 passed (all nested dirs watched, burst coalesced to one pass under fake timers, new subdirs picked up, silence after stop); live `tsx --eval` smoke with real `fs.watch` (5 dirs, 1 coalesced fire on file write, clean stop); full gate green
- notes: Manual recursion (fs.watch is non-recursive on Linux); new date/session/child dirs picked up when the parent reports them. `runOnce` self-guards while running, so the watcher can never overlap a poll — every event also arrives via the 3s interval, so a dead watcher degrades to polling instead of losing data. Default 500ms debounce; injectable `watchFn` keeps tests deterministic. `createMuseIngest` now also returns `sessionsDir` (additive). No new dependencies.

## 2026-10-28 — Build pinning + `echo-cli doctor`

- item: migration v5 `session_build_pins` + per-ingest pins + `doctor` drift report
- status: done
- evidence: full gate green — `tsc` clean, `biome check` clean (158 files), `pnpm test` → 37 files / 238 passed + 8 skipped, `pnpm build` clean. New tests: db pin round-trip + version summary, `getMuseVersion` (trimmed output, null on exit-3/missing), doctor empty-DB + drift/clean cases, ingest pin assertion on the restart path. Live `doctor` against the real env (2 projects, `Muse Code 1.4.13`, no pins yet, zero warnings — correctly no drift claim with nothing pinned).
- notes: `getMuseVersion` treats `--version` output as opaque (trimmed, 256-char cap, never throws — format unverified, so no parsing per the ground-truth rule). Pins written on every ingested poll (live path preserves a prior export schema version; reconcile fills it in). Version fetched once per boot and cached; a mid-boot upgrade surfaces on restart alongside checkpoint re-reads. `doctor` is read-only (WAL readers don't block the daemon) and exits 0 with `warning:` lines; only an unreadable config is exit 1. Migration v4 in the same file is parallel work (projects.remote_url), not mine. `pnpm install` re-run once to link the already-declared `@echo/db` dep for the CLI tests.

- item: Phase 4 wiring — `POST /api/sessions/:id/ask` (retrieval bundle, pre-model refusal, one structured model call, server-side citation validation, in-memory content-hash cache, `ECHO_MODEL=off` fails closed), ask request/response contracts, replay ask panel with citation click-to-scrub
- status: done
- evidence: full gate green → `tsc` clean, `biome` 139 files clean, `pnpm test` → 28 files / 184 passed (+5 ask tests: 404, pre-model refusal with zero model calls, answered+cached, bad-citation refusal, model-off/keyless 503), `pnpm build` ok; live-server probe on temp data dir + alt port returned `not_found` / `invalid_request` shapes correctly
- notes: Answers are JSON, not SSE streaming (arch §17 shows a streaming POST; UI polls nothing here — single round-trip). No cost ledger or `asks`/`citations` tables yet (DB still 5 tables); no Baseten path; eval counts (20/10) not run. Citation chips scrub the timeline to the cited moment, which also covers cut-line item 5 for the ask panel.

## 2026-10-28 — Checks wiring (selection, quiz, calibration, report)

- item: Phase 5 wiring — risk + never-opened hunk selection (top 3, max 2/file, waivers), template-drafted ownership questions (consequence/decision/tradeoff/teach_back, easiest first), verification gate with real sandbox runner, model-graded rubric answers with confidence-first flow + Brier calibration, file-persisted checks/attempts artifacts, `GET/POST checks`, `POST /api/checks/:id/answer`, `GET report` endpoints, quiz UI + report UI
- status: done
- evidence: full gate green → `tsc` clean, `biome` 142 files clean, `pnpm test` → 29 files / 189 passed (+5 checks tests over real SQLite + shadow git: 404s, decision-kind generation + deterministic regen, waiver drop, correct/incorrect grading with Brier 0.0025 + overconfident flag + report counts, model-off 503), `pnpm build` ok; live-server probe on temp data dir + alt port returned all five error shapes correctly
- notes: Template drafting only — blast_radius excluded because its demonstration must be a genuinely runnable snippet (needs model drafting, a later slice); open kinds verify by evidence review while the run-twice sandbox path is wired and ready. No `checks`/`attempts` DB tables yet — artifacts JSON under the session dir instead, with a restart-safe scan fallback. Answers are single round-trips, not streamed. Browser behavior unverified (no browser here); UI verified through build + served endpoints only.

## 2026-10-28 — Merge origin/main (fourth divergence, ingest engine)

- item: merge remote identity/snapshot ingest into local checkpoint/tailer engine — 8 conflicted files, 23 hunks
- status: done
- evidence: full gate green (typecheck, biome 158 files, `pnpm test` → 37 files / 238 passed + 8 skipped, build)
- notes: Kept local checkpoint lane engine (resume test pins it) + remote repository-identity attribution (projectId/remoteUrl; identity test pins it); recordedAtUs nullability adopted across finalize/tailer/ingest (fork lines omit recorded_at). Drain uses remote inline baseline/tool.post (kinds-order test pins it); ingest-level tool.pre/batch.post/budget dropped — handleHookTriggerSnapshots stays exported+tested but unwired. Migration clash (both sides v3) resolved as v3 checkpoints + v4 remote_url. Also fixed 3 gate errors outside the merge per user: CLI record SpawnedChild adapter, record.test never-cast removal, server watcher type widening; added missing `@echo/db` workspace dep to CLI + pnpm install; biome-organized 4 files. Merge still open (uncommitted); concurrent session is staging/editing CLI + watcher files, so verify before committing.
## 2026-10-28 — Daemon loads repo .env.local

- item: `.env.local` fix — `dotenv` in `@echo/server`, `loadLocalEnv()` walks up from the launch dir at daemon startup; real env vars still win, missing file is fine
- status: done
- evidence: `pnpm exec vitest run apps/server/src/env.test.ts` → 3 passed; full gate green (typecheck, biome 144 files, 192 tests, build); loader probe from `apps/server` cwd found `/home/dev-aluminate/dev/echo/.env.local` with `META_API_KEY set: true` (presence only, value never printed)
- notes: Restart `pnpm dev` to pick this up. `tsx` also auto-injects `.env.local` in dev, but the built `node dist` daemon does not — the explicit loader covers both.

## 2026-10-28 — Merge origin/main (fifth divergence, dotenv)

- item: merge remote dotenv/server-env work into local tree — 1 conflicted file
- status: done
- evidence: single adjacent-append conflict in `docs/BuildTracker.md` resolved by keeping both entries; full gate green (typecheck, biome 160 files, `pnpm test` → 38 files / 241 passed + 8 skipped, build)
- notes: Merge initially refused — concurrent session had 26 unstaged tracker lines; waited for quiescence, stashed the file, merged, popped. Server dotenv files (env.ts/env.test.ts/index.ts/package.json/lockfile) auto-merged with no conflicts. Merge staged but uncommitted; tracker has additional unstaged entries from the concurrent session — coordinate before committing.

## 2026-10-28 — Phase 0: story-first paper (spec, architecture, ADR 0011/0012)

- item: product-intent + mechanism rewrite for the confirmed story-first redesign — `docs/echo-spec.md` (draft v4), `docs/ARCHITECTURE.md` (story pipeline §12, story-first UI §13, checks v2 §15, persistence decision §6, routes §17, phases §23), `docs/adr/0011-story-first-session-surface.md`, `docs/adr/0012-calibration-checks-v2.md`
- status: done
- evidence: full gate green → `tsc` clean, `biome` 160 files clean, `pnpm test` → 38 files / 249 passed, `pnpm build` ok (docs-only change; gate run against pulled HEAD `c35e7fc`)
- notes: Replay/check/report pages deleted on paper; verification is four-level (`observed`/`partly_observed`/`agent_stated`/`nothing`, observed-only counts); checks v2 = calibration picture (MCQ + free text, no Brier in web responses), `Skipped` replaces waive; notifications deferred out of v1 (notifier stays future mechanism). Implemented by three Muse Spark 1.3 Contributor subagents with disjoint file ownership + one consistency-fix pass. `docs/BUILD-PLAN.md` still carries the old plan (reviewed/proved/waived) and is superseded by spec §10/§13 + ARCHITECTURE §23 — left untouched this phase. No code changed; Phase 1 (contracts + data substrate) not started.

## 2026-10-28 — Phase 1: contracts + data substrate + engagement endpoint

- item: story-first contracts/data/server substrate — `SessionStory`/`ChangeCard`/checks-v2 (stored vs public, no keys/rubrics/brier in web shape)/engagement (`unseen`/`seen`/`engaged`)/ask-thread/artifact-ref schemas in `packages/contracts`, extended `SessionSummary` (`summary`, `checkStatus`, `highRiskCount`, `captureState`), migration v6 (`sessions.check_status` + `story_summary` + `high_risk_count`, `engagement_events` + index, `session_artifacts` PK `(session_id, kind)`), status/engagement-dedupe/tier-derivation/artifact-ref repositories, `POST` + `GET /api/sessions/:id/engagement` in `apps/server`
- status: done
- evidence: full gate green → `tsc` clean, `biome` 163 files clean, `pnpm test` → 40 files / 266 passed, `pnpm build` ok
- notes: Implemented by three Muse Spark 1.3 Contributor subagents with disjoint file ownership (contracts / db / server slices). One lint fixup pass by parent: removed an unused test const, biome-formatted the 6 touched files. Legacy check/report/ask schemas untouched for the still-live replay UI; nothing user-visible yet. Canonical card ids are a string contract (`h_` convention lives in ARCH §12, not the contract). No redaction on the engagement path (ids/kinds/timestamps only). Phase 2 (story generation pipeline) not started.

## 2026-10-28 — Phase 2 slice B: story draft validator + orchestrator + wiring

- item: model story path — `apps/server/src/story.ts` (local `StoryDraftSchema`, pure `validateDraft`, `createStoryService`/`maybeGenerateStory` orchestrator), `GET /api/sessions/:id/story` read-through route in `apps/server/src/index.ts`, fire-and-forget `onSessionQuiescent` hook in `apps/server/src/ingest.ts` (after final-snapshot persist) and `apps/server/src/muse-ingest.ts` (after `result.reconciled += 1`), `export { z }` in `packages/contracts/src/index.ts`, `apps/server/src/story.test.ts`
- status: done
- evidence: `pnpm exec vitest run apps/server/src/story.test.ts apps/server/src/story-facts.test.ts` → 2 files / 15 passed; `pnpm typecheck` clean
- notes: Validator grounds every claim/headline (file tokens incl. path-prefix, integers sans in-filename digits) against fact ids/files/basename/numbers+counts; verification is weakest-constituent-hunk (nothing floor, no model upgrade), order by high-blast/flag-count/draft-order, history always empty (cut-line-deferred); detours per-attempt with group context (side_effect > reverted > repeated_attempt, lone failed excluded); loose ends from TODO-markers in fact summaries + untested hunks when zero runs. Orchestrator checks watermark before building the review (cheap poll hook), skeleton on ECHO_MODEL=off/model/redaction-request failure, one retry on validation errors, artifact redact-scan with skeleton fallback, resume-reset only on differing watermark. No network in tests (ECHO_MODEL=off + throwing fetch). Normative deviation from ARCH §12 step 4: retry is a re-prompt with error text rather than a full regeneration, and the request payload is re-redacted before send (ARCH only mandates the artifact scan).

## 2026-10-28 — Phase 2: story generation pipeline (complete)

- item: all three slices — deterministic facts + skeleton (`apps/server/src/story-facts.ts`), inbox recording-state derivation (`packages/db` resolveCaptureState), model draft + validator + orchestrator + wiring (`apps/server/src/story.ts`, `GET /api/sessions/:id/story` read-through, fire-and-forget `onSessionQuiescent` hooks in `muse-ingest.ts` + `ingest.ts`, `export { z }` in `packages/contracts/src/index.ts`)
- status: done
- evidence: full gate green → `tsc` clean, `biome` 167 files clean (zero findings), `pnpm test` → 42 files / 285 passed, `pnpm build` ok
- notes: Three Muse Spark 1.3 Contributor subagents (facts / db-derivation / draft+orchestrator) + parent review pass. Parent fixes on slice B: claims citing unknown fact ids now drop (validator never checked factIds ⊆ known set); `checkedBy` scoped to runs linked from the card's own hunks (was: any run fact cited anywhere); `sessionOrder` is now chronological (earliest constituent tape position) instead of duplicating risk rank, so the risk ↔ session-order toggle works; `runFactIds` param removed as subsumed. Everyday `eval/muse-fixture` pointer files moved (re-run by a concurrent session, not this line). `GET /story` generates on missing/stale as a documented read-through cache. Phase 3 (web inbox + story page) not started.

## 2026-10-28 — Phase 3: web inbox + story + cards (complete)

- item: card-history endpoint (`GET /api/sessions/:id/history`, touch-overlap entries, `previousPicture` null until checks v2) + contracts `HistoryEntry`/`SessionHistoryResponse`; web shell (`/` → last-active project, triage inbox with summary/status/high-risk/capture chips, story/history/engagement api additions, story-first footer); story page (`routes/story.tsx`: 5 sections in order, top-7 + N-more fold, risk ↔ session-order toggle, skeleton banner, gaps block) + `components/story-card.tsx` (closed/open, inline diff from review hunks, inline moment slice, history intersection, disabled Ask/Check-me with phase titles) + `hooks/use-engagement.ts` (story_opened/seen/expanded/code_shown, 5s batch flush)
- status: done
- evidence: full gate green → `tsc` clean, `biome` 173 files clean (zero findings), `pnpm test` → 43 files / 289 passed, `pnpm build` ok; live-daemon probe on temp data dir + alt port (ECHO_MODEL=off): inbox row carries summary/checkStatus/highRiskCount/captureState, `GET story` serves skeleton fresh off the watermark, `GET history` 200, engagement record→tiers round-trips, unknown session 404s; built web bundle contains the new routes/copy
- notes: Three Muse Spark 1.3 Contributor subagents with disjoint file ownership (server history / web shell / story page) + parent reconciliation (slice B's guessed local history type replaced with the real contract once slice A landed; slice C's defensive `toHistoryEntries` accepts the real `{entries:[...]}` shape — verified by grep). No browser interaction available here: verified the full data path the UI consumes plus bundle contents, not clicks/renders; Playwright phase (Track E) remains the missing piece. Daemon log showed the Phase 2 finalize hook generating skeleton stories live for real sessions, and a pre-existing shutdown race (`database is not open` from an in-flight ingest poll after `db.close()` — in `scan`/`latestSnapshot`, not story code; logged, process exits; not introduced here, left for a hardening pass). Probe seed script removed; daemon shut down. Old replay/checks/report routes and localStorage engagement stay until Phase 6 deletion. Phase 4 (Ask Why thread) not started.

## 2026-10-28 — Phase 4: Ask Why thread (complete)

- item: persisted per-session thread (`artifacts/ask_thread.json`, `GET /api/sessions/:id/ask/thread`, `AskRequest.cardId` additive, card scope via story touches → existing filePath/symbols retrieval scope; refusal/citation pipeline unchanged) + web slide-over panel (`components/ask-thread-panel.tsx`, enabled per-card Ask why, citation click expands + scrolls to the card) + one retrieval fix
- status: done
- evidence: full gate green → `tsc` clean, `biome` 174 files clean, `pnpm test` → 43 files / 299 passed, `pnpm build` ok; live-daemon probes (ECHO_MODEL=off, rebuilt dist): unscoped gibberish → refused 200 + persisted; card-scoped gibberish → refused 200 with `searchedScope.filePath` set + thread accumulates with cardId; unknown card → 400; model-off with non-empty bundle → 503, nothing persisted
- notes: Two Muse Spark 1.3 Contributor subagents (server / web) + parent integration (removed slice B's `AskInput` cast workaround now the real `cardId` exists; one-line `cardId: null` in the legacy replay ask panel). Parent-found retrieval bug fixed in this phase: a file scope relabeled every doc with the query file (`queryFile ?? eventFilePath`), making `fileMatched` true tape-wide so scoped gibberish never refused pre-model (live-proven before fix, refused after); scope is now a ranking boost over genuine paths + regression test (`src/does-not-exist.ts`). Teammate committed the main-line slices as they landed (engagement/history/cardId/HomePage/StoryPage + this retrieval fix); `seed-probe.ts` + `probe-bundle.ts` were temp probe scripts (former accidentally committed by a concurrent `git add -A`, now removed from tree — shows as a deletion). No browser; panel clicks/renders unverified, data path + bundle verified. Phase 5 (checks v2 + picture) not started.

## 2026-10-28 — Phase 5: checks v2 + picture (complete)

- item: checks-v2 engine (additive `selectTargets`/`bucketFor`/`gradeMcq` in `packages/checks`, blast_radius allowed as topic with no executable demonstration) + server (`apps/server/src/checks-v2.ts`: model-drafted MCQ key-scored / free-text rubric-graded questions, ≥1 free-text when high-risk present, per-card check-me singles that never flip status alone, confidence-locked answers with evidence reveal, skip/resume state machine, 5-bucket picture; 5 routes) + web (end-of-story risk-scaled offer, one-question runner with confidence-first flow, closing picture with gap→card links, enabled Check-me, "I don't know" as guessing answer)
- status: done
- evidence: full gate green → `tsc` clean, `biome` 179 files clean, `pnpm test` → 44 files / 317 passed, `pnpm build` ok; live end-to-end probe with real model calls on a seeded 1-card session: generate → 1 free-text teach-back (high-risk rule held), answer → rubric-graded `confident_but_wrong` with verbatim excerpts + reveal, state → completed + `checked`; skip-at-offer → skipped + `skipped`; unknown card → 400; model-off generate → 503 with status untouched
- notes: Parent fixes: removed two useless-catch rethrows in checks-v2.ts; Phase 1 contracts fixture gained required `explanation` + public-schema strip assertion for it (no key/rubric/explanation leak, locked by test). `never_looked` = any card with no attempt (engagement only nudges selection); web qualifies the display via tiers. `makeCheck`/ordering/verifyDemostration legacy exports untouched for the old flow. No retakes (second answer → 400). Probe scripts removed. Old replay/checks/report pages + waive/Brier UI still live until Phase 6 deletion. Phase 6 (deletion + hardening) not started.

## 2026-10-28 — Phase 6: deletion + hardening (complete)

- item: deleted dead replay/checks/report routes + forensic components (diff/file-state/hunk/ask/check-card) + `opened-hunks.ts` + legacy `server/checks.ts` + legacy contracts schemas + legacy `packages/checks` fns/tests; story eval set (`story-eval.test.ts`: skeleton over every fixture tape, seeded-contradiction battery, watermark determinism); shutdown-race fix (async `stop()` draining in-flight polls in `ingest.ts`/`muse-ingest.ts`, awaited before `db.close()`)
- status: done
- evidence: full gate green → `tsc` clean, `biome` 169 files clean, `pnpm test` → 44 files / 314 passed, `pnpm build` ok; live daemon probe: legacy checks/report/generate routes 404 (no route), story route alive, zero "database is not open" on shutdown; web bundle + source grep-clean of replay/waive/localStorage-engagement strings
- notes: Two Muse Spark 1.3 Contributor subagents (deletion / eval+hardening) + parent review. Parent removals: dead `KIND_DESCRIPTIONS` in `packages/checks`; eval-test lint. Slice collision note: a teammate's untracked `story-eval.test.ts` (with a syntax error) occupied the same path my eval slice was assigned; the landed file is the slice's complete tested version — flagging in case the teammate had unique content there. Test count 317→314 explained: deleted `server/checks.test.ts` (5) + legacy package checks tests (4), added eval (6). Shutdown fix reviewed hunk-by-hunk; the fire-and-forget storyHook stays un-awaited by design (errors caught+logged). No live-Muse-run spike has landed (tracked as Track B, untouched). `docs/BUILD-PLAN.md` still stale (Track C, untouched); `packages/graph` empty stub kept (workspace surgery not worth it). All six phases complete; demo readiness is gate + probes, no browser pass available (Track E).
## 2026-10-28 — Phase 1 contracts + data substrate (landed, tracked late)

- item: story-first API contracts (`packages/contracts/src/api.ts`: SessionStory/ChangeCard/Detour/LooseEnd, engagement, checks-v2 stored/public, ask thread, artifact refs; SessionSummary with checkStatus/highRiskCount/captureState) + migration v6 (`sessions.check_status`/`story_summary`/`high_risk_count`, `engagement_events`, `session_artifacts`) + repositories (engagement record/list/tiers, check status, story state, artifact refs) — commits `112155f` (DammyCodes-all)
- status: done
- evidence: `pnpm exec vitest run packages/contracts packages/db` → 3 files / 32 passed (api 11 incl. 5 card-ID tests added later, tape 4, db 17); full gate green at `52b8075`+work (typecheck, biome 172 files, 41 files / 278 passed + 8 skipped, build)
- notes: Tracked late — landed without a tracker entry. Engagement tiers match spec §4 (card_seen → seen; card_expanded/code_shown/ask_opened → engaged; null-card story_opened ignored). `session_artifacts` header table is not in the ARCH §6 table list but matches its "list views read status columns/artifact headers" rule; `engagement_events` carries `occurred_at` instead of ARCH's `hunk_id`/`meta_json` (card_id already covers the hunk — same namespace). Review found one Phase 1 exit gap (contracts did not enforce canonical card IDs); closed by the next entry. Untouched by this entry's author; lint-format/unused-var fixes only.

## 2026-10-28 — Story-validation fixture sessions + hand labels (landed, tracked late)

- item: six tape-only story fixtures (`packages/fixtures/src/sessions.ts`, computed hunks/attempts/runs via `@echo/tape`) + hand-labelled expected facts (`expected.ts`, validator-scope labels only) pinned as checked-in JSON (`fixtures/expected/*.json`: payment-retry, routine, research, failed-deploy, partial-gap, multi-topic)
- status: done
- evidence: `pnpm exec vitest run packages/fixtures` → 3 files / 23 passed (sessions 11, expected 9, fixtures 3); full gate green (see above)
- notes: Tracked late — commits `11fc738`–`52b8075` (Sam-Charles). Fixture hunk/card IDs come from `hunkIdFor`, so they already satisfy the canonical-ID enforcement added afterwards — no fixture changes needed. Labels assert tape-supported facts only (badges, risk reasons, detour fold/in, blind spots, one must-drop seeded contradiction); the story validator that consumes them is Phase 2 work, not started.

## 2026-10-28 — Contracts enforce canonical card IDs + versioned artifact layout

- item: `CardIdSchema`/`HunkIdSchema` (`h_` + 16 lowercase hex, one schema object under two names per ARCH §12) applied to every card/hunk ID field (ChangeCard id + constituents, ReviewHunk id, evidenceByHunk + tiers record keys, engagement/loose-end/check-picture/ask-thread cardIds, legacy StoredCheck hunkIds); `AskThreadSchema` gains `schemaVersion: 1`; `ARTIFACT_FILE_NAMES` pins story/checks_v2/ask_thread filenames; tape conformance test pins `hunkIdFor` output against the contract schema
- status: done
- evidence: full gate green — `tsc` clean, `biome` 172 files clean, `pnpm test` → 41 files / 278 passed + 8 skipped, `pnpm build` ok; new tests: 5 in `api.test.ts` (shape accept/reject incl. `path:index` rejection, card rejection, tiers-key rejection, layout pin, thread version), 1 in `review-index.test.ts` (constructor conformance)
- notes: Closes the Phase 1 exit criterion "contracts enforce canonical card IDs". Contracts stay browser-safe (zod only; sha256 stays in `@echo/tape`). `z.infer` is still `string`, so no call-site type churn; server/review/checks producers already emit canonical IDs. Deliberately untouched: web still keys hunks as `path:hunkIndex` (dies with the replay UI in Phase 3); `graph.json`/`report.json` artifact kinds (Phase 6/7); Detour/LooseEnd slug ids (ARCH mandates no format). Also fixed the red lint gate on arrival (unused var + biome formatting in the landed files, no semantics).

## 2026-10-28 — Phase 2: deterministic fact extraction (`@echo/story`)

- item: new `packages/story` package (ARCH §4) with pure `extractFacts` — prompts, final-diff hunks, classified attempts, tape-derived runs + consequential actions, capture gaps, per-hunk mechanical classification (format/rename/generated/comment) and blast-radius risk flags with unverified boost; sequential stable F-IDs in documented emission order
- status: done
- evidence: full gate green — `tsc` clean, `biome` 176 files clean, `pnpm test` → 42 files / 299 passed + 8 skipped, `pnpm build` ok; `packages/story/src/facts.test.ts` → 21 passed (10 over the six story fixtures incl. F-sequencing, payments/stored_data/production flags, rename-only tool evidence, gap 4→9, rewrite count, determinism-under-shuffle; 11 classifier edge units)
- notes: Runs derive from tool request/completion pairs (command input or exit code qualifies; lone request → interrupted, lone completion kept, never dropped); run coverage is session-level passing-run by documented coarse rule (no run-to-file linkage on tape yet); centrality always null (import graph unwired); 50-line large-mechanical threshold and flag patterns are provisional per ARCH §12 hand-check note. Fixed during tests: `buildFileAttempts` emits per-file `baseline` pseudo-nodes, now filtered (pre-session state, not behavior). Validator + skeleton fallback are the next units in this slice, not started. `tsconfig.json` gains the `@echo/story` path; `pnpm install` re-run for workspace links.

## 2026-10-28 — Phase 2: story validator + extraction addendum (`@echo/story`)

- item: `validateStoryFacts` (claim number/path/backtick-quote checks against cited facts with attempt↔hunk and run↔action evidence linkage; server-overwritten verification badges; deterministic risk rollup; structure diagnostics incl. watermark drift) + `dropFailedClaims` ("Echo couldn't verify this" gap lines, summaries kept with diagnostics). Extraction addendum: `agent_text` facts, hunk side texts for the check surface, `FactSet.tapeEventCount`
- status: done
- evidence: full gate green — `tsc` clean, `biome` 178 files clean, `pnpm test` → 43 files / 314 passed + 8 skipped, `pnpm build` ok; `packages/story/src/validate.test.ts` → 15 passed: all six hand-label sets validate clean with matching badges (partly/observed/nothing, highRisk flags), seeded 3-vs-2 contradiction rejected, quote/path/unknown-id/number-boundary/structure/drop/summary-kept units
- notes: Badge ladder: no cited facts → nothing; behavior-free citations → agent_stated; all-failed attempts without a passing run → nothing; hunk boost or uncertain links → partly_observed; else observed. Numbers need standalone occurrence (1 never matches inside 100); path tokens exclude version-like `1.3` and `3/9`; bare story strings check loosely against the whole set. Validator keeps claims in place with verdicts — the server owns the 1-regeneration loop between validate and drop. Fixed during tests: 3 assumption errors on my side (summary verdict counted; synthetic hunk numerics contained 1s), plus tsc-only errors esbuild missed (wrong param type, dropped AttemptFact.detail — surface uses path/trigger/status instead).

## 2026-10-28 — Phase 2: skeleton fallback + staleness (`@echo/story`)

- item: `buildSkeletonStory` (one card per behavior hunk, mechanical fold to routine line, detours from dead-end attempts, blind spots from gaps, passing-run checkedBy, skeleton-v1/watermark stamps, then through the validator so badges/risk/counts match model stories) + `isStoryStale` (count-or-hash drift past the watermark)
- status: done
- evidence: full gate green — `tsc` clean, `biome` 180 files clean, `pnpm test` → 44 files / 324 passed + 8 skipped, `pnpm build` ok; `packages/story/src/skeleton.test.ts` → 10 passed: self-validation clean + schema-valid on all six fixtures, per-fixture card counts/badges (partly/nothing/observed), routine fold, detour/blind-spot derivation, risk-rank vs chronological session order, empty session, determinism, staleness
- notes: Skeleton claims self-cite by construction (prompt text, hunk counts/paths, run commands/exits), so a failing self-verdict is a builder bug. Skeleton never writes why-lines (no intent without a model) or loose ends (needs model reading); checkedBy lists passing runs only. Fixed during tests: sessionOrder first followed path-sorted emission — now chronological by first attempt touch. Watermark sha is caller-supplied (builder never sees the tape); stale-triggered regeneration + check_status reset belong to server finalization, not started.

## 2026-10-28 — Phase 2: model narration + generation service + finalize wiring

- item: `story-v1` narration prompt over fact IDs (per-field + whole-prompt truncation markers) + `createStoryService` (gather → extract → model narrate with 1 regen → validate → drop → redaction-gated story.json write + artifact ref + inbox columns; ECHO_MODEL=off/keyless/schema-invalid/model-error all degrade to skeleton) + daemon wiring (storyOnce backfill/regen for quiescent reconciled sessions, one per poll, check-status reset; best-effort, never fatal to ingest)
- status: done
- evidence: full gate green — `tsc` clean, `biome` 184 files clean, `pnpm test` → 46 files / 343 passed + 8 skipped, `pnpm build` ok; new: `narration.test.ts` → 6, `story-generate.test.ts` → 9 (not_found, model persist incl. ref+inbox, regen fix, regen-exhausted drop, schema-invalid/keyless/model-off skeleton, redaction-fail closed, bare-session gather), 3 ingest wiring tests (post-reconcile gen, resume regen + reset, throwing generator survives)
- notes: Fixed during tests: dropFailedClaims never dropped shortVersion/askVsResult claims (now does, with regression test); a first-gen hook inside exportOnce double-fired with the backfill path on failure polls — removed, storyOnce owns all generation (runs after exportOnce in the same poll, so reconcile polls still generate immediately). Watermark eventCount uses raw maxTapeSeq via a new extractFacts override (deduped inputs would loop regen). Reuses buildSessionReview for hunks/attempts (evidence cost accepted). OpenCode finalize has no story hook yet — Muse only this unit. `@echo/story` added to server deps + install.

## 2026-10-28 — Phase 6 merge follow-up: story generation rewired onto `@echo/story` (option a)

- item: kept `apps/server/src/story.ts` as the orchestration shell; replaced its internals (buildFacts → extractFacts, local prompt → buildNarrationMessages, validateDraft → validateStoryFacts + dropFailedClaims, skeletonStory → buildSkeletonStory); deleted `story-facts.ts`, `story-facts.test.ts`, `story-eval.test.ts`, `story-generate.ts`, `story-generate.test.ts`; one-line `checks-v2.ts` import fix (`computeWatermark` now from `./story`); rewrote `story.test.ts` (15 tests)
- status: done
- evidence: full gate green — `tsc` clean, `biome` 187 files clean, `pnpm test` → 48 files / 384 passed, `pnpm build` ok; scoped run `packages/story story.test.ts checks-v2.test.ts ask.test.ts history.test.ts` → 8 files / 96 passed (all model paths via injected fetchImpl, throwing fetch on skeleton paths, zero-fetch asserted for model-off/keyless)
- notes: (a) chosen because the shell owns the behaviors index/ask/checks/history depend on (read-through fresh-serve with corrupt-artifact fallback, watermarkChanged + check_status reset, review-build-failure fallback, blind-spot merge, GET shape + fire-and-forget hook — all unchanged) while the engine owns the pure pipeline. Ported onto the engine FactSet pre-validation: repeated_attempt detours (lone failed excluded), TODO-scan + untested-path loose ends, risk-rank vs chronological sessionOrder; review-diagnostic + captureQuality blind spots merged post-drop (server diagnostics, not session claims). Writer adopts ARTIFACT_FILE_NAMES (sessions/<id>/story.json); downstream readers resolve via the db artifact ref first, so ask/checks-v2/history are unaffected. `export { z }` kept (checks-v2.ts imports it). Deliberately not adopted from their engine: bare storyText blind-spot validation for server diagnostics (merged post-drop instead), model-supplied rank/sessionOrder (recomputed deterministically), tape-file-sha watermark (kept event_id-hash computeWatermark shared with checks-v2). Fixed during tests: request payload was the {system,user} object instead of a ChatMessage array (first call silently malformed, regen crashed on spread — caught by the regen/drop tests); engine skeleton summary/risk-count assertions updated to engine values.

## 2026-10-28 — DB migration renumber heal (duplicate remote_url on dev start)

- item: `packages/db` migrator tolerates the v3 renumber (merge c6b7479: one branch shipped remote_url as v3, the other reader_checkpoints as v3) — `backfillRenumberedV3` recreates reader_checkpoints when v3 is recorded but the table is missing; per-statement migration run skips ADD COLUMN when the column already exists; all CREATE TABLE/INDEX in `migrations.ts` are IF NOT EXISTS
- status: done
- evidence: `tsc` clean; `pnpm test` → 48 files / 391 passed (incl. new legacy-drift test: v1+v2 + old-v3 remote_url + versions {1,2,3} heals to {1..6} with checkpoints backfilled); `pnpm build` ok; live daemon on the real `~/.local/share/echo/echo.sqlite` healed in place (versions 1..6, all tables present) — `/api/health` ok, `/api/projects` serves real rows; pre-fix backup at `/tmp/opencode/echo-backup-20261028.sqlite`
- notes: Backup copy taken before the first healed boot. Commits `0459c02`/`35ab95a` (concurrent session) landed the same worktree fix; the biome --write formatting on `database.ts`/`db.test.ts` is still unstaged. Repo-wide `pnpm lint` still flags `useLiteralKeys` in the concurrent session's in-flight `apps/server/src/story.ts`/`story.test.ts`/`engagement.test.ts` — untouched, not mine.

## 2026-10-28 — Live capture-loop verification + attribution/prompt fixes

- item: verified the automatic Muse capture loop live (temp data dir + alt port daemon, 2 real headless sessions): ingest → snapshots → export reconcile → model-narrated story.json + artifact ref + inbox summary. Fixed 2 live blockers found en route: (1) attribution probe checked marker paths absent from real logs (all 9 parent logs skipped) — unified `extractWorkspaceRoot` now reads observed `route_facts.record.cwd` + nested `workspace_root` incl. frame children; (2) reader mapped textless records to `prompt.submitted` with no text ("No prompts recorded") — text now extracted from `model_messages`/`refill_blocks`, `materialized` → notification, intake → session.started; extractor skips empty prompts. Also applied mechanical biome autofixes (useLiteralKeys/format) to the concurrent session's story.ts/story.test.ts/engagement.test.ts + import.ts to restore the gate
- status: done
- evidence: full gate green — `tsc` clean, `biome` 187 files clean, `pnpm test` → 48 files / 391 passed + 8 skipped, `pnpm build` ok; live: fresh `muse exec` session captured (217 events, baseline+final+tool snapshots ok), reconciled, story.json model-narrated ("User asked a simple arithmetic question…", generator model/story-v1, fact-cited claims, 0 cards for the read-only session); focused tests: 6 attribution probe tests (proven failing pre-fix via stash), 2 prompt-mapping tests, empty-prompt skip. Temp daemon/data/scratch all removed; repo untouched (git status: only these edits + suite-regenerated eval stamps)
- notes: Parallel session (Sam-Charles) committed to main mid-verification and absorbed this session's earlier uncommitted story work (renamed story-generate.ts → story.ts, added quiescence-hook wiring, checks-v2/engagement/history); nothing lost, tree reconciled. Hooks never fired for headless `muse exec` (drained: 0 on every poll) — hook firing in live INTERACTIVE use is still the one unverified link. Earlier skeleton fallbacks were transient model errors; narration works live. Observed marker/prompt shapes recorded in docs/spikes/2026-10-27-muse-session-log.md addendum. Not verified: OpenCode story hook (other adapter), model-spend volume on big backfills.

## 2026-10-28 — Skeleton readability caps + untested-end folding + stale-skeleton regen

- item: skeleton fallback no longer degenerates on wide sessions: capped summary/routine path lists (`summarizePaths`, 5 + "and other files"), card cap (20 by rank + overflow card carrying folded hunk ids, risk rolls up, verified "nothing"), server `enrichStory` emits one untested end per card + one shared end for cardless hunks and skips mechanical hunks, `maybeGenerateStory` read-through regenerates `skeleton-v1` artifacts under the `skeleton-v2` builder
- status: done
- evidence: full gate green — `tsc` clean, `biome` 187 files clean, `pnpm test` → 48 files / 398 passed + 8 skipped, `pnpm build` ok; new tests: 3 skeleton cap/fold units + 3 server enrich/staleness units (fold end, mechanical skip, orphan collapse, v1 regen); live on ses_e8230444 (121-hunk import): summary now capped prose, 21 cards + overflow ("101 further hunks across 82 files folded"), ends 170 → 21 on the skeleton path; after cache clear the model path produced 6 cards + 7 ends and the inbox row flipped recording → partial with a real summary
- notes: Bare-string validator rule forced the design: capped notices carry no novel numbers/paths (counts live on headlines, which are not claims). Overflow id is `hunkIdFor("folded", empty-hunk)` (valid canonical id, no new dep — `@echo/story` already depends on `@echo/tape`). Biome --write also normalized bracket access in `normalizeDraftShape` (format-only, concurrent session's in-flight style). Model-narrated import stories still badge all cards `nothing` (no behavioral linkage) — validator ladder, out of scope. Other 13 imported sessions self-heal on open (no artifact → read-through generates).

## 2026-10-28 — Merge main + origin/main (22↔22) + story engine unification

- item: resolved all 6 textual conflicts (index.ts → ours + drop story-generate wiring; muse-ingest.ts → ours + drop storyOnce + its tests; contracts → ours + CardId/HunkId + HunkIdSchema on ReviewHunk/evidenceByHunk keys; BuildTracker concatenated; eval churn taken from ours); adopted origin's additive work (packages/story engine + fixture sessions/expected JSONs + tests, tape review test, tsconfig path, server dep); fixed 24 canonical-ID test fallout (fixtures to h_ + 16 hex; invalid refs like H99/ZZZ/card-nope preserved); applied CardIdSchema to AskThread empty() (schemaVersion: 1 was missing → threads would 500)
- status: done
- evidence: full gate green on merged HEAD — tsc clean, biome 187 files (infos only), pnpm test → 48 files / 391 passed, pnpm build ok
- notes: Per user decision the engine is theirs: rewire subagent replaced story.ts internals with extractFacts/buildNarrationMessages/validateStoryFacts/dropFailedClaims/buildSkeletonStory, deleted story-facts*/story.test.ts/story-eval*/story-generate*, kept our orchestration shell (GET read-through, watermark, reset, redaction). Follow-up parent fix in this same entry: live probe proved the new engine starved at 8k tokens (finish=length, null content, 2/2 runs) — model client now sends top-level reasoning_effort (validated; default unset; env META_REASONING_EFFORT), story narration uses 50k floor + medium effort + one parse-failure regen with the zod errors quoted, plus envelope/shape normalization for server-owned fields (tapeWatermark/generator), moment ""→null/label fallback, card claim object→array coercion, invalid previousPicture→null. Live end-to-end (real model, seeded payment-retry session): OUTCOME generated, 1 card partly_observed/highRisk, no gaps, inbox summary written. Remaining lint infos are stylistic unsafe-fix suggestions on dynamic Record access — left as-is. The merge commit itself was landed by the concurrent session; no uncommitted work remains.

## 2026-10-28 — Remote sync (merge origin/main, no conflicts)

- item: merged `origin/main` (`45d7ffb` + `extractWorkspaceRoot` import/test commits) into local `03fbe7f`; pushed as `532dc02`
- status: done
- evidence: ort merge, zero conflicts (local side touched only generated `eval/muse-fixture` output, remote side only `muse-ingest.ts`/`capture-muse` import files); post-merge gate: `tsc` clean, `pnpm test` → 48 files / 397 passed, `pnpm build` ok; `git push` clean, `main` in sync with `origin/main`
- notes: Chose merge over rebase per repo convention (all prior syncs are ort merges). Regenerated `eval/muse-fixture` output + this entry left unstaged — user owns history.

## 2026-10-28 — Remote sync (merge origin/main, 3 conflicts)

- item: merged `origin/main` (4 commits: ProjectsPage routing, result.json echo refs, remote merge, project-id fix) into local (5 commits: skeleton-v2 caps/fold/staleness + useLiteralKeys + engagement/story test pins + import readability + facts risk-flag test)
- status: done
- evidence: previewed read-only (`merge-tree --write-tree` flagged only the 3 generated/append-only files), resolved: BuildTracker concatenated (both entry blocks kept), eval report.json/result.json taken from ours then regenerated by the gate; post-merge gate green — `tsc` clean, `biome` 186 files clean, `pnpm test` → 48 files / 398 passed + 8 skipped, `pnpm build` ok
- notes: Code sides disjoint (local: story/skeleton/capture-muse; remote: web routes) — zero code conflicts. Merge left open (uncommitted) per user-owns-history; regenerated eval stamps left unstaged.

## 2026-10-28 — Story page quality pass (explanation-first fixes, no contract change)

- item: page quality rules from the story UI review — deduped headline/subtitle/short-version (subtitle is now a computed shape line), empty Ask groups/Detours/Loose-ends sections hidden instead of "None recorded", prominent verification band ("How much is verified" with 4 badge counts) replacing the tiny grey line, loose ends grouped by behavior with card-headline links, untested absence relabeled observed, single max-w-2xl text width, no-card sessions skip behavior sections and the sort toggle; card badges enlarged with shared VERIFICATION_BADGE map, empty Before/Now columns hidden
- status: done
- evidence: full gate green → `tsc` clean, `biome` 186 files / 0 errors / 30 infos (pre-existing useLiteralKeys, proven identical on untouched HEAD via isolated worktree), `pnpm test` → 48 files / 397 passed (incl. new observed-label assertion, watched fail before the fix), `pnpm build` ok; live-daemon probe on temp data dir + alt port (health ok, story 404 shape); built web bundle contains the new copy and none of the removed empty-state strings
- notes: Badge levels kept at 4 per user decision (observed/partly_observed/agent_stated/nothing), display labels now "Observed / Partly observed / Agent-stated / Nothing observed". One-line honest absences kept intentionally ("No reason recorded", "No files touched", "Nothing observed checking this", "No check needed"). No browser interaction available here — clicks/renders unverified, data path + bundle verified. Mechanical `biome format --write` on untouched `packages/capture-muse/src/import.ts` to restore the green gate (pre-existing format error at HEAD, wrap-only diff, no semantics). Walkthrough fields (problem/flow/chose-over/watch-out), story-top map, and check pre-generation are the confirmed next units, not started.

## 2026-10-28 — Remote sync (merge origin/main, story.ts label conflict)

- item: merged `origin/main` (`9997620` story verification labels + StoryCard/story-route rework) into local merge `dd57b4e` + report-stamp `5896078`
- status: done
- evidence: previewed read-only (real conflict only in `apps/server/src/story.ts`, plus append-only BuildTracker + generated eval stamps); resolved: adopted remote's `observed` label (+ comment) for the untested absence on all three end variants (per-card, folded-card, orphan) — their merged test pins it on the per-card case; BuildTracker concatenated; eval files from ours then regenerated; post-merge gate green — `tsc` clean, `biome` 186 files clean, `pnpm test` → 48 files / 398 passed + 8 skipped, `pnpm build` ok
- notes: Remote's single-hunk end and my collapsed orphan end touched the same hunk; semantics agree (full-tape scan absence is observed), so no product call was overridden. Merge left open (uncommitted) per user-owns-history; regenerated eval stamps left unstaged.

## 2026-10-28 — highRisk means observed flags only + per-hunk gap note

- item: `rollUpRisk` no longer promotes boost markers to High risk (`highRisk = flags.length > 0`; riskReasons carry flag reasons + evidenced rewrite notes, boost strings out); server `enrichStory` surfaces the card-specific "no surviving attempt evidence for <path>" boost as an uncertain `checkedBy` claim (pre-validation, path must be in cited facts, no shape change); `unverifiedBoost` untouched (still drives partly_observed)
- status: done
- evidence: full gate green — `tsc` clean, `biome` 186 files clean, `pnpm test` → 48 files / 399 passed + 8 skipped, `pnpm build` ok; consumer grep (riskReasons/highRisk/highRiskCount: checks-v2 rank+teach_back+prompt, checks pkg sort, web inbox badge + CheckOffer, server applyOrdering + highRiskCount, all tests/fixtures) — no logic changes needed outside rollUpRisk, only pinned-test updates; browser pass (headless chrome, virtual-time screenshots + API): inbox "121 high-risk" → "7 HIGH-RISK" on both storied sessions, every flagged card cites a real `destructive:` pattern match, unflagged cards show verification badge only, loose ends render per-card + 1 orphan
- notes: Deliberate call: rewrite notes kept in riskReasons (observed attempt outcomes, load-bearing for multi-topic fixture) — "flags only" read strictly would drop a real signal, said so in report. The surviving-attempt note fires only when that exact gap exists (seed session has none; covered by new finalizeStory unit over dead-end attempts). Remaining noise is the destructive pattern's breadth (matches test files, docs, BuildTracker) — facts-level tuning with hand-check implications, not touched here. Other 13 sessions still story-less (pre-existing lazy generation, untouched).

## 2026-10-29 — Destructive-flag retune (action over filename)

- item: `DESTRUCTIVE_PATTERN` now matches actions (`rm -rf <target>`, `git reset --hard`, `git clean -fd`, `DROP TABLE|DATABASE`, `TRUNCATE TABLE`, `deleteMany(/deleteFrom(`, `mkfs`, fork bomb) instead of bare words — the old bare `TRUNCATE` matched everyday "truncate/truncated" prose and flagged hook.ts, muse-ingest.ts, docs; test/doc/markdown/tracker paths excluded from code-text matching (commands still flag regardless of linked path); whole-file deletion flags via per-path new/old-line sums; hand-labelled both-sides fixtures in facts.test.ts (true: rm -rf, reset --hard, DROP/CREATE TABLE forms, deletion, deleteMany call; false: hook.ts truncate prose, test-body rm -rf, docs DROP TABLE, BuildTracker narration, partial deletion)
- status: done
- evidence: full gate green — `tsc` clean, `biome` 187 files clean, `pnpm test` → 48 files / 401 passed + 8 skipped, `pnpm build` ok; browser pass on both storied sessions after cache clear + regen: 17 HIGH-RISK each (was 121), every flag cites a real `stored_data:` boundary match (db/*, capture-opencode store), unflagged cards show verification badge only
- notes: Still >1/3 of cards flagged — reported as instructed, but every remaining flag is a true positive under the taxonomy (both sessions genuinely center on the DB layer); the `store` substring also matches capture-opencode's event store, arguably correct. Follow-up candidate (not done): narrow `store` or the stored_data path list if the noise bothers triage. Command-side matching deliberately ungated: a destructive command that ran is evidence wherever it links.

## 2026-10-29 — Story-page UX pass (items 6, 5, 3, 4, 2, 1)

- item: (6) fixed white-on-white active sort tabs (active = accent bg + base text, inactive = pill + muted, focus-visible rings; same broken combo fixed on all primary buttons in check-offer/check-picture/check-runner/ask-thread-panel/story Done button); (5) subtitle "N behavior changes · M loose ends" are anchor links to #what-changed/#loose-ends (ScaffoldPage description widened string → ReactNode); (3) Ask vs result is one row per ask with arrow and "Not delivered" state, matched by index or shared factIds, Extras/Missing keep null-when-empty groups (ClaimBody split out of ClaimItem for valid HTML); (4) cards show verification badge + High-risk flag only, destructive pinned to top with fail-wash warning + dismiss-as-false-positive (local state + undo), per-card touches chips (+N more), added/removed lines from headlines, "No reason recorded"/"No risk signal" fallbacks removed, rewrite notes render neutral on unflagged cards, single "No passing run" notice above the list keyed on untested loose ends; (2) skeleton shortVersion emptied (prompts stay in asked), narration prompt asks for delivered-only shortVersion, UI guard drops prompt-duplicate lines (normalized compare) and hides the section when empty, with dev-only console.debug tripwire on model stories
- status: done
- evidence: `tsc` + `biome` clean, `pnpm test` → 48 files / 401 passed (web exempt from vitest), `pnpm build` ok; browser pass (headless chrome, virtual-time): desktop rail panel + mobile sticky bar with counts/bar/links/Start check, subtitle anchors in DOM, Short version absent on skeleton session and 2 delivered bullets on the model session, ask rows render, tabs readable, no duplicate sentences, no empty cells
- notes: Item 1's mobile bar included in the same pass. Console.debug is web-only (server/CLI console ban untouched); tripwire unfired in testing (no model story with prompt-only shortVersion present — skeleton hides silently by design). Destructive pin/warning/dismiss had no live destructive flags to exercise (tuning removed the false ones; true stored_data flags render the High-risk path instead) — logic reviewed, interaction unclicked in browser. Loose-ends "simple list" fallback: section already hides when empty per the acceptance rule, so nothing added. Demo dead-attempt case skipped: demo route is an unbuilt stub with no session to attach it to.
## 2026-10-28 — Check start hang + button restyle

- item: fixed the stuck "Starting…" on check start — checks-v2 model calls now run under an overall 180s deadline (race + abort, so the handler always answers 503 and status stays untouched); web adds a 200s request backstop, elapsed-seconds progress with Cancel on the offer, and a friendly timeout message; fixed the unreadable white-on-near-white primary buttons (`bg-dusk-ink text-white` was backwards — dusk-ink is #EEEEFA) across offer/runner/picture/sort-toggle to the accent-pill primary + wash-chip selection language
- status: done
- evidence: full gate green → `tsc` clean, `biome` 186 files / 0 errors / 30 pre-existing infos, `pnpm test` → 48 files / 398 passed, `pnpm build` ok; repro test `generate fails closed fast when the model call stalls` watched red (10s hang) before the fix and passes in ~50ms after; live-daemon probe healthy with story route alive; built bundle carries the new progress/timeout copy; no `bg-dusk-ink text-white` remains in web src
- notes: Root cause was hypothesis H1 (stalled model call, no timeout anywhere in server→model→UI chain); H4 (busy-flag bug) ruled out by inspection since `finally` always resets. Same no-timeout flaw still exists in story generation (`story.ts` narrate) and ask grading — noted as follow-up, untouched here. `unavailable()` still returns code `check_unavailable`, which is outside the contracts ErrorCode enum — pre-existing, untouched. No browser here: clicks/renders unverified, data path + bundle verified. eval/muse-fixture output regenerated by the suite run (timestamps/ids only).

## 2026-10-28 — Checks model budget: 10k default at low reasoning

- item: checks-v2 `resolveConfig` now defaults to 10k max tokens + low reasoning effort; explicit `META_MAX_TOKENS` / `META_REASONING_EFFORT` still win. Applies to question drafting, free-text enforcement, and free-text grading (one shared checks config).
- status: done
- evidence: full gate green → `tsc` clean, `biome` 186 files / 0 errors (34 infos, all pre-existing-pattern useLiteralKeys), `pnpm test` → 48 files / 400 passed, `pnpm build` ok; new tests pin `max_tokens: 10000` + `reasoning_effort: low` on the draft request by default and env override winning (default test watched red before the fix)
- notes: Retry ceiling follows automatically (`max(2x, 8192)` → 20k on budget-exhausted retry). Story narration and ask keep their own budgets — untouched.

## 2026-10-29 — Remote sync (merge origin/main, button system + cancel wiring)

- item: merged `origin/main` (checks-v2 timeout/cancel + canonical pill PRIMARY/SECONDARY buttons, 2 commits) into local (18 commits: riskReasons/rollUpRisk, destructive retune, story-page UX 6/5/3/4/2/1)
- status: done
- evidence: previewed read-only (7 conflict files: 4 code + tracker + 2 eval); resolved: adopted remote's shared PRIMARY/SECONDARY pill constants everywhere (adding the missing focus-visible rings), remote's selected-option wash style, remote's AbortController cancel wiring (refs, signal plumbing, onCancel) into the merged CheckOffer call; kept local UX structure (tabClass tabs, panel/aside/ids, ask rows, destructive pin/dismiss, ShortVersion guard); BuildTracker concatenated; eval files from ours then regenerated; post-merge gate green — `tsc` clean, `biome` 187 files (4 pre-existing-pattern infos), `pnpm test` → 48 files / 404 passed + 8 skipped, `pnpm build` ok; headless-browser render check of the merged story page (panel, tabs, delivered Short version, ask rows, untested ends all correct)
- notes: Both sides independently fixed the same white-on-white button bug with the same colors — took remote's canonical constants as the system. Remote's `onCancel`/abort path is adopted unwired-tested (no live cancel click headless); typecheck + build cover the wiring. Merge left open (uncommitted) per user-owns-history; regenerated eval stamps left unstaged.
## 2026-10-29 — Project tabs: Overview / Learn / Architecture

- item: project shell with tab nav (`overview`/`learn`/`architecture`, index redirects to overview); Overview = purpose + current-state stats + tech-stack line + agent sessions list; Learn = empty placeholder; Architecture = agent-touched file overlay (`GET /api/projects/:id`, `GET /api/projects/:id/files`, `listProjectTouchedFiles` + `getProject`, contracts `ProjectFileTouch/FilesResponse`)
- status: done
- evidence: full gate green → `tsc` clean, `biome` 190 files clean (infos only), `pnpm test` → 49 files / 411 passed, `pnpm build` ok; built web bundle contains Overview/Learn/Architecture copy and new project/files fetchers
- notes: Full ts-morph import graph stays cut — Architecture labels itself as snapshot overlay only, no model summary. Old `ProjectPage` route removed; `/projects/:id` redirects to `overview`. No capture changes; DB addition covered by `project-overview.test.ts`.

## 2026-10-29 — Full-width layout, chrome trim

- item: removed `max-w-6xl` page constraint (header/main/footer now full-width `px-6`); removed header bottom border + Projects/Demo nav; removed footer
- status: done
- evidence: full gate green → `tsc` clean, `biome` 190 files clean (4 pre-existing infos), `pnpm test` → 49 files / 411 passed, `pnpm build` ok; built web bundle no longer contains footer copy
- notes: UI-only (`apps/web/src/layout.tsx`). ScaffoldPage `max-w-2xl` header text kept for readability; page body is full width.

## 2026-10-29 — Liquid glass project nav (bottom-right, HugeIcons)

- item: vendored Nimbus LiquidNavbar into `apps/web/src/components/ui/liquid-glass-navbar.tsx` (WebGL water pill + CSS-drop fallback, no deps beyond React); replaced the ProjectLayout tab row with a `fixed right-6 bottom-6` dark-tone navbar wired to router (Overview/Learn/Architecture, active derived from pathname); HugeIcons strokes (`DashboardSquare01`/`BookOpen01`/`Structure01` via `@hugeicons/react` + `@hugeicons/core-free-icons`)
- status: done
- evidence: full gate green → `tsc` clean, `biome` 191 files clean (4 pre-existing infos), `pnpm test` → 49 files / 411 passed, `pnpm build` ok; built web bundle contains `nimbus-nav` + `fixed right-6 bottom-6` + section labels
- notes: Adapted the pasted component for repo strictness (typed Uniforms bag, null-guards over `!`, `tone` dep dropped as behavior-neutral, braces in forEach setters); kept intentional extra layout-effect deps + label-index keys + inline `<style>`/decorative canvas behind `biome-ignore` with reasons. Deprecated `hugeicons-react` rejected in favor of maintained `@hugeicons/react`. No browser here: positioning/animation unverified beyond bundle contents. No API/capture changes.

## 2026-10-29 — Story-page project nav pill

- item: shared `ProjectNavPill` (`apps/web/src/components/project-nav-pill.tsx`, `PROJECT_SECTIONS` + fixed bottom-right dark-tone LiquidNavbar) used by both `ProjectLayout` and the session story page (`apps/web/src/routes/story.tsx` renders it with `active={-1}` once `sessionQuery.data.projectId` loads; taps navigate to the parent project's section)
- status: done
- evidence: full gate green → `tsc` clean, `biome` 193 files clean (4 pre-existing infos), `pnpm test` → 49 files / 414 passed, `pnpm build` ok; built web bundle contains `fixed right-6 bottom-6`
- notes: `ProjectLayout` refactored to the shared pill (no behavior change there). Story page passes `active={-1}` so no section highlights on a non-section route. Import-sort auto-fixed via `biome check --write`. No API/capture changes. User must restart `pnpm dev` (HugeIcons deps) + hard-refresh to see it.

## 2026-10-29 — Project cards as glass folders

- item: replaced the projects inbox Link cards with an adapted GlassFolder component (`apps/web/src/components/glass-folder-cards.tsx`, pasted + Echo-adapted) driven by a `ProjectFolderCard` wrapper: click opens the folder revealing the last 3 sessions as real links, `···` menu holds Open project, "View all N sessions →" link appears beneath while open; custom dusk streak art, dark tone, staggered entrance; sessions lazy-load on first open (controlled open + keyed remount around the component's read-once files prop)
- status: done
- evidence: full gate green — `tsc` clean, `biome` 193 files clean (4 pre-existing remote infos), `pnpm test` → 49 files / 406 passed + 8 skipped, `pnpm build` ok; browser pass via headless Chrome + stdlib CDP client: closed/open/menu screenshots (glass, art, fan of 3 real session sheets, view-all link), mouse open loads 3 sessions, file links point at /sessions/:id, Escape closes, Tab reaches hit/key controls in order, ··· menu ArrowDown lands on "Open project", mobile 390px single column, meta ellipsis with title tooltip
- notes: Strict-TS adaptations required: must() guard for vendored index access (fail loud, never NaN), ArrayBuffer-typed pixels, ul/li instead of role=list/listitem divs, span-wrapped aria-hidden canvas, template literals, Math.min/max clamps — semantics preserved. Removed Copy path (decided: marginal value, clipboard can fail); root path + remoteUrl no longer shown on the card itself (name/sessions/activity kept; root lives on the sessions page) — say the word if that trade-off is wrong. Enter-to-open doesn't fire from CDP-synthesized keys (Chrome default-action quirk, same for every site); click/Tab/Escape/menu paths all verified with real input delivery. Reduced-motion path reviewed in code, not driven. No API or contract changes; web has no vitest coverage by repo rule.
## 2026-10-29 — Folder-sheet details + View-all link race fix

- item: `ProjectFolderCard` session sheets render real detail lines (date · model, check status + high-risk, capture state) via a new optional `FolderFile.detail` in `GlassFolder` instead of the decorative `.gf-lines` bars; the "View all N sessions →" link stops its own pointerdown from reaching the folder's outside-click closer, so it no longer unmounts before click
- status: done
- evidence: full gate green — `tsc` clean, `biome` 193 files (4 pre-existing useLiteralKeys infos in untouched checks-v2.test.ts), `pnpm test` → 49 files / 406 passed + 8 skipped, `pnpm build` ok (web + server + cli); headless-Chrome CDP probes: pre-fix repro (3/3 sheets `.gf-lines`, synthetic + real mousePressed both unmounted the link, no navigation), post-fix (0 `.gf-lines`, real detail text on all sheets, real click navigates to /projects/:id/overview, outside click + Escape still close, Portfolio folder renders 2 detailed sheets)
- notes: Root causes: sheets without art/image always rendered fake skeleton bars; the conditionally-rendered link sat outside the folder root so the document pointerdown closer fired first. Placeholder bars kept as fallback for detail-less files. UI exempt from vitest by repo rule; verified against the user's running dev servers (5173/4783) via fresh headless targets — no user processes touched. The 404 in the probe console log is pre-existing (favicon). Probe scripts kept under /tmp/echo-repro for re-runs.
## 2026-10-29 — Folder hover-preview + front-hit navigation

- item: `ProjectFolderCard` hover/focus preview (150ms delayed open, fetch race guarded by wantOpen/fetching refs, touch pointer events ignored, native listeners to stay lint-clean) + `GlassFolder` `onHitActivate` (front-panel click navigates to the project instead of toggling; `more` menu keeps explicit Open item; aria-label switches to "Open <label>")
- status: done
- evidence: full gate green — `tsc` clean, `biome` 193 files clean (4 pre-existing useLiteralKeys infos, untouched files), `pnpm test` → 49 files / 406 passed + 8 skipped, `pnpm build` ok; browser pass via own stack (temp data dir from a real-sqlite copy, ECHO_MODEL=off, ports 4783/5173, fresh headless targets, processes reaped after): hover opens Portfolio folder with 2 detailed session sheets + "View all 2 sessions →" (screenshot), front-hit click navigates to /projects/:id/overview, touch pointerenter leaves folder closed, enter+leave inside 150ms leaves it closed
- notes: Headless Chrome reports no hover device, so the hover golden ran with only the `matchMedia('(hover: hover)')` environment query stubbed — component code under test untouched. UI exempt from vitest by repo rule. eval/muse-fixture result.json/report.md regenerated by the suite run (timestamps/ids only). Probe scripts + screenshots under /tmp/echo-verify (removed chrome profiles, kept scripts/shots for re-runs).
## 2026-10-29 — Addendum: independent re-verification of hover-preview slice + pre-existing ingest failure

- item: re-ran the full gate and an independent browser pass over the landed hover-preview/`onHitActivate` code (no code changes made); surfaced a pre-existing ingest failure for the backlog
- status: done
- evidence: `tsc` clean, `biome` clean (4 pre-existing useLiteralKeys infos), `pnpm test` → 49 files / 406 passed + 8 skipped, `pnpm build` ok; headless-Chrome CDP probe (`/tmp/echo-repro/slice-d-probe.mjs`, real trusted pointer events, only the headless-false hover media query stubbed): folders render, hover opens the echo folder with 3 detailed session sheets (date·model / check / capture lines, 0 placeholder bars), pointer-leave closes, `more` menu keeps Open/Close and toggles, front-hit click navigates to `/projects/:id/overview`
- notes: No user processes were reusable (user's vite was down and their daemon alive-but-not-listening on arrival), so the pass ran on an isolated stack — `VACUUM INTO` snapshot of the real sqlite into `/tmp/echo-repro/eda`, `ECHO_MODEL=off`, stock ports — reaped afterwards; user daemon process left exactly as found. Observed (not introduced, not fixed — out of slice scope): both the snapshot daemon and the earlier shared-DB run log `UNIQUE constraint failed: projects.canonical_root` on every ingest poll (`ingest failed` / `muse ingest failed`), single writer included, so the project upsert is not idempotent — candidate for the next capture-hardening slice. The 404 in probe logs is the pre-existing favicon.
## 2026-10-29 — Folder hover-preview + click-to-open-sessions (implement + verify)

- item: implemented the requested swap this session — hover/focus previews the folder (150ms delayed open, fetch-once with in-flight guard, touch ignored, native listeners), front-panel click/tap navigates to `/projects/:id` (overview = all sessions) via new `GlassFolder` `onHitActivate`; touch preview via the `···` menu (user chose tap-navigates-directly over two-tap); keyboard focus previews with focus retention across the load remount; phantom leave/enter from DOM churn guarded; stabilized open handler so listener re-subscribe can't drop a mid-flight hover timer; fixed a pre-existing stuck-failed flag on refetch
- status: done
- evidence: full gate green → `tsc` clean, `biome` 193 files (4 pre-existing useLiteralKeys infos in untouched `checks-v2.test.ts`), `pnpm test` → 49 files / 406 passed + 8 skipped, `pnpm build` ok; headless-Chrome CDP suite (24 checks, all passing): hover open/close, 2 sheets + view-all link, mid-fetch hover flutter = 1 request, click → overview with session list, real Tab focus + preview + Enter navigation, touch matrix (menu key opens menu without preview, Open-folder previews, outside closes, body tap navigates), zero page errors, zero failed API requests; screenshots reviewed (`/tmp/echo-hover/*.png`, uncommitted)
- notes: Overlap flag — the two entries directly above describe this same uncommitted implementation (same identifiers: `onHitActivate`, `wantOpen`/`fetching` refs, 150ms, native listeners): one framed as the change, one as re-verification with no code changes. No code of mine was overwritten (working-tree diff verified byte-identical to this session's edits); their probes constitute independent verification of this unit. Harness notes: alt ports + copied data dir + `ECHO_MODEL=off` (a concurrent stack held 4783/5173; never touched); headless media gaps corrected harness-side only (matchMedia hover shim, focus emulation — shipped code reads the standard APIs); all probe processes reaped. Pre-existing observations, untouched: `BACK_PATH` top-right arc in `glass-folder-cards.tsx` looks garbled (landed in 4fb176e; folders render fine at UI size); the 4 lint infos belong to another author's test file. `eval/muse-fixture` stamps regenerated by suite runs (timestamps/ids only).

## 2026-10-29 — Remote sync (merge 0ee82b1, liquid nav + story pill)

- item: merged remote `0ee82b1` (2 commits: liquid-glass navbar, shared ProjectNavPill) into local (7 commits: glass folder cards, hover-preview, front-hit navigation); code sides touched disjoint files so the merge is a clean union; BuildTracker concatenated chronologically (remote 10:41–10:45 entries first, local 12:25–14:04 after, both byte-identical); eval stamps taken from ours then regenerated by the suite
- status: done
- evidence: post-merge gate green — `tsc` clean, `biome` 195 files (4 pre-existing useLiteralKeys infos in untouched checks-v2.test.ts), `pnpm test` → 49 files / 406 passed + 8 skipped, `pnpm build` ok (web + server + cli)
- notes: Merge left open (uncommitted) per user-owns-history. Uncommitted worktree edit to `project-folder-card.tsx` (rAF open timing) predates the merge — left untouched and unstaged. Flag: `origin/main` advanced ~25 commits mid-merge (code-index feature through `5533902`); a second pull is needed after this merge lands.
## 2026-10-29 — Folder first-hover no longer drops in (smoother variant)

- item: `ProjectFolderCard` ready remount renders closed with `appear={false}` then lifts to open over two rAFs, so the first preview rises from inside the pocket instead of replaying the scroll-in drop (`translate 0 -120px / opacity 0`); close clears pending refocus so a leave mid-load can't steal focus later
- status: done
- evidence: full gate green → `tsc` clean, `biome` 195 files (4 pre-existing useLiteralKeys infos in untouched `checks-v2.test.ts`), `pnpm test` → 49 files / 406 passed + 8 skipped, `pnpm build` ok; headless Chrome vs own dev stack (5173/4783, processes reaped, ports closed after): 2 folders render, first hover → entered=true open=true with 2 sheets at opacity 1 / translate none, leave → closed, re-hover → open again
- notes: UI-only (`apps/web/src/components/project-folder-card.tsx`); `glass-folder-cards.tsx` untouched — entrance still plays for true first paint, only the data-load remount skips it. Pre-existing ingest `UNIQUE constraint failed: projects.canonical_root` poll errors observed on the dev daemon, untouched.

## 2026-10-29 — Dusk-system nav pill (liquid removed)

- item: replaced the vendored Nimbus liquid-glass navbar with a native dusk-system `ProjectNavPill` (sliding active indicator in Animate-UI style, compact `px-3 py-1.5 text-[13px]` tabs, HugeIcons kept); deleted `apps/web/src/components/ui/liquid-glass-navbar.tsx`
- status: done
- evidence: full gate green → `tsc` clean, `biome` 192 files clean (4 pre-existing infos), `pnpm test` → 49 files / 414 passed, `pnpm build` ok; built web bundle carries the pill and no `nimbus-nav` remains
- notes: Indicator is a measured absolute span gliding via `transition-[left,top,width,height,opacity]` with `cubic-bezier(0.32,0.72,0,1)` + `motion-reduce:transition-none`; re-measured on active change via ResizeObserver. Story page still renders the pill with no highlight (`active={-1}`). Restart `pnpm dev` + hard-refresh to see it.

## 2026-10-29 — Central project code index (central substrate, code half)

- item: one derived rebuildable code index every section queries — contracts `code.ts` (files/symbols/edges/state + query responses), migration v7 (`code_files`/`code_symbols`/`code_edges`/`code_index_state`), db repositories + tests, `@echo/graph` inventory (snapshot-ignore walk, hashing, caps, stack detection) + oxc-parser file parser (module-record imports/re-exports/dynamics, top-level symbols, require walk, deterministic sym_ ids, resolved provenance) + tests, server service (hash-compared reindex, lazy refresh on read, BFS graph) + 6 routes (`GET code`, `POST reindex`, `GET files/symbols/file/graph`); ADR 0013 + tooling spike `docs/spikes/2026-10-29-code-index-tooling.md`
- status: done
- evidence: full gate green → `tsc` clean, `biome` 201 files clean (4 pre-existing infos), `pnpm test` → 53 files / 435 passed, `pnpm build` ok; live-daemon probe on alt port indexed this repo (240 files, 1261 symbols, 667 edges, ~2s cold) with correct symbol/graph/404/400 shapes
- notes: oxc-parser chosen over ts-morph per spike (TS 7 ships no API; ts-morph bundles its own TS 6; oxc has prebuilt NAPI binaries, zero build approval). Runtime corrections found by probe, not docs: export moduleRequest lives on entries and is undefined (not null) for locals; string literals surface as `Literal`. Vectors deferred (sqlite-vec fits when an eval set demands it); per-file incrementality deferred (whole-project replace keyed by files_hash). db.test.ts version pins moved 6→7. Next units, not started: agent-touch→code joins, persistent code FTS, step segmentation for the Activity timeline.

## 2026-10-29 — Overview sidebar layout

- item: project Overview restructured into a left summary rail (`lg:grid-cols-[300px_minmax(0,1fr)]`, sticky `aside` with Purpose + Current-state cards) with the Agent sessions list beside it; stacks vertically on mobile; Learn/Architecture untouched per user call
- status: done
- evidence: full gate green → `tsc` clean, `biome` 201 files clean (4 pre-existing infos), `pnpm test` → 53 files / 435 passed, `pnpm build` ok
- notes: Same copy/data, new arrangement — stats became label/value rows for the narrow rail, root path wraps (`break-all`). No API/capture changes.

## 2026-10-29 — Page max-width restored (7xl)

- item: restored a centered page constraint at `max-w-7xl` (1280px, one step up from the old `max-w-6xl`) on the header inner row and `main` in `apps/web/src/layout.tsx`
- status: done
- evidence: `tsc` clean, `biome` clean, `pnpm build` ok (class-only change; full test suite last green 53 files / 435 passed)
- notes: Supersedes the full-width call for page Frankenstein ultra-wide stretch; sidebar + sessions grid now sits inside the wider container.

## 2026-10-29 — Project header trim + name normalization

- item: project header slimmed to a `← Projects` back link + `Project - <Name>` title (generic "Project workspace" eyebrow and filler description dropped); new `displayProjectName` helper (`apps/web/src/project-display.ts`: stored name → repo-dir basename → id, de-slugged + title-cased) used in `ProjectLayout` and the projects list cards; `ScaffoldPage` `eyebrow`/`description` now optional with an optional `back` link slot
- status: done
- evidence: full gate green → `tsc` clean, `biome` clean (4 pre-existing infos), `pnpm test` → 53 files / 435 passed, `pnpm build` ok
- notes: "echo" renders as "Echo"; root-path fallback in project cards replaced by the pretty name (root still shown as mono sub-line). No API/capture changes.

## 2026-10-29 — Project breadcrumb header

- item: project header collapsed to a single breadcrumb row (`← Projects / Echo`, name as the page `h1` with `aria-current`); "Project -" prefix and two-row stack gone; `ScaffoldPage` gains a `breadcrumb` header mode (replacing the one-off `back` slot), other pages unchanged
- status: done
- evidence: full gate green → `tsc` clean, `biome` clean (4 pre-existing infos), `pnpm test` → 53 files / 435 passed, `pnpm build` ok
- notes: Content starts higher; document outline keeps a single `h1`. No API/capture changes.

## 2026-10-29 — Sidebar stat polish

- item: Current-state card restyled — hairline-divided stat rows with tabular numbers, high-risk count in `dusk-fail` when non-zero, checked-coverage bar (checked/total, `dusk-pass` on `dusk-track`, same width-transition motif as the verification panel), and a last-activity line from the already-fetched project summary
- status: done
- evidence: `tsc` clean, `biome` clean (4 pre-existing infos), `pnpm build` ok; `pnpm test` → 53 files / 435 passed on a clean pass (one run showed 5 unrelated flakes in `packages/sandbox` timing tests, green on targeted rerun 28/28)
- notes: UI-only (`project-overview.tsx`). No API/capture changes.

## 2026-10-29 — Sidebar restraint pass

- item: reverted the coverage bar, last-activity line, and divided rows from the previous polish — Current-state card is now a compact 2×2 stat grid (number over micro label, tabular numbers, high-risk in `dusk-fail` when non-zero); dropped the static "Main features under review" filler line, kept the project-specific Stack line
- status: done
- evidence: `tsc` clean, `biome` clean (4 pre-existing infos), `pnpm build` ok (UI-only, no test surface)
- notes: Net less content than before, per user call.

## 2026-10-29 — Remote sync (merge 5533902, code index + dusk UI)

- item: merged remote `5533902` (25 commits: central code index with oxc parser, dusk-system nav pill, overview sidebar, header/breadcrumb, display names) into local (merge #1 + folder rAF smoother); 4 conflicts resolved — `projects.tsx` kept local folder grid with remote's `displayProjectName` applied to the folder label, tracker concatenated (local block then remote's 8 entries, both byte-identical), eval stamps regenerated by the suite; remote's LiquidNavbar deletion + pill rewrite auto-merged with zero dangling imports (`active={-1}` still supported)
- status: done
- evidence: post-merge gate green — `tsc` clean, `biome` 204 files (4 pre-existing useLiteralKeys infos in untouched checks-v2.test.ts), `pnpm test` → 53 files / 427 passed + 8 skipped, `pnpm build` ok (web + server + cli); `pnpm install` pulled `oxc-parser` (prebuilt NAPI, no approval needed)
- notes: Merge left open (uncommitted) per user-owns-history. Trade-off: remote's link-card sub-lines (root path, remoteUrl, session counts) stay dropped — folders show name/sessions/activity only, per the earlier local call. Inbox folder titles now render through `displayProjectName`, same as the overview header.

## 2026-10-29 — AI project tech stack + purpose

- item: per-project `GET /api/projects/:id/tech-stack` (read-through cache, model-curated `{purpose, items[<=8]}` with kind enum language/framework/build/data/infra, deterministic skeleton fallback, redaction gate on persist, new `project_artifacts` table via migration v8); endpoint ensures the code index inline so existing projects backfill on first view; sidebar reads it live — Project summary card shows the AI purpose, Tech stack block lists items with kind icons, hidden while pending/on 503
- status: done
- evidence: full gate green → `tsc` clean, `biome` clean (4 pre-existing infos), `pnpm test` → 54 files / 443 passed, `pnpm build` ok; new service tests 7/7, contract schema bounds test, db migration version list updated to v8
- notes: Model drafts must trace every item to detected signals (frameworks/languages/top imports) or they are dropped; empty/invented drafts fall back to skeleton. First Overview visit on an unindexed project pays one local tree walk, then caches on the code-index files hash. No capture changes.
## 2026-10-29 — Muse sessions missing: root/remote identity split + stranded checkpoints

- item: `upsertProject` now converges on one row per repo (`packages/db/src/repositories.ts` returns the canonical id: existing `canonical_root` wins and absorbs the remote, else existing `remote_url` wins on folder moves, else insert; id-conflict path preserves a stored remote when the new write omits it) and all ingest call sites use the resolved id for sessions/tapes/shadow paths (`apps/server/src/ingest.ts`, `apps/server/src/muse-ingest.ts` spool + scan, `packages/capture-muse/src/import.ts`); archived the orphan `projects/prj_57257f…` dir to `/tmp/opencode/echo-orphan-prj_57257f-backup`
- status: done
- evidence: full gate green → `tsc` clean, `biome` 207 files (4 pre-existing `useLiteralKeys` infos in untouched `checks-v2.test.ts`), `pnpm test` → 54 files / 437 passed + 8 skipped, `pnpm build` ok, `eval/muse-fixture` green; live DB: 0 → 9 muse rows under `prj_6e4d…` (echo 13 → 48 sessions), echo row gained `remote_url=github.com/DammyCodes-all/echo`; `GET /api/projects/<echo>/sessions` 200 with muse ids; headless Chrome: Echo folder hover opens with 3 real session sheets, Portfolio opens likewise
- notes: Root cause was a mid-life remote appearance: repo gained `origin https://github.com/DammyCodes-all/echo` so identity flipped root-hash `prj_6e4d…` → remote-hash `prj_57257f…`; `upsertProject` only handled `ON CONFLICT(id)`, so the `canonical_root` UNIQUE throw aborted every ingest poll *after* reader checkpoints advanced — 7 sessions sat at EOF with no session/event rows and never retried, and opencode ingest was silently broken the same way (15 → 31+ sessions after the fix). No checkpoint reset was needed: the live daemon picked up the fix via tsx watch and re-ingested on the next polls. Drive-by: one-line `_service` rename for a committed unused binding in `apps/server/src/project-tech-stack.test.ts` (another author's file, zero behavior change) so the gate passes; formatter-only pass on the 5 touched files. Uncommitted web restyle in the tree (`REST_PEEK`, rest-lift CSS, grid) is not mine and untouched. Low-count sessions (0–2 events on some fresh muse logs) are parser coverage, out of scope.
## 2026-10-29 — Header top margin

- item: app header (`apps/web/src/layout.tsx`) gets `mt-4` so the Echo wordmark and settings gear sit 16px below the viewport top
- status: done
- evidence: full gate green → `tsc` clean, `biome` 208 files (4 pre-existing `useLiteralKeys` infos), `pnpm test` → 54 files / 437 passed + 8 skipped, web build ok; headless Chrome: `header.getBoundingClientRect().top` = 16, computed `margin-top` = 16px
- notes: UI-only, single Tailwind class. HMR picked it up on the running dev server; no other layout touched.
## 2026-10-29 — Header settings menu (glass, Echo-scoped)

- item: settings entry in `AppLayout` header (`apps/web/src/layout.tsx` + new `apps/web/src/components/settings/settings-sheet.tsx`): gear trigger (`Settings01Icon` via `@hugeicons/react`, no new deps) opening a Dusk-glass dropdown (`blur(22px) saturate(1.5)`, `rounded-dusk-card`, hairline border) that degrades to a bottom sheet with scrim under 640px; contents filtered to real Echo settings — daemon status dot (ready/degraded/offline from `GET /api/health`), captured-repositories row (live `GET /api/projects`), copy-enable-command, Motion Full/Reduced segmented control (localStorage `echo-motion`, defaults to media query, sets `data-echo-motion` kill-switch), copy-support-info (version/mode/repo count, no secrets); dropped from the paste: Profile/Billing/plan/avatar, light/dark/system theme (Dusk is dark-only), presence statuses, Sign out. Full menu keyboard pattern (ArrowUp/Down/Home/End, Left/Right in group, wrap-around, Escape/Tab close + focus return, focus-in only on user intent, outside-pointerdown close, scroll lock for sheet).
- status: done
- evidence: full gate green → `tsc` clean, `biome` 208 files (4 pre-existing `useLiteralKeys` infos in untouched `checks-v2.test.ts`), `pnpm test` → 54 files / 437 passed + 8 skipped, `pnpm build` ok; browser pass (playwright-core + system Chrome, user's live dev stack — HMR served the new code, no user processes touched): click opens panel, ArrowDown focuses Repositories, Escape closes + focus returns to trigger, wrap-around nav, Reduced radio persists `echo-motion=reduced`, zero page errors; 360px viewport renders bottom sheet, scrim tap closes; screenshots `/tmp/opencode/settings-desktop-open.png`, `/tmp/opencode/settings-mobile-sheet.png`
- notes: No `motion`/`lucide-react` install (CSS transitions + existing HugeIcons); missing `user-menu.module.css` from the paste recreated as Dusk tokens, not ported; web-only, no API/capture/contract changes; UI exempt from vitest by repo rule. Concurrent session added header `mt-4` on top of this unit's `layout.tsx` edit — no conflict, both kept. Playwright-core lives in `/tmp/opencode/pw` (repo untouched); daemon port was held by the user's own daemon so the temp-dir daemon exited EADDRINUSE and the pass ran against real data.
## 2026-10-29 — Header top margin mt-4 → mt-5

- item: app header (`apps/web/src/layout.tsx`) bumped to `mt-5` per user request
- status: done
- evidence: `tsc` clean, `biome` 208 files (4 pre-existing infos), `pnpm test` → 54 files / 437 passed + 8 skipped; headless Chrome: header top = 20px
- notes: Single-class follow-up to the mt-4 entry above.
## 2026-10-29 — Settings pointer cursors

- item: `cursor-pointer` on the settings gear trigger (`apps/web/src/components/settings/settings-sheet.tsx`) + pointer rule for menu rows and Motion radios in both panel and sheet variants
- status: done
- evidence: `biome` clean on the file, `tsc` clean; headless-Chrome computed-style check: trigger `pointer`, row `pointer`, radio `pointer`
- notes: Class/CSS-only. Nothing staged or committed.
## 2026-10-29 — Settings popover open animation

- item: settings dropdown open motion switched to popover-style (`apps/web/src/components/settings/settings-sheet.tsx`, CSS-only): 150ms ease-out fade + zoom from 95% + 4px slide down from the trigger edge, origin top-right — matching the Radix/Animate-UI popover feel from the pasted reference (Vue + Animate-UI pastes not portable: React codebase, no `@animate-ui/react`/`cn`/shadcn deps installed); spring overshoot removed; mobile sheet keeps its own rise
- status: done
- evidence: `biome` clean on the file, `tsc` clean; headless-Chrome computed style confirms `echo-settings-in` at 0.15s, settled panel screenshot clean, zero page errors
- notes: Nothing staged or committed.
## 2026-10-29 — Settings leave animation

- item: settings dropdown/sheet now animates closed as well as open (`apps/web/src/components/settings/settings-sheet.tsx`): `leaving` state holds the panel 140ms while `echo-settings-out` (fade + zoom to 95% + rise 4px) / `echo-settings-sheet-out` (fade + slide down 12px) / scrim fade-out play, then unmounts and returns focus; every dismiss path (Escape/Tab, scrim, outside press, trigger toggle, Repositories navigate-after-close) goes through `requestClose`, instant when reduced-motion is preferred, second close skips ahead, trigger click mid-leave cancels the exit and stays open
- status: done
- evidence: full gate green → `tsc` clean, `biome` 210 files (4 pre-existing `useLiteralKeys` infos in untouched `checks-v2.test.ts`), `pnpm test` → 55 files / 439 passed + 8 skipped, `pnpm build` ok; browser pass (playwright-core + system Chrome, live dev stack): Escape/outside/scrim dismissals all show `data-leaving` + exit keyframes with unmount at ~150–170ms and focus back on the trigger, mid-leave trigger click stays open; zero page errors
- notes: Mechanical `biome check --write` import-sorts on two concurrent-session files (`apps/server/src/index.ts`, `apps/server/src/muse-ingest.ts`) to restore the green gate — ordering only, their `ensureEnabledProjects` logic untouched. Probe scripts in `/tmp/opencode/pw` (`leave_verify*.mjs`, `leave_debug*.mjs`). Nothing staged or committed.
## 2026-10-29 — Empty projects get folders (allowlist reconcile + no-sessions note)

- item: new `ensureEnabledProjects` (`apps/server/src/enabled-projects.ts` + colocated test) materializes every enabled repo as a project row; wired into daemon boot (`index.ts`), each opencode poll (`ingest.ts`) and each muse poll with a fresh allowlist read (`muse-ingest.ts`, which previously pinned the boot-time list); `ProjectFolderCard` shows "No sessions yet — run a Muse or OpenCode session in this repo to capture one." when open with zero files and hides the "View all 0 sessions" link
- status: done
- evidence: full gate green → `tsc` clean, `biome` 210 files (4 pre-existing `useLiteralKeys` infos), `pnpm test` → 55 files / 439 passed + 8 skipped (incl. 2 new reconcile tests), `pnpm build` ok; live probe with throwaway `/tmp/echo-empty-probe` repo: `GET /api/projects` returned it with `sessionCount 0`, browser showed its card ("0 sessions") and hover opened it with the note visible; probe row + config entry fully reverted afterwards (config byte-identical, whitespace entry the user enabled kept)
- notes: Side effect proving the earlier identity fix: the user's newly enabled `whitespace` repo materialized on the next poll as `prj_276624f…` with its remote filled and `0 sessions`, and Portfolio backfilled its remote (2 → 7 sessions as opencode ingest recovered). Muse sessions in a brand-new repo still need a daemon restart (muse scan's ingestion allowlist is boot-time; only the folder row is restart-free) — noted, not changed. Drive-by kept to the earlier `_service` rename; uncommitted web restyle in the tree is another author's and untouched.
## 2026-10-29 — Project grid 3-up + folder peek sliver

- item: projects grid is 3-up at xl / 2-up at md / 1-up base with `justify-between` (`apps/web/src/routes/projects.tsx`); closed folders peek one blank sheet above the pocket (`--gf-lift` rest value in `glass-folder-cards.tsx`, `REST_PEEK` pre-load sheet in `project-folder-card.tsx` when `total > 0`) with head/detail/lines faded to opacity 0 until open (new rest-fade CSS rule)
- status: done
- evidence: full gate green → `tsc` clean, `biome` 210 files (4 pre-existing `useLiteralKeys` infos in untouched `checks-v2.test.ts`), `pnpm test` → 55 files / 439 passed + 8 skipped, `pnpm build` ok; headless-Chrome probes (playwright-core + system Chrome, user's live dev stack, only the headless-false hover media query stubbed): grid tracks 3/2/1 at 1440/800/390px with space-between/center justification, 3-folder row screenshot (Echo/Portfolio/Whitespace), peek measured +8.4px above the front rim with head opacity 0, zoomed A/B (sheet forced hidden vs rest) proves the sliver reads as its own edge, 0-session folder renders 0 sheets (no peek), hover fans 3 sheets with real detail + 1 API call, leave closes, front click and keyboard Enter both reach `/projects/:id/overview`, focus previews with 3 sheets, zero page errors throughout
- notes: Resumed from session `01a187c9` (died on a provider network failure mid-verification; todo + probe state recovered from its log). Two user steers honored en route ("a little too high", "just a small part visible"): the inherited `-6px` measured 12.3px *below* the rim (invisible — the trim had overshot), `-20px` gave a 1px hairline lost at 3x zoom, shipped `-28px` (+8.4px sliver, crisp edge, no detail). Concurrent session committed this unit's files as they landed (`aabd620` grid, `e3a0d72` REST_PEEK, `5bd1469` lift) plus their own staged empty-state note on the same card (verified untouched by this unit). One transient `tsc` red mid-gate was concurrent-edit churn (clean before and after; this unit's final edit is a CSS string literal). Probe scripts + screenshots under `/tmp/echo-grid2` and `/tmp/opencode/pw` (`grid-probe`, `rim`, `rim-ab`, `final`); temp sqlite snapshot `/tmp/echo-grid2/eda` unused after the user's own stack came up (their processes never touched; my stillborn daemon reaped). Nothing staged or committed by this session.
## 2026-10-29 — Constrain empty-folder note width

- item: "No sessions yet" note in `ProjectFolderCard` gets `max-w-80 text-center` so it wraps inside its own grid column instead of stretching the row and displacing sibling folders
- status: done
- evidence: `tsc` clean, `biome` 210 files (4 pre-existing infos), `pnpm test` → 55 files / 439 passed + 8 skipped, web build ok; headless Chrome at 1600px: folders at x=184/640/1096 (uniform pitch, whitespace open), screenshot shows the note wrapped in two centered lines under its folder
- notes: Single-class follow-up; no behavior change.
## 2026-10-29 — Settings trigger debadged

- item: settings gear is now a bare icon button — removed the `bg-dusk-secondary` pill + hairline border from the trigger in `apps/web/src/components/settings/settings-sheet.tsx`; icon sits directly on the header in `dusk-muted`, brightening to `dusk-ink` on hover, focus ring unchanged
- status: done
- evidence: `biome` clean on the file, `tsc` clean; headless-Chrome close-up screenshot confirms gear with no background
- notes: Class-only. Nothing staged or committed.
## 2026-10-29 — Overview sessions as individual cards (folder-item shape, dusk surface)

- item: project overview "Agent sessions" list restyled from a divided row list to a 2-up grid of standalone `SessionCard`s (`apps/web/src/components/session-card.tsx`, new; `apps/web/src/routes/project-overview.tsx` rewired) — title (2-line clamp) + short-time · events meta + the existing check/high-risk/capture pills; first pass copied the folder sheet's neutral-gray gradient verbatim and clashed with the dusk surfaces, so the landed card keeps the folder item's shape on `bg-dusk-surface` with a 20px radius, drops the noisy full model string from the meta line, and pins badges to the card bottom
- status: done
- evidence: `tsc` clean; `biome` exit 0 (1 pre-existing warning + 4 pre-existing infos in untouched server test files); `pnpm test` → 442 passed + 1 sandbox `detectBackends` memoization timeout under 54-worker parallel load, 28/28 green on isolated re-run (flaky under load, untouched by this web-only change); `pnpm build` ok (web + server + cli)
- notes: UI is vitest-exempt, so no new tests. No browser available here (no headless binary; user's own dev servers on 5173/4783 left untouched) — verified via typecheck + lint + build; the user's live dev server picks the restyle up via HMR. Concurrent-session files (`apps/server/src/index.ts`, `apps/web/src/api.ts`, contracts, eval stamps) and their BuildTracker lines left alone.

## 2026-10-29 — Heal code_edges.id on shipped databases (v9)

- item: migration v9 `ADD COLUMN code_edges.id` (heal-forward for the code-index landing's in-place v7 edit: live DBs created without the column broke every reindex/tech-stack call with `no column named id`); runner's ADD COLUMN skip already covers fresh DBs — SQL kept comment-free so the skip regex matches; live `~/.local/share/echo/echo.sqlite` healed in place; db migration version pins updated
- status: done
- evidence: `pnpm exec vitest run packages/db` → 3 files / 25 passed; full `pnpm test` → 54 files / 443 passed; `tsc` clean; `biome` clean; `pnpm build` ok
- notes: Root cause of the tech-stack 503s on existing projects, found by curling the endpoint (`code_index_missing`) then the reindex route (500 `no column named id`) and confirming via PRAGMA table_info. Daemon was down at diagnosis end — owner restarts it; v9 applies on boot.

## 2026-10-29 — Web loading states → skeleton loaders

- item: shared `Skeleton`/`SkeletonLines`/`SkeletonCard` (`apps/web/src/components/skeleton.tsx`); skeleton replacements for projects grid, architecture table, project-overview sessions grid + project-location bar, project-layout title, story page + check section, ask-thread bubbles, check-offer generating state; check-runner/verification-panel button texts kept as pending affordances
- status: done
- evidence: `pnpm typecheck` clean; `pnpm lint` clean on touched web files (1 pre-existing warning in server tech-stack test, untouched); `pnpm test` → 54 files / 443 passed; `pnpm build` ok; grep-clean of plain "Loading…" page states (4 remaining hits are button/progress texts: Asking…/Checking…/Starting…)
- notes: Three parallel subagents with disjoint files (skeleton+projects+architecture / overview+layout / story+ask+check-offer); overview+layout and story slices inlined skeleton divs instead of importing the in-flight shared component — follow-up could migrate them to `Skeleton*` imports. No browser pass (same constraint as prior web entries); verified via bundle build + source grep. Stage and commit nothing.

## 2026-10-29 — Ingest survives remote-add identity change + per-session isolation; stack agent reads README

- item: `ensureIngestProject` in `packages/db` (same root keeps its historic id when a remote appears, same remote adopts a moved root, truly new repos insert; one row per repository) wired into all three project-registration sites (`apps/server` opencode `ingest.ts`, muse spool drain + log scan in `muse-ingest.ts`); per-session try/catch in both scan loops so one poison session logs and skips instead of aborting the whole poll; stack/purpose prompt now gets bounded repo docs (`README.md` excerpt 1500 chars + `package.json` description 500 chars, best-effort, redaction-gated)
- status: done
- evidence: full gate green → `tsc` clean, `biome` clean (4 pre-existing infos), `pnpm test` → 54 files / 451 passed (new: 3 db migration-shape tests, 2 ingest regression tests incl. remote-appears + poison-session isolation, 3 repo-docs tests), `pnpm build` ok; live proof: echo project ingested 8 → 31+ sessions after daemon auto-reload, single project row kept (`prj_6c57…`, remote recorded), no second row
- notes: Root cause of the 8-session freeze: adding the GitHub remote changed the derived project id (hash of remote ?? root), so every poll crashed on `UNIQUE(canonical_root)` on the first new session and ingested nothing — confirmed by running the scan and watching it throw. Muse path had the identical latent crash at both its registration sites. Daemon picked the fix up via `tsx watch` reload, no restart needed. Session-card.tsx churn in the diff is parallel-landing work, untouched except a biome format pass.
## 2026-10-29 — SessionCard trim: relative time, quiet default, no capture/event meta

- item: `apps/web/src/components/session-card.tsx` trimmed per review — absolute start time replaced with relative `timeAgo` ("just now", "N min ago", "N hrs ago", "N days ago", short date past a week; exact timestamp kept as hover title), `not_checked` renders no badge (only Checked green / Skipped muted pills remain), capture-state pills (recording/partial) and the event count dropped from the card; badgeless cards omit the badge row entirely
- status: done
- evidence: `tsc` clean; `biome` exit 0 on touched files (2 warnings + 4 infos repo-wide, all in untouched concurrent files); `pnpm test` → 54 files / 451 passed; `pnpm build` ok (web + server + cli)
- notes: UI is vitest-exempt, no new tests. A first gate attempt in this window showed 1 failed + 8 skipped, then a SIGKILL — re-run on the settled tree is fully green (a concurrent session is editing server tests mid-flight; counts shifted 448 → 451 between runs). Recording state is now carried only by the "Still recording — story pending…" title fallback; capture/event detail lives on the story page. No browser here; user's live dev server picks it up via HMR.

## 2026-10-29 — Stale-while-revalidate tech stack with change gate + lastActivity type completion

- item: per-project tech-stack endpoint serves the previous artifact as `stale` while regeneration is change-gated (≥3 detected code-index changes AND ≥10 min artifact age; background single-flight regen, 30s web poll to converge); first view still generates inline with skeleton fallback only when nothing exists; failures/backoff keep the previous artifact, never downgrade to skeleton; migration v10 `project_stack_state` + repo helpers; redacted README/package.json prompt context; completed the parallel `lastActivity` unit by adding the missing `lastActivity: string` field to the db `SessionSummary` interface (SQL, mapper, contracts schema, and test already assumed it)
- status: done
- evidence: full gate green → `tsc` clean, `biome` clean (2 pre-existing warnings, 4 infos), `pnpm test` → 54 files / 458 passed, `pnpm build` ok; live proof earlier: echo project ingested backlog with historic id kept, no second row; endpoint returned model-generated purpose with new prompt
- notes: Regen gate bounds model cost during active editing (every save moves the files hash). Route needed no change (returns any non-error stack). The `lastActivity` completion is one interface line; parallel session owns the test. Daemon picked up server changes via `tsx watch` reload.
## 2026-10-29 — SessionSummary.lastActivity (last recorded event, tested)

- item: card time is now genuinely last activity — `SessionSummary` gains required `lastActivity` (`packages/contracts/src/api.ts`), `listSessions`/`getSessionSummary` compute `COALESCE(MAX(events.observed_at), sessions.updated_at)` (no migration; `updated_at` covers event-less sessions and is NOT NULL), both contract fixtures updated; `SessionCard` + `/`-route folder preview read `lastActivity` instead of `startedAt`. Was session start: a still-recording session showed a stale start time. Ordering stays `updated_at DESC` (inbox "recently touched" semantics, incl. check/story writes — changing it is a separate product call).
- status: done
- evidence: new `db.test.ts` case watched red before the fix (undefined), green after — out-of-order inserts prove MAX, fixed-`updated_at` session proves the fallback; focused `db.test.ts` + `api.test.ts` → 36 passed; full gate green (tsc, biome exit 0 with pre-existing warnings/infos in untouched files, 54 files / 458 passed, build ok)
- notes: Failing-test-first per durable-test-collateral. Mid-window noise, all environmental: a typecheck run raced a concurrent write to `repositories.ts` (re-ran green, no dupes), and one broad suite showed 6× 5s-timeout failures across 4 untouched files at load avg 25–29 with 179MB free — every one passes focused (24/24 db, 38/38 others) and the full suite is green after reboot (458/458). Concurrent files (muse-ingest, tech-stack, migrations, eval stamps) left alone.
## 2026-10-29 — SessionCard one-line footer with icons

- item: card bottom row is now time + badges on a single line — clock icon + relative time left, check/high-risk pills with icons (check-circle / skip / alert, 12px, matching Hugeicons set) right; exact timestamp moved to the time element's hover title; badgeless cards show just the time
- status: done
- evidence: covered by the same gate run as the lastActivity unit (tsc, biome, 54/458, build); UI is vitest-exempt, no new tests
- notes: No browser here; user's live dev server picks it up via HMR. Pills keep existing colors/shapes — icons only, no new chrome language.
## 2026-10-29 — Stable session order stops overview grid reshuffle

- item: `ProjectOverviewPage` sorts sessions client-side (startedAt DESC, id tiebreak, memoized) instead of taking the server's `updated_at DESC` order, which reshuffles on every ingest/story/check write and made the grid visibly jump each 5s poll; new sessions still appear at top, existing rows no longer move
- status: done
- evidence: `tsc` clean, `biome` clean on the touched file, `pnpm test` → 54 files / 458 passed, `pnpm build` ok
- notes: UI-only, no new tests. Server order untouched (history scan relies on it). If flicker persists it is a different mechanism (suspects: HMR reloads from concurrent saves, or insert-at-top as new sessions arrive) — user to confirm visually, no browser here.
## 2026-10-29 — Session inbox ordered by last activity

- item: `listSessions` orders by `last_activity DESC, s.id ASC` instead of `updated_at DESC` — most recently active session first, deterministic tiebreak; `history.ts` candidate-scan comment updated (same recency assumption, better key); overview page reverted to server order (client startedAt sort removed); folder-preview top-3 now also means most-recent
- status: done
- evidence: new order test watched red first (`ses_2,ses_3,ses_1` under old key), green after — recency beats start time + id tiebreak in one case; full gate green (tsc, biome, 54 files / 459 passed, build ok)
- notes: Only genuinely live sessions move now; story/check writes to old sessions no longer bubble them. UI is vitest-exempt; web side takes server order directly.
## 2026-10-29 — SessionCard anti-flicker stabilizers

- item: `SessionCard` memoized (unchanged rows skip re-render each 5s poll via React Query structural sharing) + title block fixed to 2-line min-height so summary swaps and 1-vs-2-line titles no longer resize cards and shift grid rows
- status: done
- evidence: `tsc` clean, `biome` clean on the file, `pnpm build` ok; test evidence is the same window's 459/459 run (delta since is this web-only file, vitest-exempt)
- notes: Poll stays 5s (recording→story freshness); not done: FLIP reorder animation, pagination/cap for large lists — offered as follow-ups if motion persists. No browser here; user confirms visually.
## 2026-10-29 — Remote sync (merge origin/main, ingest identity + skeletons + search)

- item: merged `origin/main` (`add2c5f`, 7 commits: `Skeleton` shared component + skeleton loaders across projects/architecture/overview/layout/story/ask/check-offer, `SessionCard` overview restyle, code_edges.id v9 heal) into local (16 commits); conflicts resolved — `ingest.ts` takes origin's `ensureIngestProject` mechanism over local's `upsertProject`-adopt (import block already expected it; merged `db` exports both) while keeping local's `ensureEnabledProjects` boot call and both sides' per-session poison guard (origin's try-wrap); `projects.tsx` keeps both remote skeleton loading and the stashed local search/sort toolbar (stash popped + dropped after resolution); `BuildTracker.md` concatenated; eval stamps taken from ours then regenerated by the suite
- status: done
- evidence: post-merge gate green — `tsc` clean, `biome` 211 files (4 pre-existing `useLiteralKeys` infos in untouched `checks-v2.test.ts`), `pnpm test` → 55 files / 439 passed + 8 skipped, `pnpm build` ok
- notes: Merge was blocked by an uncommitted in-flight search/sort edit on `projects.tsx` (another author's) — stashed before merging, popped and resolved after, stash dropped. One `--write` import-sort on the merged `projects.tsx`; earlier `--write` sorts on concurrent `index.ts`/`muse-ingest.ts` are ordering-only. Merge left open (staged, uncommitted) per user-owns-history; regenerated eval stamps left unstaged.
## 2026-10-29 — Projects search/filter + sort control

- item: toolbar on `ProjectsPage` (`apps/web/src/routes/projects.tsx`, client-only, no API change) — search input matching display name, root path, and remote (case-insensitive) with an "N of M projects" count line and a no-match empty state + Clear button; sort select with Last activity (default, never-active last) / Name / Sessions; toolbar hidden until projects load
- status: done
- evidence: full gate green → `tsc` clean, `biome` clean (4 pre-existing `useLiteralKeys` infos), `pnpm test` → 55 files / 439 passed + 8 skipped, `pnpm build` ok; headless-Chrome probes: name/path/remote filters each narrow correctly (`port` → Portfolio, `whitespace` → Whitespace, `DammyCodes-all` → Echo + Whitespace, `ECHO` case-insensitive), count line "1 of 3 projects", no-match state + Clear restores all, sort switching proven on live data (activity order differed from name/sessions order mid-probe as ingest advanced timestamps), zero page errors; toolbar screenshot reviewed
- notes: Merged tree keeps both this toolbar and the concurrent skeleton loading state (their merge commit `6772abc`; my edit had been stashed as "in-flight projects search-sort" and popped back intact — verified byte-identical to what I wrote). Verified on an isolated stack (fresh sqlite snapshot, daemon :4784, vite :5199, `/api` routed via playwright) because the user's daemon died mid-task (likely on the conflict-marker `ingest.ts`) and their vite followed; both were down at verify time — user needs to restart `pnpm dev`. My daemon/vite reaped afterwards; user processes never touched. Finding for the backlog (not mine, not fixed): Portfolio's `remote_url` is NULL on the live DB though the API served it earlier today — the merged ingest/upsert path appears to clear stored remotes on re-ingest; the identity-fix "preserves stored remote" guarantee may not have survived merge `6772abc`. Probe scripts `/tmp/opencode/pw/search-verify*.mjs`, screenshots `/tmp/echo-search/`. Nothing staged or committed by this session.

## 2026-10-29 — Merge origin/main (sixth divergence, ingest identity + tech-stack)

- item: merged remote `ensureEnabledProjects` boot wiring, `upsertProject` identity resolution, SettingsMenu + related web restyle, and the prior remote-sync entry into local (13 commits); conflicts in 4 files resolved — `muse-ingest.ts` keeps local `ensureIngestProject` convergence + per-session poison guard (remote `upsertProject` enhancement stays live for other callers, follow-up could unify the two), `BuildTracker.md` keeps both sides, eval stamps are the post-merge suite regen
- status: done
- evidence: `tsc` clean, `pnpm test` → 55 files / 463 passed, `pnpm build` ok; `biome` 1 error confined to a concurrent worker's unstaged `session-card.tsx` restyle (left alone) + 1 pre-existing warning (`ingest.test.ts` unused `root`) + 4 pre-existing infos
- notes: `session-card.tsx` + `project-overview.tsx` restyle and a fresh `result.json` stamp churn appeared mid-merge from concurrent runs — all left unstaged/untouched. Nothing pushed.

## 2026-10-29 — Stable session titles across regens

- item: session titles no longer shift when the session itself changes — `upsertSession` keeps the first non-empty `sessions.title` (later polls update model/directory/tape path/quality but never the title, null never clears); story summaries freeze the same way — `persistStory` reuses the first persisted summary on regen while cards/risks/gaps/watermark still refresh, with one upgrade path (skeleton fallback yields to the first real model narration), and now returns the persisted story so API responses match the artifact/DB instead of the pre-freeze draft
- status: done
- evidence: full gate green → `tsc` clean, `biome` clean (1 warning + 4 infos, pre-existing), `pnpm test` → 55 files / 467 passed, `pnpm build` ok; new coverage: db `session title stability` (freeze + null-never-clears + first-non-empty-wins), story `session title stability` (model regen keeps title while watermark advances, skeleton→model upgrades once then freezes)
- notes: Card titles (session cards, folder cards) and the story page header all read the frozen summary, so hierarchy navigation stays put. Daemon picks up server changes via `tsx watch` reload.
## 2026-10-29 — SessionCard breathing room (cramped-footer restyle)

- item: `SessionCard` footer de-jumbled — hairline divider between title and footer; badges restyled into the story-card voice (wash fill, no border, sentence case, `rounded-dusk-code px-2.5 py-1 text-xs semibold`, 14px icons); title loosened (`leading-6`, `text-pretty`, `break-words`, 3rem 2-line slot); footer `gap-x-4` + wrap fallback so a future Checked+risk pair never spills on 390px; grid `gap-4` → `gap-5`; loading skeleton mirrors the new card shape
- status: done
- evidence: full gate green (tsc clean, biome exit 0 with only the pre-existing warning + 4 infos in untouched server tests, 55 files / 467 passed, build ok); headless-chrome passes on the live dev stack — 1400px overview (footers calm, badges quiet), 390px cards (time + badge hold one line, no overflow), skeleton state matches card shape
- notes: One transient single-test failure mid-window, green on the re-runs before and after — load flake, web change is vitest-exempt. Remaining density is skeleton-summary copy (path-soup titles), a content problem for the story slice, not this card. No new chrome language; dusk tokens only.
## 2026-10-29 — Remote sync (merge origin/main, 19 behind + local identity work)

- item: merged `origin/main` into local (behind 19, ahead 1); conflicts only in the 3 append/generated files — `BuildTracker.md` keeps both sides, `eval/muse-fixture/report.md` + `result.json` taken from HEAD then regenerated by the suite. Source merged clean and is semantically coherent: origin's `ensureIngestProject` (historic-id-wins, built on the local `upsertProject` root/remote convergence) is now the single mechanism at all ingest call sites, local `ensureEnabledProjects` boot+poll wiring and the empty-folder UI survive, `COALESCE` remote guard intact
- status: done
- evidence: post-merge gate green — `tsc` clean, `pnpm test` → 55 files / 459 passed + 8 skipped (both earlier failures pass solo and full-suite on re-run: load flake, same as prior window), `pnpm build` ok (web + server + cli); fixture regen stamps from this run
- notes: Merge left OPEN (staged, uncommitted) per user-owns-history; regenerated eval stamps left unstaged. `biome` still reports 1 error in the concurrent session's in-flight untracked `apps/web/src/components/search/expandable-search.tsx` plus its unstaged `layout.tsx`/`projects.tsx` hunks — all left untouched, none mine; 4 pre-existing `useLiteralKeys` infos + 1 pre-existing `ingest.test.ts` warning as before. `ingest.test.ts` shows fresh `MM` (concurrent edits landed mid-merge). Backup branch `backup/pre-sync-*` taken before merging (unused — tree was already clean, work was committed). Live daemon was mid-restart during verification; no probe run on it — API/UI re-verify belongs to whoever restarts `pnpm dev`.
## 2026-10-29 — Header expandable search + sort (page filter row removed)

- item: 21st `arunachalam/expandable-search-bar` pulled via `get_component` (1 daily retrieval) and adapted into `apps/web/src/components/search/expandable-search.tsx` — behavior parity (collapsed icon, leftward expand to 200px, autofocus, animated placeholder hint, submit button, Enter submits, Escape closes+clears, outside press collapses an empty bar) with framer-motion/lucide/shadcn-tokens replaced by a CSS width transition, HugeIcons, and Dusk tokens (no new deps); header cluster in `apps/web/src/layout.tsx` is now [search][sort][gear]; page filter row in `apps/web/src/routes/projects.tsx` deleted — `?q=` in the URL is the single source of truth (header submit writes it, page mirrors it both ways with replace, clear button resets it); new `ProjectSort` header select drives `?sort=` (validated, `activity` default omits the param), hidden off-home
- status: done
- evidence: full gate green → `tsc` clean, `biome` 213 files (4 pre-existing `useLiteralKeys` infos in untouched `checks-v2.test.ts`), `pnpm test` → 55 files / 459 passed + 8 skipped, `pnpm build` ok; browser pass (playwright-core + system Chrome, restarted `pnpm dev` stack after finding both servers down with only the orphaned tsx wrapper alive): 40→200px expand with input autofocus, `port` submit filters to "1 of 3 projects" via `?q=`, cross-route submit lands home filtered, Escape collapses even with blurred focus, sort select visible in header, mobile 360px fits (right edge 266/360); zero page errors
- notes: Scope call made without user confirmation (projects-only, static placeholder — the two open plan questions). Borrowed page copy ("Search by name, path, or remote…") for the placeholder. One-line lint fix in concurrent `ingest.test.ts` (dropped unused `root` binding). `requestClose`-style exit animation deliberately not added — the width transition animates both directions. Probe scripts in `/tmp/opencode/pw` (`search_*.mjs`). Nothing staged or committed; dev servers left running (`pnpm dev`, pid logged in shell).
## 2026-10-29 — Overview quiet pass (compact titles, two-tone risk, borderless cards)

- item: `session-display.ts` compacts skeleton path-soup summaries to "Prompts · changes in <first path>…" (full text on hover; model prose untouched), used by `SessionCard` + `/` folder preview; risk badge two-tone — red wash only at >=5 (`HIGH_RISK_LOUD_THRESHOLD`), smaller counts stay visible as muted pills; session cards borderless at rest (`border-transparent`, hover accent kept) matching sidebar cards; skeleton mirrors the border change
- status: done
- evidence: full gate green (tsc 0, biome 0, 55 files / 469 passed, build ok); tsx probe of the compactor over 8 live summaries (soup→one line, empty/model/null untouched); headless-chrome screenshots on live dev stack — 1400px (titles one line, 1–2 counts grey, 17/21 red) + 390px (footer holds one line, no overflow)
- notes: Server summaries are frozen per session ("first persisted summary wins"), so compaction is display-time by necessity — data untouched. Tech-stack move to the Architecture tab was built then reverted per user mid-window (architecture file back to zero diff, sidebar byte-identical apart from nothing). Mid-gate `tsc` red was concurrent-session churn in `review-index.ts` (untouched by me, errors confined to that file, green once their edit settled) — waited, never touched.

## 2026-10-29 — Review build time budget (session pages load instead of hanging)

- item: `buildSessionReview` never hung on pathological sessions (186 snapshots × 251 files × 8k events spawned tens of thousands of git reads; `/review` and story regen never answered, so session pages loaded forever) — the git-bound work now runs as one budgeted pass per path (versions + per-transition diffs + baseline-to-final hunks + attempt/origin attribution), 10s default via `SessionReviewOptions.budgetMs`; unfinished paths contribute nothing (same as unreadable ones), `review_budget_exceeded` diagnostic recorded, schema-valid partial review returned; story/checks/review endpoints all inherit the bound
- status: done
- evidence: full gate green → `tsc` clean, `biome` clean (4 infos), `pnpm test` → 55 files / 472 passed, `pnpm build` ok; live proof on the two worst sessions: 186-snapshot session returns in ~8s full (11 hunks, 159 attempts), 55-snapshot session returns in ~11s partial (143 hunks, `review_budget_exceeded`) instead of hanging past 30s+; `/review` for it now 200s instead of timing out; new tests: default-budget completion without diagnostic, negative-budget deterministic degradation
- notes: Partial reviews keep hunks but may lack attempts/evidence — downstream reads that as uncertain, never proof. A single giant path can still overshoot the budget by its own cost (soft bound). Pre-existing hang, not caused by the title-freeze work. Daemon picked up server changes via `tsx watch` reload.

## 2026-10-29 — Hide sessions with no meaningful change from the sessions list

- item: `GET /api/projects/:id/sessions` now drops sessions whose story is a content-free skeleton (no cards, no asked/delivered prompts, no short version — the "No prompts recorded, no file changes recorded." cards); recording sessions (no artifact yet) and unreadable artifacts stay visible — absence of evidence is not evidence of emptiness. No contract change; project session counts untouched (captured total stays truthful, grid shows meaningful). `storyHasContent`/`filterEmptySessions` live in the story service next to the artifact code
- status: done
- evidence: full gate green (same run as above: 55 files / 472 passed); new tests: predicate unit (empty vs asked vs shortVersion vs model-always-counts), filter integration (drops empty, keeps recording + meaningful), unreadable-artifact safety (corrupt JSON + missing file both kept); live check: endpoint returns 51 sessions (no content-free skeletons exist right now, so nothing hidden — verified against DB)
- notes: Only fully-empty skeletons hide; "Prompts, no file changes" (asked something) and "changes, no prompts" both stay. If the model key returns, skeleton→model upgrade still replaces the title on next regen (title-freeze exception).

## 2026-10-29 — Agent session title as default when our story didn't run

- item: session display title is now model summary → agent session title → skeleton text → recording/empty placeholders. New `summarySkeleton` boolean on `SessionSummary` (contracts + db mapper from the story artifact generator, indexed point lookup per session, same N+1 tradeoff as capture-state) feeds a shared `sessionDisplayTitle` helper (web `session-display.ts`, keeps the parallel landing's skeleton compaction for the last-resort branch); applied to session cards, folder names, and the story page header (which reads the artifact's own `skeleton` flag + loaded session title)
- status: done
- evidence: full gate green → `tsc` clean, `biome` clean (4 infos), `pnpm test` → 55 files / 473 passed, `pnpm build` ok; live check: 51 sessions, 17 flagged skeleton — e.g. "Greeting" and "Skeleton loaders for loading states" now display instead of path-soup; title-less Muse skeletons unchanged. New tests: contract fixtures carry the flag; db `summarySkeleton` matrix (skeleton true / model false / missing false)
- notes: Muse sessions carry no title in their logs (verified: no title/name field in the first payloads), so the fallback only lifts OpenCode-titled sessions today; capturing Muse titles would be ingest work, not done here.

## 2026-10-29 — Project Learn tab v1 (calibration history, read-only)

- item: `GET /api/projects/:id/learn` (`apps/server/src/learn.ts`, read-only aggregation over `checks_v2.json` + `story.json`, no model calls) + contracts `ProjectLearnResponse` (total `LearnBucketTotals`, `LearnSessionEntry`, `LearnWeakArea`) + web `ProjectLearnPage` rewrite (calibration picture, weakest areas, session list; empty message only when nothing checked)
- status: done
- evidence: `tsc` clean; `biome` clean on touched files (4 pre-existing `useLiteralKeys` infos in untouched `checks-v2.test.ts`); `pnpm exec vitest run packages/contracts apps/server/src/learn.test.ts apps/server/src/checks-v2.test.ts apps/server/src/story.test.ts` → 5 files / 63 passed; `pnpm build` exit 0; built web bundle carries the new copy. Full `pnpm test` shows 2 failures that reproduce on clean HEAD `5a587d8` in an isolated worktree (ingest identity-migration + eval harness ENOENT) — pre-existing, untouched by this slice
- notes: Totals count picture entries across sessions that have a checks artifact; weak areas count confident_but_wrong/wrong_and_knew_it per story-card touch file (top 8). Corrupt/missing artifacts read as empty picture, never 500. User call honored: no next-up queue, empty-state only. pnpm-lock.yaml drift in the tree is environmental (packageManager `@pnpm/exe` entry), not mine. Nothing staged or committed.

## 2026-10-29 — Learn v2: Next-up queue (deterministic, no model calls)

- item: ranked `nextUp` (top 5) on `GET /api/projects/:id/learn` + `ProjectLearnPage` "Next up" section — not-checked sessions with high-risk cards lacking picture first, then never-looked counts, then recency; checked/skipped/story-less sessions never queue
- status: done
- evidence: `tsc` clean; `biome` clean on touched files (4 pre-existing infos in untouched `checks-v2.test.ts`); targeted `packages/contracts/src/api.test.ts + apps/server/src/learn.test.ts` → 19 passed; `pnpm build` exit 0 with "Next up" in the web bundle; full `pnpm test` → 464 passed + same 2 pre-existing failures verified on clean HEAD `5a587d8` (ingest identity-migration, eval harness ENOENT)
- notes: Contracts gain `LearnNextUpEntry` + required `nextUp` on `ProjectLearnResponse` (total record, matching the v1 bucket-totals lesson). Reasons are plain counts ("N high-risk cards with no check yet" / "N cards never looked at"). Empty-state rule updated: the no-checks card shows only when the queue is also empty; with queue entries but zero checks, a slim "start above" note replaces the picture. Nothing staged or committed.

## 2026-10-29 — README refresh (scaffold → story-first)

- item: `README.md` status/layout rewrite — scaffold-stage copy replaced with the built story-first loop (spec §10 items 1–9), project tabs (Overview/Learn/Architecture + code index), and pending delivery items (baked tape, hosted demo, video, submission); `story/` + `graph` (central code index) layout entries corrected, stale duplicate `graph/` line removed
- status: done
- evidence: `tsc` clean; `pnpm build` ok (web + server + cli); `biome` 4 pre-existing `useLiteralKeys` infos in untouched `checks-v2.test.ts`; `pnpm test` → 464 passed + same 2 pre-existing failures noted in the Learn v2 entry (ingest identity-migration, eval harness ENOENT)
- notes: Docs-only (`README.md`); no code, contract, or migration change.

## 2026-10-29 — Cross-session check targeting (weak-file bias)

- item: check `generate()` biases `selectTargets` with files the project got wrong before — new pure `isWeakPictureBucket`/`weakFileCounts`/`weakFiles` in `packages/checks` (Learn's weak-area rule: confident_but_wrong/wrong_and_knew_it per story-card touch), shared by `learn.ts` (refactored counting, same order) and `checks-v2.ts` (`crossSessionWeakFiles` over other sessions' artifacts, corrupt/missing read as empty); `selectTargets` gains optional 4th param (weak-touch count between highRisk and rank, risk still outranks, engaged swap unchanged, default-off keeps old order byte-identical); question→card link already exists (`StoredCheckQuestion.cardId` required) so no contract change and no per-question provenance stored
- status: done
- evidence: `tsc` clean; `pnpm build` ok; `biome` 4 pre-existing `useLiteralKeys` infos in untouched `checks-v2.test.ts` lines; targeted `packages/checks + checks-v2.test.ts + learn.test.ts` → 40 passed (new: 4 targeting bias units incl. highRisk-outranks-weak + determinism, weak-signal units, 2 generate-level tests proving rank-6 weak-touching card displaces rank-5 + solo control keeps rank order, single model call each); full `pnpm test` → 472 passed + same 2 pre-existing failures verified on clean HEAD in earlier entries (ingest identity-migration, eval harness ENOENT)
- notes: Deliberate scope cuts: no threshold change (confidentWrong > 0, same as Learn display), no per-question cross-session provenance (originating sessions stay visible via Learn weak areas, not stored on questions), `checkMe` path untouched (single-card, no targeting). Nothing staged or committed.

## 2026-10-29 — OpenCode subagents fold into parent tape (no more subagent cards)

- item: `parent_id` surfaced in `capture-opencode` store; lane import in `map.ts` (`subagent.started` + parent-scoped keys/links, stable across polls); `ingest.ts` ingests roots first then children oldest-first into the parent tape (no session row, no snapshots, no capturedSessions++), skips children with no ingested parent; pre-lane orphan rows deleted only with zero user data (`sessionHasUserData` guard + `deleteEchoSession` FK-ordered wipe), touched orphans stay as cards and skip the lane
- notes: guard counts engagement + non-story artifacts only — auto-generated stories rebuild from the parent lane, so all 35 live orphans (story-only) qualify for removal and their history restores on the parent lane; verified against the live DB before implementing.
- status: done
- evidence: full gate green → `tsc` clean, `biome` clean on 9 touched files, `pnpm test` → 58 files / 522 passed (2 unrelated flakes in review-index/story under parallel load, green on re-run + full re-run), `pnpm build` ok; live-DB proof before fix: 37/67 opencode rows have parent_id and all surfaced as cards; 0/125 Muse child logs leaked (lane model holds there)
- notes: Forks (`fork_session_id`) intentionally stay separate sessions — only `parent_id` routes to a lane. Old orphan tapes re-ingest into the parent lane under new keys; orphan snapshot commits stay orphaned in shadow.git until gc. Next daemon poll performs the cleanup live; nothing committed (user owns history).

## 2026-10-29 — Session summaries capped to one headline sentence

- item: `capStorySummary` in `packages/contracts` (1 sentence, 140 chars, sentence-then-word boundary cuts with `…`, filenames/versions/initials never split) enforced in three places: narration prompt line (`story-v1`, chars interpolated), server `finalizeStory` post-validation + `persistStory` carried-over titles, and web `sessionDisplayTitle` (cards, folder peek, story header) + Learn rows (with skeleton compaction); session/Learn cards `line-clamp-2` → `line-clamp-3` so a capped headline fits
- status: done
- evidence: gate green in one sweep → `tsc` clean, `biome` 219 files (4 pre-existing `useLiteralKeys` infos), `pnpm test` → 58 files / 522 passed, `pnpm build` ok; after the final Learn tweak: `tsc` + `biome` + `build` green, touched-area suites 9 files / 104 passed; browser pass on the user's running dev servers (untouched): overview cards short with no mid-word cuts, story header renders a stored 197-char summary capped at a word boundary, Learn rows render (title-first, compacted skeleton fallback)
- notes: Real stored summaries ran 130–242 chars (screenshot case: one 158-char sentence), so the char bound does the work and the sentence bound stops rambles; cap runs post-validation (strict substring, drops tokens only) with no diagnostic (full story one click away); pre-cap titles shrink on next persist, pre-cap stored rows shrink at display; `STORY_PROMPT_VERSION` left at `story-v1` per the shortVersion-tweak precedent. Mechanical `biome check --write` applied to 3 parallel in-flight files (ingest.ts, db index/repositories) to restore the gate; later full runs showed rotating 1–9 failures in the parallel session's git-heavy integration tests (ingest/review-index/muse-ingest/sandbox/import), each green in isolation — contention flakes, none in touched areas.

## 2026-10-29 — Whole-tree diffs + transition cache (review goes from 46k git spawns to ~55)

- item: `buildSessionReview` no longer diffs per path per transition. New `diffShadowTrees` (`packages/snapshots/src/git.ts`, same flags/env/timeout as per-path plus `--no-renames` so moves read as delete+add) runs one diff per snapshot pair plus one baseline→final, parsed once and distributed by file entry (`newPath ?? oldPath`); per-path diffs remain only as fallback when a whole-tree diff blows the 10MB buffer (guarded by remaining budget, else `review_diff_failed`). Transition hunks persist in new `review_transition_cache` table (migration v11, one row per commit pair, `REVIEW_CACHE_VERSION = "1"` with recompute-on-mismatch and self-healing corrupt rows, redaction gate before every write, caller-owned per import rules) so steady-state regens only pay for new snapshots
- status: done (two subagents, file-disjoint, verified + integrated by coordinator)
- evidence: full gate green → `tsc` clean, `biome` clean, `pnpm test` → 58 files / 522+ passed (2 consecutive full-green runs after flake fix), `pnpm build` ok; measured on live monster: transition diffs 727ms (was the hang), cache rows accumulating (74 live rows), second-run correctness identical; new tests: git.test.ts (4), whole-tree split/delete-add/fallback (3), cache reuse + version-mismatch repair (2)
- notes: Fixed a flaky fallback test along the way (12MB fixture + 10s default budget tripped under parallel-suite load; test now sets explicit 120s budget since it measures fallback correctness, not budget behavior). Daemon picked up server changes via `tsx watch`.

## 2026-10-29 — Stories only generate for quiet sessions (1 min silence, everywhere)

- item: `maybeGenerateStory` returns `waiting` (previous artifact if one exists, else null) when the tape moved within the last minute — cheap `MAX(observed_at)` lookup first, so the per-poll finalize hook costs one indexed query instead of a full tape read + review on active sessions. `GET /api/sessions/:id/story` serves a cached artifact as-is when waiting, 202 + `{waiting:true}` when there is nothing to show; `GET /api/projects/:id/sessions` hides non-quiet sessions (same 60s rule on `lastActivity`); web shows a "Session still active" + Retry state via new `StoryNotReadyError`, overview empty-state distinguishes "no sessions yet" from "active sessions appear after a minute of quiet"
- status: done
- evidence: same full gate as above (new tests: `isSessionQuiet` unit incl. boundary/null/corrupt, waiting-with-nothing, waiting-with-artifact; live: active session story served in ~1.4s from cache with no regen, visible sessions 54 → 19 under current parallel-agent activity)
- notes: Follows the existing stale-while-revalidate philosophy: the gate blocks regeneration, never serving. Opencode hook fires per poll but now no-ops cheaply on active sessions; Muse reconcile path unchanged. Threshold is `STORY_QUIET_MS` (60s), one constant.

## 2026-10-29 — Review budget 20s + measured CPU/I-O wins (monsters complete fully)

- item: default review budget 10s → 20s so giant sessions finish instead of degrading; versions phase reads blobs 32-at-a-time (order-preserving, measured 2.7s → 1.1s on the monster's 433 blobs) and evidence linking prefilters related events per path (output-identical — `linkHunkEvidence` only ever used mentioning events; H×E scans become P×E). `pathMentions` exported from `@echo/tape` for the prefilter
- status: done
- evidence: same full gate; live monster run completes fully in ~10.5s (308 hunks, 555 attempts, no budget diagnostic) vs 15+ min hang before all review work began; daemon-served review under load still degrades gracefully with the diagnostic instead of hanging
- notes: Remaining ~10s is CPU attribution + evidence linking over hundreds of paths/versions — further wins need semantic tradeoffs (history thinning), deliberately not taken. Timing instrumentation used during profiling was removed before gating; tree is clean.
## 2026-10-29 — Header search duplicate icons removed

- item: removed the redundant submit magnifier from the in-progress `ExpandableSearch` (`apps/web/src/components/search/expandable-search.tsx`, button + dead CSS) so the open bar shows lead icon + query + close toggle only; header cluster gap `gap-1` → `gap-3` in `apps/web/src/layout.tsx` so Sort doesn't glue to the pill
- status: done
- evidence: headless Chrome: `.es-root svg` count 3 → 2, screenshot shows `🔍 me ✕` in one pill; `biome check` on both touched files clean; web `vite build` ok
- notes: Touched another author's uncommitted in-flight search work per user "fix it" — flagging for them: Enter still submits (form implicit submission); the file's earlier lint findings are gone with the dead button. Full `tsc` currently blocked by that same session's half-written untracked `apps/server/src/architecture.ts` (syntax error, not mine, left alone). No commit.
## 2026-10-29 — Header search wider + filters in place

- item: `HeaderSearch` bar `width 200 → 300` (plus `70vw` cap for narrow screens); `applySearch` now filters in place on both project routes (`/` and `/projects`) instead of jumping route — empty submit clears back to all
- status: done
- evidence: headless Chrome on `/projects`: open width 300, submit `whitespace` → URL stays `/projects?q=whitespace`, grid narrows to Whitespace only; empty submit → `/projects` with all 3 back, zero page errors; `tsc` clean, `biome` clean on touched files, web build ok
- notes: Continues the other session's uncommitted header-search work per user "make it work" (it previously navigated `/projects` → `/` on submit). No commit.
## 2026-10-29 — Header search wider + filters in place (gate follow-up)

- item: search follow-up above stands; additionally repaired the suite for the concurrent architecture work staged into the tree mid-merge — `db.test.ts` migration-version assertions `[1..10]` → `[1..11]` to match the staged v11 `project_architecture_versions` migration (mechanical, zero behavior)
- status: done
- evidence: `pnpm test` → 58 files / 495 passed + 8 skipped, 0 failed; `db.test.ts` 29/29 in isolation; headless Chrome `/projects` flow from the earlier run still holds (300px bar, in-place filter, clear restores all)
- notes: The 2 `db.test.ts` failures were deterministic (stale assertion vs staged v11), not flakes. Full `tsc` is still red on that same session's half-written `architecture-chat.tsx` (type error, untouched — genuinely theirs to finish). `tsc` on everything else, `biome`, and web build are green from the earlier scoped runs. No commit.
## 2026-10-29 — Header sort dropdown (glass menu)

- item: replaced the header's native Sort `<select>` with a glass dropdown menu in `apps/web/src/components/search/project-sort.tsx` (Animate UI paste adapted the same way as the search bar: Base UI primitives swapped for the settings-sheet menu machinery — portal panel, popover open/close motion, ArrowUp/Down/Home/End, Escape/Tab, outside close, focus return, reduced-motion instant; no new deps): `Sort <value> ▾` trigger with ChevronDown, menuitemradio rows (Last activity / Name / Sessions) with Tick02 check on the active value; writes `?sort=` (`activity` omits the param), hidden off-home
- status: done
- evidence: full gate green → `tsc` clean, `biome` 222 files (4 pre-existing `useLiteralKeys` infos in untouched `checks-v2.test.ts`), `pnpm test` → 58 files / 495 passed + 8 skipped, `pnpm build` ok; browser pass (playwright-core + system Chrome, live dev stack): menu opens, ArrowDown×2 lands on Name, Enter writes `?sort=name` with grid reordered [Echo, Portfolio, Whitespace], Escape closes with focus back on the trigger, header search still filters (`port` → 1 of 3), mobile 360px fits; zero page errors
- notes: Mechanical `biome --write` formats only on concurrent files (`architecture.ts` `new Set<string>()` parse fix + import/format normalizations, `ingest.test.ts` unused binding) to restore the green gate — zero behavior change; the 2 `db.test.ts` migration failures seen mid-work were the concurrent session's stale v10-vs-v11 assertions, healed on their side before the final run. Probe scripts in `/tmp/opencode/pw` were wiped by the server restart; reinstalled driver + re-verified after. Nothing staged or committed by this session (tree already holds staged work from all sessions).
