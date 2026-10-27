# ADR 0008: Sandbox ladder, in-process is never verified

Status: Accepted, 2026-10-27

## Context

Checks are only trustworthy if the reference behaviour is established by execution. Running generated snippets in the daemon process would make "verified" meaningless.

## Decision

Use a capability ladder: Docker or Podman container first, `bwrap` as a Linux fallback, QuickJS/WASM for the hosted demo and CI. Run with no network, a read-only root, tmpfs, non-root user, dropped capabilities and CPU, memory, PID and output limits. If no strong backend is available, disable checks rather than grading in-process.

## Consequences

- The local demo depends on a container runtime; `doctor` reports it.
- Reference answers must pass twice with identical normalized output before a check is shown.
- Backend, image digest, commands and timings are stored as verification evidence.
