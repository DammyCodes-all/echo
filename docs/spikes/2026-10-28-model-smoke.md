# Spike: Meta Model API smoke test — Muse Spark 1.3 Contributor

Date: 2026-10-28. Related Phase-0 item: "one structured-output call to
Muse Spark, validate schema adherence and latency" (BUILD-PLAN §3, Phase 0).

**Result: PASS.** One tiny probe call, 29 tokens total, ~2.8 s latency.

## Observed (no key material recorded)

- Base URL `https://api.meta.ai/v1`, path `/chat/completions`, OpenAI-style
  JSON body, `Authorization: Bearer $META_API_KEY`. Key was read from the
  local (gitignored) `.env.local` for this probe only.
- Model id `muse-spark-1.3-contributor` is accepted (echoed back in the
  response `model` field). This settles the spec §11 open question for the
  event API: the contributor variant is valid; use it as the primary id.
- Response envelope is OpenAI-compatible: `id`, `object: "chat.completion"`,
  `choices[]` with `finish_reason`, `message`, `usage` including
  `completion_tokens_details.reasoning_tokens`.

## Delta that shapes the model client

- The probe set `max_tokens: 16` and got `finish_reason: "length"` with
  `content: null` — **14 of the 16 completion tokens were reasoning tokens**.
  Reasoning consumes the output budget before any visible content. The model
  client must budget `max_tokens` generously (reasoning + content) and treat
  a `length` finish with null content as a retry-with-larger-budget case,
  not as an answer. Structured-output calls should request explicit,
  machine-sized schemas to bound this.
- Prompt was 13 tokens for a 7-word instruction; nothing about caching
  observed (`cached_tokens: 0`).

## Still open

- Structured-output adherence (JSON schema / strict mode) — not yet attempted.
- Billing/rate-limit behavior under the event credits.
- Whether the plain `muse-spark-1.3` id also resolves (irrelevant now that
  the contributor id is confirmed; no further probe spent).
