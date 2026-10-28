# ADR 0011: Story-first session surface replaces replay

Status: Accepted, 2026-10-28

## Context

The built experience is forensic and code-first: projects -> raw timeline -> file state -> alphabetical diff -> hunk inspector. The confirmed product intent is post-session comprehension for a dev reviewing their own session: in 1 minute the dev can state what shipped, where it deviates from the ask, and what could bite them. A timeline answers "what happened in what order"; it does not answer "what should I take away."

## Decision

The session home is a generated story in five sections:

1. Short version — the one-minute takeaway.
2. Ask vs result vs all session prompts — what was asked against what actually landed.
3. What changed — model-grouped behaviour cards, riskiest first.
4. Detours — attempts that were reverted or replaced.
5. Loose ends — unfinished work, with tape blind spots kept separate as gap lines.

Replay, timeline, and diff pages are deleted as the primary surface. Before/after diff and the "moment in the session" render inline inside behaviour cards. Ask Why becomes a persisted per-session thread rather than a one-shot panel.

Division of labour: the model writes narrative, summaries, and behaviour grouping. A deterministic fact-check layer validates every claim (numbers, files, names) against tape facts. Verification badges (`observed` / `partly` / `agent-stated` / `nothing`; observed-only counts as verified) and risk ranking (blast radius x model-wrong, with plain-language rank reasons, never a bare score) are computed deterministically, never model-asserted. A failed claim regenerates once, then drops to an "Echo couldn't verify this" gap line.

The story generates at session finalization from the redacted tape, with a deterministic skeleton fallback when the model is unavailable. Resumption past the generation watermark regenerates the story.

## Consequences

- A new story artifact plus a generation/validation pipeline must be built; ARCHITECTURE §13 (Replay and review UI: timeline, file state, final diff as primary surface, hunk inspector, ask panel) and spec §3 Pipeline steps 4–6 (replay/inspect/ask as the review loop) are superseded by this ADR.
- The review index, hunks, and attempts remain the evidence substrate underneath the story; the fact-check layer reads them.
- Behaviour grouping cannot be edited by the dev in v1 — the fact-check layer is the only corrector.
- A future evidence/replay viewer is a new decision, not a restoration of the deleted surface.
