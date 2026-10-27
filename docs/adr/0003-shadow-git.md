# ADR 0003: Bare shadow Git repository per project

Status: Accepted, 2026-10-27

## Context

Echo needs content-addressed file versions, diffs and line provenance without touching the user's repository, index or Git history.

## Decision

Store redacted file states as commits in a bare shadow repository per project. Walk the working tree with an ignore policy, reuse blobs by manifest, write redacted blobs with `git hash-object`, build trees with a temporary index, and update session refs atomically.

## Consequences

- Git supplies content addressing, diffs, blame and portable bundles.
- Raw bytes never reach Git; redaction happens before blob writes.
- The snapshot is best effort, not a globally atomic filesystem state.
- Deletion and garbage collection are not secure-erase guarantees.
