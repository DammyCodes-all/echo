# Spike: live OpenCode ingest + retrieval trial (2026-10-28)

Observed facts, not guesses. Read-only against `~/.local/share/opencode/opencode.db`;
writes only into Echo's own `~/.local/share/echo/`.

## What exists

- `packages/capture-opencode` maps `session_v2`/`session_message` rows to tape
  events with per-event redaction; `apps/server/src/ingest.ts` polls
  `config.opencode_db` (read-only) and writes Echo's SQLite + `tape.jsonl` +
  shadow snapshots. Default config already points at the real OpenCode DB.
- A server was already running on :4783 with 8 echo sessions imported
  (e.g. `ses_e81ec7e61…` "Greeting": 1181 events in DB, 2868 lines in
  `tape.jsonl` — the tape keeps record revisions the DB collapses).

## Trial: upgraded retrieval vs the real Greeting tape

- "What did the agent read from the Downloads folder?" → top hit E2 is
  exactly `tool read … /home/dev-aluminate/Downloads`. Correct.
- "What is the capital of France?" → 0 items, pre-model refusal. Correct.
- "What did it try first?" → top hits are `model.response` events whose
  `parts` contain **encrypted reasoning blobs** (`reasoningEncryptedContent`,
  ~1.5 kB ciphertext each). Two problems:
  1. Ciphertext eats the character budget and can win word-overlap
     ("first entry of the tool_calls array" matched "first").
  2. ARCHITECTURE already says opaque/encrypted reasoning is excluded from
     tape and retrieval — `map.ts` includes all non-tool parts, so the
     exclusion was never implemented for this path.

## Implication

Fix belongs in `capture-opencode/map.ts`: drop `reasoning` parts (or at
minimum strip `native.reasoningEncryptedContent`) before the tape event is
built. Small, testable against the existing `import.test.ts` fixtures plus
one encrypted-part case. Not built yet — proposed as the next unit.
