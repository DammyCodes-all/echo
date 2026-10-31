# ADR 0014: Session Review Reader — one change at a time

Status: Accepted, 2026-10-31

## Context

ADR 0011 made the session home a five-section story with risk-ranked behaviour cards, verification badges, and deterministic trust. ADR 0012 added calibration checks targeted by risk + engagement.

The draft of Oct 30 rejects that surface: too long, too noisy, scoring where none is wanted. The confirmed intent is a plain-English walkthrough of what actually changed, one change at a time, under a minute per change. No scores, no rankings, no trust chrome.

## Decision

a. The unit is a Change: one coherent piece of work from a diff between two snapshots. Snapshots are taken when the agent goes idle (Stop / SessionEnd hook + short quiescence) and the code differs. No diff means no change.
b. Grouping is one model pass per snapshot-pair diff (files + diffs + that moment's prompts). Output is 1-4 coherent changes per pair, never 1:1 per file. Typos and renames fold into a single "small changes" item per pair.
c. A session-level fold keeps the count reasonable: ten or fewer changes stay whole, beyond that the budget grows with the square root up to twenty-four (24 -> 5, 100 -> 10). The most substantive groups survive; the rest merge into one leading "smaller changes" rollup spanning their first-to-last pair. No hard wall — very large sessions may show up to twenty-four. Merge-then-build keeps ids stable across reruns.
c. A change holds Title (8 words), Summary (2-3 sentences), Before (1-2), Now (1-2), How it works (3-5 steps, skipped if trivial), Heads up (max 3: Not asked / Watch out / Unfinished, one line if none), Files (one plain line each), Digest (50-100 tokens). Caps live in prompt + zod schema.
d. Change id is `c_` + 16 hex of sha256(normalized diff + snapshot pair), with a `version` field from day one. Regen dedupes on id; same span with a different hash stores a new version and keeps the old. Progress keys on `(id, version)` and is never reset by regen. Product name for "change" may rename later; ids do not.
e. Context for generation is diff + that moment's prompts/reasoning + earlier digests only. Session summary is built from digests only. Ask answers from the current change slice + digests.
f. Progress is per change (`viewed / understood / skipped` + when), stored separately from content. Resume is the first not-understood. Got it = understood, Skip = skipped (still not-understood). Checks never flip progress.
g. No scoring anywhere: no risk, no verification badges, no agent-stated/uncertain chrome. Thin validator only (caps, file names in diff, digest length, heads-up types). Checks stay in two places without targeting: per-change Check-me asks 1 now, caught-up screen asks max 3 (skipped first, then understood, never viewed-only).
h. Reader UI is one change at a time: progress tape, "Change N of M" only nav, previous-digest recap, collapsed files/code/moment rows, Ask anchored to change, Back / Skip quiet / Got it next, caught-up screen with summary + skipped, hidden jump menu. Live sessions show the last slot as in-progress until idle.
i. Old artifacts (`story.json`, `checks_v2.json`, ask thread, engagement, `check_status`, risk/verification code, long-scroll story page) are deleted. New pipeline reruns for all sessions when done. No backfill of old shapes.
j. Later work appends, never rewrites. New snapshots trigger a regen that recomputes the fold over everything: unchanged groups skip by id, new spans become new changes, the session rollup (one stable id per session) updates in place, and rows that fall out are pruned from refs while their progress rows stay, just hidden. A byte-identical rebuild returns fresh without writing; the snapshot watermark lets quiet sessions skip the pair loop entirely.

## Consequences

- ADR 0011's five sections, risk ranking, verification badges, and engagement targeting are superseded. ADR 0012's risk-targeted selection and picture mapping are superseded in selection only; per-change + caught-up placement and confidence-first flow stand.
- New contracts + storage (Change, Digest, Progress, summary-from-digests), new pipeline (`packages/chapters` + server wiring), new reader UI, rescoped Ask, replacement checks selection.
- `packages/story` becomes legacy; new generation lives in `packages/chapters` so reruns do not fight old watermarks.
- Redaction gate, tape + shadow Git as canonical, gaps-as-data, and server-composes-everything still hold.
