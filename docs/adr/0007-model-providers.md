# ADR 0007: Meta Model API primary, Baseten optional

Status: Accepted, 2026-10-27

## Context

Echo needs structured, evidence-grounded generation for Q&A, hunk analysis and check generation. The demo should use Meta's tooling, and an open-weight path is valuable for data locality and the open-weight bonus.

## Decision

Use the Meta Model API with `muse-spark-1.3` as the primary provider. Keep an optional OpenAI-compatible Baseten path for `meta-models/muse-spark-open` behind the same client interface. Both providers implement structured completion and streaming; prompts stay model-agnostic and answers go through the same citation validation.

## Consequences

- Provider selection is configuration, not hardcoded behavior.
- Model calls are metered, capped and cached by content hash.
- If the open-weight path cannot hold quality, it is dropped without touching the rest of the system.
