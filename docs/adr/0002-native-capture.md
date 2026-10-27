# ADR 0002: Native capture over terminal parsing

Status: Accepted, 2026-10-27

## Context

Echo needs attributable actions, results and file states for a normal interactive Muse Code session. Terminal text is rendered output, not a reliable action record.

## Decision

Capture from three inputs: Muse native session JSONL as the authority for requests and results, lifecycle hooks for timing and boundaries, and independent shadow-Git snapshots for what actually changed. A PTY is optional visual playback only and never the action authority.

## Consequences

- Muse schema drift is a real risk; unknown records are preserved and diagnostics are visible.
- Export is used for reconciliation, not as the only source, because checkpoints can trim history.
- Gaps and uncertain links are data, never invented records.
