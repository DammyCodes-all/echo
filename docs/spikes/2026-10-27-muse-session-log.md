# Spike: Muse 1.4.13 session log — observed schema

Date: 2026-10-27. Spike item: "Real Muse session log: envelope, record types, child logs, checkpoint behavior" (BUILD-PLAN Phase 0, item 1).

**Result: PASS with deltas.** Child logs not observed (chat-only session); tool/message body schema not observed. Both need a tool-using session before the capture-muse reader is built.

## Environment

- Muse Code `1.4.13 (1.4.13-R6996.1)`, Linux.
- Source: two chat-only interactive sessions from Oct 26 (26 and 53 JSONL lines). No tool calls were made in either, so tool-call record shapes remain unobserved.
- Method: schema-level inspection only (field names, types, counts). No conversation content copied into this note or Echo storage.

## Storage layout

```text
~/.local/share/muse/sessions/YYYY/MM/DD/<uuid>/
  session.jsonl                      # the documented log
  session.peer-history.sqlite3       # UNDOCUMENTED: compaction bookkeeping
  session.peer-history.sqlite3.rebuild.lock
  cli-<uuid>.log                     # UNDOCUMENTED: CLI log
  cron.db                            # UNDOCUMENTED
  .session.lock
```

## session.jsonl format

Framed JSONL, not flat. Line 1 is a **header frame**, not an event:

```json
{
  "retained_frame": "session_permission_transaction",
  "frame_schema_version": 1,
  "outer_log_ordinal": <number>,
  "transaction_id": "<id>",
  "children": [{ "child_index": 0, "record_json": "<stringified envelope>" }, ...],
  "content_sha256": "<sha>"
}
```

The frame's `record_json` strings embed full envelopes for sequences 1–2 (`runtime.session.permission_format_declared`, `runtime.session.permission_profile_committed`). Top-level event lines therefore start at sequence 3. The header embeds the permission snapshot (approval mode, filesystem rules, network modes, `definition_sha256`, `resulting_snapshot_sha256`) — directly usable as approval evidence.

## Event envelope (all subsequent lines)

Observed keys: `schema_version`, `id` (uuid), `stream {kind, id}`, `sequence`, `recorded_at`, `record_type`, `durability`, `causation_id`, `payload_type`, `payload_schema_version`, `payload`.

Deltas from the architecture's assumptions:

| Field | Observed | Consequence for capture-muse |
| --- | --- | --- |
| `record_type` | Constant `"event"` (absent on frame lines) | The discriminator is `payload_type`, not `record_type`. Unknown `payload_type` → `agent.unknown`, preserved. |
| `recorded_at` | Integer **microseconds** since epoch, not ISO | Convert on ingest; never order by `ts` alone (already the rule). |
| `sequence` | Monotonic per stream; gaps explained by frame-embedded records and compaction | Reader must parse the header frame and dedupe embedded sequences against live lines on resume. |
| Extra linkage fields | `causation_id`, `transaction_id`, `content_sha256`, `outer_log_ordinal`, `stream.id` | More evidence linking than assumed — carry them in `source`/`links`. |
| `durability` | All `"durable"` in these sessions | Preserve verbatim; no behavior change. |

## Payload taxonomy (payload_type / inner kind)

Outer payload is `{kind, record, payload, ...}`; content sits in `record` for most kinds. Observed payload_types: `runtime.session.metadata` (build semver + sha, `workspace_root`, tool surface version), `runtime.session.route_facts` (`cwd`, pid), `runtime.command_intake.received|settled`, `runtime.session_start.intake_v3`, `session.started`, `session.opened.observed`, `runtime.session.capture_selection`, `session.startup_phases.observed`, `session.subscription_entrypoint.impression`, `session.login.completed`, `runtime.model_reconfigure.completed`, `run.model.configured`, `runtime.retained_fact`, `runtime.user_intent.accepted|materialized`, `runtime.session` (dominant; inner kinds `agent_tree_initialized`, `run`, `task`), `command.invoked`, `reminder.cleanup_effect.*`, `session.end`.

Key shapes:

- `run` events: lifecycle markers — `run_id`, `event {kind, prompt}`, `source_run_record_id`, `source_run_record_sequence`. No message bodies.
- `task` events: `task_id`, `task_kind`, `run_id`. No message bodies.
- `runtime.user_intent.accepted`: carries `model_messages: [{content: [{kind, text}]}]` — the user prompt path.
- Assistant/tool message bodies were **not present in either session** (chat-only). Where tool calls/results live in the JSONL is still unknown; `muse export` claims to include them.

## Compaction / checkpointing

`session.peer-history.sqlite3` tables: `schema_meta`, `source_snapshot` (source identity, len, modified/changed ns, anchor start/end + sha256, `target_records_complete`), `retained_records` (line_start, line_end, event_id, stream, sequence, `raw_sha256`), `stable_ids` (empty). This is the trimming ledger: retained line ranges are tracked with hashes, and header frames carry retained transactions. The reader can use it to distinguish "trimmed" from "gap".

## muse CLI surface (first-party, observed via --help)

- `muse export [--session <id|path>] [--last] [--out <file>] [--redacted]` — one self-contained JSON, `export_schema_version: 1`, containing timestamps, messages, **verbatim encrypted reasoning**, tool calls/results, approvals, question outcomes, model ids, `ses_`/`trajectory_` ids, fork/subagent lineage. Without `--out` on a TTY it opens a picker; piped export writes the most recent session. Existing files are never overwritten.
- `muse trace` — inspect a recorded session or run trace.
- `muse schema` — export the MSP wire schema as JSON Schema or TypeScript (candidate generator for adapter types).
- `muse resume`, `muse session-message`, `muse serve` (MSP over stdio).

## Consequences

1. Adapter maps `payload_type` → canonical kinds; `record_type` is useless as a discriminator.
2. Reader v1 must parse the header frame + embedded `record_json`, dedupe by event `id`/sequence, and convert µs timestamps.
3. `route_facts.cwd` and `metadata.workspace_root` give project attribution and build pinning directly.
4. Reasoning expectation lowered: export states reasoning is **encrypted** verbatim; `show_reasoning` readability is still untested but `agent_stated` should not depend on it.
5. Redaction disclosure must list the undocumented surfaces: `session.peer-history.sqlite3`, `cli-<uuid>.log`, `cron.db`.
6. Next prerequisite: one tool-using session in a scratch repo to observe tool call/result payloads and confirm where message bodies live in the live log.

## Addendum 2026-10-28 (live verification, Muse Code 1.4.14)

Observed against 9 real parent logs + 2 headless `muse exec` sessions:

- Attribution markers (exact paths): `payload.kind === "route_facts"` carries launch cwd at `payload.record.cwd` (payload_type `runtime.session.route_facts`); `workspace_root` appears nested at varying depths (`payload.record.workspace_root`, `payload.record.command.session_metadata.workspace_root`, `payload.payload.session_metadata.workspace_root`, meta/vcs objects). The guessed paths `payload.metadata.workspace_root` / `payload.route_facts.cwd` match zero real lines. Frame `children[].record_json` wraps real records and must be unwrapped for attribution. Fix: unified `extractWorkspaceRoot` in `@echo/capture-muse` (route_facts first, legacy paths kept, nested exact-key fallback with single-distinct-value rule, ambiguity refuses).
- Prompt text: `runtime.user_intent.accepted` carries text in `model_messages[].content[]` (`kind: "text"`) with `refill_blocks[]` fallback; the `materialized` twin (same `intent_id`) carries outcome only, no text. `runtime.command_intake.received` carries session-start/retract metadata only (10 session_start + 2 run_retract across all logs, zero with message text). Remap: accepted → `prompt.submitted` + extracted `text`; materialized → `notification`; intake → `session.started` (existing first-wins dedup applies).
- `muse exec` (headless) fires no hooks: spool `drained: 0` across all polls; capture came 100% from log tailing. Hook firing in live interactive use remains unobserved.
