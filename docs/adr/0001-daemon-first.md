# ADR 0001: Daemon-first local service

Status: Accepted, 2026-10-27

## Context

Lifecycle hooks must return in milliseconds. Session discovery, native-log tailing and filesystem watching are long-running. The review UI needs live updates, and model calls, sandbox runs and graph builds must not block ingest or the browser.

## Decision

One long-lived local daemon (`echo-daemon`) owns canonical writes and long-running work. The CLI and hooks are thin, stateless producers that hand already-redacted events to the daemon or its spool.

## Consequences

- A single writer keeps SQLite, tape and shadow-Git writes serialized.
- The daemon lifecycle, instance lock and job recovery must be reliable.
- Hooks stay fast because they never wait for indexing, model calls or snapshots.
