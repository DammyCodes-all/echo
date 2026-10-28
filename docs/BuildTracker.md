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

## 2026-10-28 — Checks wiring (selection, quiz, calibration, report)

- item: Phase 5 wiring — risk + never-opened hunk selection (top 3, max 2/file, waivers), template-drafted ownership questions (consequence/decision/tradeoff/teach_back, easiest first), verification gate with real sandbox runner, model-graded rubric answers with confidence-first flow + Brier calibration, file-persisted checks/attempts artifacts, `GET/POST checks`, `POST /api/checks/:id/answer`, `GET report` endpoints, quiz UI + report UI
- status: done
- evidence: full gate green → `tsc` clean, `biome` 142 files clean, `pnpm test` → 29 files / 189 passed (+5 checks tests over real SQLite + shadow git: 404s, decision-kind generation + deterministic regen, waiver drop, correct/incorrect grading with Brier 0.0025 + overconfident flag + report counts, model-off 503), `pnpm build` ok; live-server probe on temp data dir + alt port returned all five error shapes correctly
- notes: Template drafting only — blast_radius excluded because its demonstration must be a genuinely runnable snippet (needs model drafting, a later slice); open kinds verify by evidence review while the run-twice sandbox path is wired and ready. No `checks`/`attempts` DB tables yet — artifacts JSON under the session dir instead, with a restart-safe scan fallback. Answers are single round-trips, not streamed. Browser behavior unverified (no browser here); UI verified through build + served endpoints only.

## 2026-10-28 — Daemon loads repo .env.local

- item: `.env.local` fix — `dotenv` in `@echo/server`, `loadLocalEnv()` walks up from the launch dir at daemon startup; real env vars still win, missing file is fine
- status: done
- evidence: `pnpm exec vitest run apps/server/src/env.test.ts` → 3 passed; full gate green (typecheck, biome 144 files, 192 tests, build); loader probe from `apps/server` cwd found `/home/dev-aluminate/dev/echo/.env.local` with `META_API_KEY set: true` (presence only, value never printed)
- notes: Restart `pnpm dev` to pick this up. `tsx` also auto-injects `.env.local` in dev, but the built `node dist` daemon does not — the explicit loader covers both.
