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
