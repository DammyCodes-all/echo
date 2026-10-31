# ADR 0015: Reader review fixes — recap, small changes, Meta blue accent

Status: Accepted, 2026-10-31

## Context

ADR 0014 shipped the session review reader: one change at a time, digest
recap, one leading session rollup, graphite-blue accent. Reading real
sessions against it surfaced a failure list: the recap dumped the model's
digest onto the screen, prose read like code descriptions, one change
carried 52 files, the layout ran ~110 characters wide with flat hierarchy
and five competing actions, and the accent had drifted to indigo/purple
against the single-accent mockup.

## Decision

a. The recap shows the previous change's title only, as plain body text.
Digests are written for the model (context for generation, summaries, Ask),
never rendered as reader copy. The quote-block styling goes with them.
b. The narration prompt (now `changes-v2`) carries a hard plain-language
rule: write for someone who has never seen the codebase, no internal names
unless explained in the same sentence, steps describe behavior and
outcomes, never function or hook swaps.
c. No change carries more than ~10 files (`MAX_FILES_PER_CHANGE`). The
trivial fold and the session fold split wider sets by area (top directory,
`splitFilesByArea`), so the reader sees several small changes instead of
one giant one. Rollup ids stay stable per session per chunk index
(`rollupIdFor(sessionId, index)`); index 0 keeps the original seed so
existing rollup rows and their progress survive the split.
d. The reader is a centered 700px column. The session name is small and
quiet, the change title is the biggest thing on screen, the summary is
17px in the softer color, and headings drop the tight tracking.
e. One primary button per screen ("Got it, next change" / "Done — back to
inbox"). Ask and Check are quiet neutral secondaries; Back and Skip are
plain text links. The "Change N of M" label and its jump menu are gone:
the tape already shows position and its segments already jump.
f. Collapsed Files/Code/Moment rows are thin hairline-divided rows, not
filled blocks. Before sits on the neutral surface; only Now carries the
accent tint.
g. The accent is Meta blue (`#2D88FF`, soft `#A9CFFF`, wash
`rgba(45,136,255,0.14)`); base and surfaces are unchanged. On the reader
the accent appears only on the current tape segment, the primary button,
and the Now panel.

## Consequences

- ADR 0014 (c) "one leading rollup" becomes "one rollup per area chunk";
  (h) loses the digest recap, the "Change N of M" nav, and filled
  collapsed rows; (j) "one stable id per session" becomes "one stable id
  per session per chunk index".
- `docs/design-direction.md` palette moves graphite blue to Meta blue.
- Sessions with existing single rollups keep their rollup-0 row in place;
  wider folds gain rollup-1+ rows on the next regen.
