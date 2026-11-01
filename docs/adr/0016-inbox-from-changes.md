# ADR 0016: Inbox derives from the changes pipeline

Status: Accepted, 2026-11-01

## Context

Deleting the story service orphaned the inbox: nothing wrote
`sessions.story_summary`, nothing recorded story artifacts, and the
capture-state rule keyed "recording" off the story artifact — so every
session without a legacy artifact read as still-recording forever, and
Muse sessions (no agent title) had no name at all. Cards showed "Still
recording — changes pending…" on sessions with thousands of events.

## Decision

a. The changes pipeline owns the inbox columns. Every
`maybeGenerateChanges` run syncs `story_summary` from the artifact
summary (generated and fresh paths alike); the backfill picks legacy
rows with a new `meta` reason until they converge.
b. Agent-less rows get an AI-generated name: one model call distills
the first prompt plus change titles into a 6-words-or-fewer headline,
capped to 60 chars (`capSessionTitle`) as a backstop. Titles are
first-write-wins forever: the namer skips titled rows before spending
a call, and the SQL guard (`WHERE title IS NULL`) means agent titles
never lose, matching the `upsertSession` stability rule. Prompt text
passes the redaction gate before leaving the process, and the model
name passes it again before the SQLite write. The backfill only flags
title gaps when the model is on, so model-off daemons never spin.
c. Capture state derives from tape silence (`isSessionQuiet`, shared
with the reader liveness flag) instead of the story artifact. The
quietness rule moved to `@echo/contracts` so `@echo/db` can share it
without importing the server.
d. Content-fresh runs advance a drifted or missing artifact watermark
instead of returning it stale. A pre-watermark zero-diff artifact used
to read stale on every tick while every run returned fresh — an
infinite backfill loop starving all other sessions.

## Consequences

- Legacy frozen story summaries are replaced by living changes
summaries on the next run touching each session.
- `summarySkeleton` stays false for changes-fed rows; the old
skeleton-shaped prose it detects no longer gets written.
- Quiet sessions with no snapshots keep a null summary (nothing to
summarize) but leave "recording"; quiet sessions with no prompts keep
a null title and are never backfill-flagged for it.
