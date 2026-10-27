# ADR 0005: Redaction is a gate, not a cleanup pass

Status: Accepted, 2026-10-27

## Context

Echo's trust claim depends on not persisting secrets. Once raw content reaches the tape, a shadow-Git blob or a model request, removing it later is unreliable.

## Decision

Run redaction before every Echo-owned write and again immediately before any model request. This covers hook payloads, native log lines, file blobs, exports, SQLite rows, logs, artifacts and the demo bundle. On failure, drop the content and record a content-free diagnostic.

## Consequences

- The hook helper carries a small redaction cost but keeps the boundary in one place.
- False positives can damage code semantics; the masked preview makes them visible.
- Muse's own native logs remain a separate, disclosed storage surface.
