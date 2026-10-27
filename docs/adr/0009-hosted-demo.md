# ADR 0009: Hosted demo is the same app in a read-only profile

Status: Accepted, 2026-10-27

## Context

Judges need to try replay, Q&A and a check without installing Echo. A separate demo app would drift from the product and add work.

## Decision

Run the same server and web app against a baked, redacted bundle. The demo profile allows only allowlisted sessions, read-only routes plus ask and check-answer, WASM-only check execution, rate limits and a spending cap. No ingest, daemon control, settings, export or arbitrary file paths.

## Consequences

- The demo exercises real product code and contracts.
- The bundle is scanned at build time and fails closed on any non-synthetic secret.
- If hosting is down, `echo-cli demo serve` runs the same bundle locally.
