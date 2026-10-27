# ADR 0004: Append-only tape with a rebuildable SQLite index

Status: Accepted, 2026-10-27

## Context

The review experience needs fast queries, but the primary evidence must survive bugs, crashes and format changes without a database.

## Decision

Keep two stores with distinct jobs. An append-only redacted JSONL tape and shadow-Git commits are canonical. SQLite is a derived query index plus operational state for jobs and settings, rebuildable from the tape and shadow repo.

## Consequences

- A tape append is simple and crash-tolerant; a partial last line is truncated with a diagnostic.
- Every derived review row must be reproducible by `echo-cli index rebuild`.
- Two stores require careful consistency and rebuild tests.
