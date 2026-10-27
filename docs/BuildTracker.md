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
