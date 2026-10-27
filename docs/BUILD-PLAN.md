# Echo — Build Plan

The ground-up method for the hackathon window: what gets built, in what order, and what proves each stage done before the next one starts.

- Product intent: [docs/echo-spec.md](echo-spec.md) (wins on intent). Mechanism: [docs/ARCHITECTURE.md](ARCHITECTURE.md) (wins on mechanism). Decisions: `docs/adr/`.
- This file is the day-by-day schedule the spec defers to (§10) and the architecture deliberately does not restate (§23). It orders existing scope in time; it adds no scope.

Status: v1, Oct 27, 2026 — day 1 of 9. Building window Oct 27 – Nov 4. Submission due Nov 4, 9 PM ET (Nov 5, 3 AM Lagos). Judging Nov 5–8.

---

## 1. The loop, restated as capabilities

One loop in two halves. The tape half explains what the agent did; the proof half checks what I took in. Each covers a gap in the other.

| Half | Capability | Contract |
| --- | --- | --- |
| Tape | Record & capture | Native Muse session records + lifecycle hooks + shadow-git file snapshots → one common JSONL tape with sequence, IDs and diagnostics; gaps stay visible |
| Tape | Redact | Secrets scrubbed before any Echo-owned storage and before every model call; masked preview; native Muse logs disclosed as a separate, possibly raw surface |
| Tape | Replay | Local web UI: timeline scrub, file state at a moment, final diff, hunk inspector including captured reverted attempts |
| Tape | Inspect | Hunks linked to actions and snapshots; requested edits vs observed effects vs uncertain mappings labeled |
| Tape | Project view | JS/TS import graph + agent-touched overlay; attempt tree separating dead ends from landed code |
| Proof | Ask | Evidence-grounded Q&A (Muse Spark): citations to the tape, or the refusal "not on the tape" |
| Proof | Check | 3–5 risky hunks → ownership questions (consequence → teach_back), runnable ones graded by execution in a sandbox |
| Proof | Calibrate | Confidence picked before answering; wrong-and-certain is the headline event |
| Proof | Report | What I reviewed, proved, and waived |

Delivery items riding with the loop: demo tapes from real Muse sessions, a hosted read-only demo with a baked tape, a public repo with clean history from Oct 27, and the three-minute video.

---

## 2. Why this order

Dependency order, not ambition order. Nothing downstream is claimed until its upstream gate passes. Three gates sit in the sequence:

1. **Spike gate** (end of Phase 0) — native capture, hook payloads, export, reasoning text, shadow snapshots, model access and sandbox are observed on this machine before any of them is built on. If native capture is not viable, the input decision is revisited explicitly; no silent PTY fallback.
2. **Capture gate** (end of Phase 2) — three "why" questions on a real tape. If the tape cannot support useful answers, the product is described honestly as captured actions/results/file changes and weight moves to the check half (spec §10). Echo is not scrapped either way.
3. **Demo gate** (end of Phase 5) — the ask/check loop runs end to end. Phase 6 is optional from here on; remaining time goes to Phase 7.

A phase's exit criterion is the gate for claiming its feature. Phases can overlap; claims cannot skip a gate.

---

## 3. Phases

### Phase 0 — Spikes (before UI)

- [ ] Real Muse session log: envelope, record types, child logs, checkpoint behavior
- [ ] Every hook payload: fields, timing, environment; overhead p95 < 50 ms; never blocks
- [ ] `muse export --redacted` vs live log: schema and reconciliation
- [ ] `show_reasoning` once: does readable text survive export?
- [ ] Shadow-git snapshot prototype on the fixture repo; the user repo's index/refs untouched
- [ ] One structured-output call to Muse Spark 1.3: schema adherence, latency, billing, works from Nigeria
- [ ] Sandbox backends self-test: container → bwrap → WASM ladder
- [ ] API credits claimed ($150, by Nov 4 9 PM ET) with card on account
- [ ] CLI binary name decided (not `echo` — the shell builtin shadows it) before the first commit
- [ ] First commit: public repo history starts Oct 27

**Exit:** notes in `docs/spikes/`, pass/fail per item. Failures narrow claims; none of them silently widen them.

### Phase 1 — Walking skeleton

- [ ] Config, daemon, SQLite migrations
- [ ] Tape writer/reader: append-only JSONL plus a rebuildable index
- [ ] CLI `record` wrapping a normal interactive `muse` session
- [ ] Muse reader v1: SessionStart/End and native record ingestion
- [ ] Baseline + final shadow snapshot
- [ ] Projects and sessions: identity = repo root + Git remote; tapes never mix between projects
- [ ] Minimal web: project list, session list, raw timeline, file content at the final snapshot

**Exit:** one real Muse session recorded and replayed end to end; the user repo is untouched.

### Phase 2 — Capture core

- [ ] All hook mappings; pre/post/batch snapshots; filesystem watcher; spool
- [ ] Redaction gate before all Echo-owned persistence and model calls
- [ ] Export reconciliation; diagnostics; capture-quality labels
- [ ] Final diff, hunks, blame provenance, attempt classification, hunk evidence
- [ ] Fixture coverage: failed tool, reverted edit, shell write, interrupted tool, rapid edit/revert, synthetic secret, binary + ignored `.env`, subagent session

**Exit:** capture integrity report; zero raw secret in any Echo artifact; gaps visible. **Capture gate:** three "why" questions on a real tape decide how the product is described.

### Phase 3 — Review UI

- [ ] Timeline scrub, file state at a moment, final diff, hunk inspector
- [ ] Engagement tracking (which hunks I opened — feeds Phase 5 targeting)
- [ ] Session header, diagnostics panel, desktop notification on session end

**Exit:** the three-minute demo path rehearses without the ask/check panels.

### Phase 4 — Evidence Q&A

- [ ] Retrieval and evidence bundle; model client (Meta API primary, Baseten optional, `ECHO_MODEL=off`)
- [ ] Structured output with citation validation; refusal when the tape has nothing relevant
- [ ] Cache by content hash; cost ledger
- [ ] Baseten open-weight comparison run (bonus decision; keep only if answer quality holds)

**Exit:** 20 hand-labeled answers (≥ 80% citation-supported) and 10 refusal probes (≥ 8 refuse), measured.

### Phase 5 — Checks

- [ ] Hunk selection: risk + never-opened targeting, top 3–5
- [ ] Check generation and verification gate (reference answer passes twice)
- [ ] Sandbox runner per the ladder; answer flow with confidence-first calibration
- [ ] Session report: reviewed / proved / waived

**Exit:** ≥ 80% check pass rate; one demo check runs end to end; wrong-and-certain visible on screen.

### Phase 6 — Project view and attempt tree (optional after the demo gate)

- [ ] Import graph (static, JS/TS) + agent-touched overlay
- [ ] Attempt tree UI; dead ends only where the recorded sequence supports them; flat list per file as fallback

**Exit:** verified against 3 tapes; no fabricated dead ends; misses reported.

### Phase 7 — Demo, hosted, submission

- [ ] Bake the demo tape(s); hosted read-only deployment with rate limit and model budget
- [ ] Report export; README states what was built during the event
- [ ] Three-minute video cut to the demo path; submission filed before Nov 4, 9 PM ET

**Exit:** judges can replay, ask and check without installing anything; local fallback works; repo and history clean.

---

## 4. Which package fills when

| Phase | Packages |
| --- | --- |
| 0 | none — spikes only, notes in `docs/spikes/` |
| 1 | `contracts`, `config`, `db`, `tape`, `core`, `snapshots`, `capture-muse` v1; apps wired |
| 2 | `redaction`, `capture`, `capture-muse` full, `fixtures` (fixture repo + fake Muse logs) |
| 3 | `apps/web`, `apps/server` routes, `notifier` |
| 4 | `retrieval`, `model` |
| 5 | `checks`, `sandbox` |
| 6 | `graph` |
| 7 | hosted profile (same app, read-only), `fixtures` demo bake |
| cut line | `capture-opencode` — only after capture, replay, Q&A and checks are stable |

Import direction stays fixed (ARCHITECTURE §4): `web` imports `@echo/contracts` only; the model package never imports `@echo/db`; capture adapters never import the server; only the server composes packages.

---

## 5. Hard rules the plan does not negotiate

- Redaction gate before every write to Echo-owned storage and every model call. A redaction failure drops the content and records a content-free diagnostic.
- Gaps are data: missing snapshots, sequence jumps and unknown outcomes become diagnostics. A fabricated record is a product failure.
- Evidence carries a label — `observed`, `agent_stated`, `uncertain`. Inference is never rendered as the agent's reasoning.
- Validate at system boundaries only: hook payloads, native log lines, model output, HTTP input, config.
- Ship complete units; three similar lines beat an early helper; no compatibility shims.
- Every `packages/*` change lands with colocated vitest coverage; deterministic tests via fixtures and injected clocks.
- The gate before any "done": `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- Capture changes additionally verify against the fixture sequence (ARCHITECTURE §22); UI changes run in the browser.

---

## 6. How "done" is measured (spec §9 targets)

| Measure | Method | Target |
| --- | --- | --- |
| Capture integrity | Fixture actions/states vs tape; synthetic-secret scan of all Echo artifacts | Coverage reported; zero raw secret |
| Citation support | 20 hand-labeled "why" answers across 3 tapes | ≥ 80% |
| Refusal | 10 unanswerable questions | ≥ 8 refuse |
| Check pass rate | Generated checks clearing the verification gate | ≥ 80% |
| Time to first check | Tape loaded → first verified check | < 90 s |
| Hunk selection | Top picks vs hand-labeled worry list, 3 tapes | Reported as measured |
| Attempt tree | Dead ends/landed nodes vs recorded sequence, 3 tapes | No fabricated dead ends |

Harness lives in `eval/`; outputs are JSON plus a Markdown summary with sample size, caveats and the exact commit used. The submission quotes only these numbers or the cited studies.

---

## 7. Cut line (drop in this order when time shrinks)

1. Screenshot stream and terminal playback
2. Dependency map + cross-session overlay
3. Reverse-motion polish in replay
4. Puzzle checks — cut entirely per ADR 0010, not kept as warm-up
5. Citation click-to-scrub (keep inline citations)
6. Mutation testing in the check gate
7. Second-agent readers (`capture-opencode`)

The attempt tree goes last among the visualizations; if it runs long, a flat list of attempts per file is the fallback.

---

## 8. Day map

Estimate, updated as gates pass or slip. Phases can overlap; exits cannot be skipped.

| Day | Focus |
| --- | --- |
| Tue Oct 27 | Phase 0 spikes (Muse session + API call first — the biggest unknowns), credits claimed, CLI name, first commit |
| Wed Oct 28 – Thu Oct 29 | Phase 1 walking skeleton, end to end |
| Fri Oct 30 – Sat Oct 31 | Phase 2 capture core + capture gate |
| Sun Nov 1 | Phase 3 review UI |
| Mon Nov 2 | Phase 4 Q&A |
| Tue Nov 3 | Phase 5 checks; Phase 6 only if ahead |
| Wed Nov 4 | Phase 7: bake, host, video, README, submit by 9 PM ET |

Slack is thin. Any slip eats Phase 6 first, then the cut line in §7.

---

## 9. Open decisions

| Decision | Default | Settled by |
| --- | --- | --- |
| CLI binary name | not `echo`; candidate chosen before the first commit | Today (Oct 27) |
| Baseten open-weight path | try after the first Q&A works; keep only if quality holds | Phase 4 |
| Demo repo + task | needs a natural reverted attempt + a questionable change | Scouted from day 1 |
| Hosted demo shape | same app, read-only profile, baked tape, budget cap | Phase 7 |
