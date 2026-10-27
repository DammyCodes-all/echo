# ADR 0006: Local web UI with loopback authentication

Status: Accepted, 2026-10-27

## Context

The browser is the review UI. A local HTTP service is reachable by any web page the user visits, so loopback alone is not authentication.

## Decision

Bind the daemon to `127.0.0.1` only. The CLI authenticates with a random daemon token from a `0600` discovery file and opens the browser through a one-time, 60-second link token. The browser gets an `HttpOnly`, `SameSite=Strict` cookie. Validate `Host` and `Origin`, require a CSRF header on mutations, send no CORS headers and serve file content only through blob-OID resolution.

## Consequences

- The browser never sees the daemon token.
- Sessions are invalid after a daemon restart and need a fresh link.
- No multi-tenant isolation claim; Echo is a single-user local tool.
