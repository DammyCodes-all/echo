# Spike: Muse native reader — live JSONL framing + export reconciliation

Date: 2026-10-28. Related Phase-0 item: "Muse native reader (reader-only, no hooks): session.jsonl framing, envelope/payload_type discriminator, sequence handling, timestamps, child logs, checkpoint/compaction trimming, export schema v1, build/schema pinning."

**Result: PASS with deltas.** All reader inputs were observed on real on-disk sessions from build 1.4.13: the two-level discriminator (`payload_type` + `payload.event.kind`), the tool-call/result framing, approval evidence chain, 20 compaction marker lines with matching export `gap` diagnostics, child-log layout and parent→child linkage keys, and the redacted-export reconciliation keys. No new session was run (see Environment). Deltas against `ARCHITECTURE.md` §8 are listed under "Envelope deltas" and consequence 9.

## Environment

- Muse Code `1.4.13 (1.4.13-R6996.1)`, Linux. `muse --version` — observed.
- Method: read-only probes only. Schema-level inspection (field names, types, counts, hashes); no conversation content, prompts, or secrets copied into this note or any Echo storage.
- Sources inspected: parent `session.jsonl` files of 13, 94, 2895 and 3956 lines (the 2895-line session is the primary sample below), one 35-line child log, `session.peer-history.sqlite3` of the same session, session-dir listings, `muse export --redacted` of the 2895-line session to a `0700` temp dir (deleted in the same command chain), `muse schema generate-ts --out /tmp/opencode/...` (offline, deleted after), `muse trace inspect --help`, `muse usage`.
- Credential/quota state — observed: `META_API_KEY` env is **empty** (length 0) in this environment, contradicting the brief's assumption. `~/.config/muse/auth.json` holds a `meta` provider entry (presence only; value never printed/copied), but `muse usage` reports `No subscription allowance (no_allowance)` both before and after the export probe. Quota used by this spike: **zero** (export and schema generation are offline; no model turn was run).
- Consequence: the "one small Meta tool session" step was **blocked, not skipped** — no allowance. The "free shape check" on `--provider local --model glimmer` was also blocked for headless use: `muse exec --help` accepts `--provider echo|meta` only, so there is no non-interactive local-provider vehicle. Schema findings below transfer regardless (log schema is provider-independent); demo tapes still belong on Meta models per the rubric.

## Storage layout — observed

```text
~/.local/share/muse/sessions/YYYY/MM/DD/<session-id>/
  session.jsonl                      # append-only log (framed: 1 header frame + event lines + marker lines)
  session.peer-history.sqlite3       # compaction/retention bookkeeping (schema_meta, source_snapshot, retained_records, stable_ids)
  session.peer-history.sqlite3.rebuild.lock
  cli-<uuid>.log                     # UNDOCUMENTED CLI log (redaction surface)
  cron.db                            # UNDOCUMENTED (redaction surface)
  approval-review/                   # empty in all sampled sessions (redaction surface)
  input-assets/v1/sha256/..          # content-addressed attachments, hex-sharded (redaction surface)
  tool-outputs/<uuid>/               # per-effect tool output dirs + .spool/ (redaction surface)
  subagent/<child-id>/session.jsonl  # one log per child, same framing (no peer-history sqlite beside child logs)
  .session.lock
```

## Envelope — observed (affirms prior spike, 3 deltas)

Every non-frame line carries the same 11 keys — observed:

`schema_version, id (uuid), stream {kind, id}, sequence (int), recorded_at (int µs), record_type (constant "event"), durability ("durable" in all samples), causation_id, payload_type, payload_schema_version, payload`.

| # | Observed | Consequence for capture-muse |
| --- | --- | --- |
| 1 | The discriminator is **two-level**: `payload_type` selects the family, `payload.event.kind` selects the event. `record_type` is useless (constant). `tool_batch.*` / `approval_wait.*` families carry content in `payload.record`, not `payload.event`. | Map `(payload_type, event.kind \\| record.kind)` → canonical kinds; unknown pair → `agent.unknown`, preserved. |
| 2 | `recorded_at` is integer **microseconds** (sample magnitude 16 digits, Oct-2026 epoch). Never order by it alone (already the rule). | Convert µs→ISO on ingest; keep raw value in `source`. |
| 3 | **NEW vs prior spike**: 20 non-event lines with keys `(retained_marker, schema_version, stream, position {id, sequence}, omitted_record {record_type, durability, payload_type, payload_schema_version, payload_kind, omission_class})`. These are live-log compaction markers occupying no sequence numbers; the 9 sequence gaps in the sample (e.g. 1105→1107, 1565→1571 … 9 gaps total over seq 3–2896) align with them, and the export diagnostics confirm `gaps == omitted_live_only == 20`. | Reader must parse marker lines (not just the header frame), treat them as `capture.compaction` evidence with `omission_class`, and never count them as sequence gaps. |

`stream` is `{"kind": "session", "id": <session-id>}` on every parent line and `{"kind": "session", "id": <child-id>}` in child logs — observed. No parent id appears in the child envelope (linkage comes from the parent's link events + hook `SubagentStart`, see Child-log coverage).

## Payload taxonomy — observed (2895-line session)

`payload_type` counts: `runtime.session` 2669, `tool_batch.effect.started`/`terminal` 47/47, `run.model.configured` 18, `runtime.retained_fact` 18, `runtime.user_intent.accepted`/`materialized` 18/18, `approval_wait.effect.started`/`terminal` 9/9, `reminder.cleanup_effect.*` 5/5, `runtime.command_intake.received`/`settled` 2/2, singletons (`metadata`, `route_facts`, `session_start.intake_v3`, `session.started`, `session.opened.observed`, `capture_selection`, `startup_phases.observed`, `subscription.entrypoint.impression`, `login.completed`, `model_reconfigure.completed`), 20 markers, 1 header frame. Counts are field-name/count data — observed.

Key `runtime.session` inner kinds (key names + value types only):

| Inner kind (n) | Shape (keys only) → Echo canonical |
| --- | --- |
| `proposed/accepted/scheduled` (187/184/184) | `{kind, task_id[, task_kind, idempotency_key]}` — the task state machine spine. `scheduled` carries `idempotency_key`. |
| `side_effect_intent` (184) | `{kind, operation, policy_decision, idempotency_key, task_id, parent_task_id, cancellation_handle, ...}` → `tool.requested` + approval attribution. `operation` is the `tool:<name>` string (cookbook corroborates `tool:bash`). |
| `completed/failed/cancelled/rejected/terminal` (175/5/4/3/18) | `{kind, task_id[, reason]}` (+`run_id`); `terminal` is the run end `{terminal, turn_duration_ms}`. `failed`/`cancelled` carry `reason`. → `tool.completed/failed`, `turn.ended/failed`. |
| `assistant_tool_calls_committed` (39) | `{message_id, response_id, tool_calls[]}`, each `{id, call_id, name, args: str}`. Args are a **string** (JSON-encoded), not an object. → `tool.requested` with `tool_call_id = call_id`. |
| `tool_result_batch_committed` (39) | `{batch_id, results[]}`, each `{tool_call_id, tool_call_index, text, estimated_prompt_tokens}`. Joins to requests on `tool_call_id`. → `tool.completed`. |
| `tool_batch.effect.started/terminal` (47/47, separate `payload_type`) | `payload = {kind, record, run_id}`; `record = {kind, call_id, effect_id, model_call_index, task_id, task_stream{id,kind}[, tool_name] [, outcome{kind,reason}]}`. The `started → terminal` pair brackets each effect; `effect_id` is the join key. |
| `requested` (9) + `decision_applied` (9) + `approval_wait.*` (9/9) | `requested`: `{pending_action_id, tool_call_id, tool_name, available_choices[], candidate_decisions[], approval_subject{...}, task_stream, session_stream, ...}`; `decision_applied`: `{decision, policy_result, decision_source{kind, action_digest}, pending_action_id, ...}`; `approval_wait.started record = {pending_action_id, tool_name, tool_call_id, task_id, task_stream, run_stream}`. `pending_action_id` threads the whole chain. → `approval.requested/decided`. |
| `model_input_trace_recorded` (56) | `{model_step, provider_family, scope, request_message_count, request_digest, bounded{aggregates[], head/tail samples, byte/omission counters}, ...}` — bounded digests/samples, not full prompts. → `model.call` metadata. |
| `model_response_created` / `model_completed` (53/53) | `{response_id}` / `{model, finish_reason, duration_ms, usage{input/output/reasoning/cache tokens}, estimated_prompt_tokens}`. → `model.response` + spend ledger. `model` is the resolved model id string. |
| `reasoning_committed` (52) | `{message_id, provider_item_id, response_id, encrypted_content: str, text: str}` — **both** fields present as strings. Whether `text` is readable when `show_reasoning` is on is still untested; `encrypted_content` is opaque per the cookbook. → label `agent_stated` only if `text` proves readable; never ingest `encrypted_content` beyond its presence. |
| `reasoning_summary_delta` (22) / `reasoning_summary_committed` (14) | `{message_id, summary_index, text}` — the live status-row summary stream. → candidate `agent_stated` (short). |
| `assistant_message_committed` (42), `output` (47) | `{message_id, provider_item_id, response_id, text}` / `{chunk: str, final_result: bool, task_id}`. → assistant text evidence. |
| `runtime.user_intent.accepted` (18) | carries `model_messages: [{content: [{kind, text}]}]` (prior spike) — the user-prompt path. → `prompt.submitted`. |
| `tool_output_ref` (6) | `{availability, output_ref{id, kind, path, uri, byte_len, media_type, digest, patch_summary}, task_id}` — pointer into `tool-outputs/<id>/`. Reader must resolve large results via this ref, not the inline `text`. |
| `task_stream_linked` (187), `memory_reminder_child_session_linked` (81) | `{task_id, task_stream{id,kind}[, execution_mode, display{label,model,role}]}` / `{child_session_id, parent_session_id, parent_run_id, reminder_agent_id, generation_id, task_id, task_stream}`. → `subagent.started` linkage, ID-based (no timestamp guessing). |
| `status` (137), `context_block_diagnostic` (187) | `{details, message, task_id}` / `{action, lifecycle, reason, block_id, max_bytes, text_bytes, ...}` — checkpoint/trim diagnostics feed. |
| `model_request_configured` (17), `provider_request_options_configured` (56), `goal_usage_attribution` (178), `resource_usage_sampled` (26) | config/usage metadata; attribution record shape `{kind, record}`. Spend/ledger material. |

## Sequence handling — observed

- Parent log: sequences 3–2896 (1–2 live inside the header frame's embedded `record_json`, as the prior spike found). 2874 event lines + 20 marker lines + 1 frame = 2895 lines. 9 jumps, all aligning with marker blocks; `muse export` diagnostics confirm `gaps: 20, omitted_live_only: 20, duplicate_records: 0, unknown_payload_kinds: 0, unparseable_lines: 0`.
- Reader rule (unchanged, now grounded): `capture.gap` only for jumps with **no** adjacent marker; marker-adjacent jumps are `capture.compaction`. Dedupe key: `(stream.id, sequence)` primary, `(id)` secondary; the frame's embedded records must be deduped against live lines on resume.
- `causation_id` present on all event lines — carry in `source` for finer causal threading than sequence alone.

## Compaction / checkpoint behavior — observed + first-party

- Live markers (above) + `peer-history.sqlite3`: `schema_meta{schema_version}`, `source_snapshot{source_identity, source_len=9439, target_stream_kind/id, target_records_complete=0, anchor_start=8672, anchor_end=9439, anchor_sha256}`, `retained_records` 10 rows holding sequences **3–12** (the frame region), `stable_ids` empty. The sqlite is the trimming ledger: retained line ranges with `raw_sha256`; `target_records_complete=0` while the session is open.
- First-party pin: changelog 1.4.11 — "Long sessions trim covered records at checkpoints instead of growing without bound" (`dev.meta.ai/docs/muse-code/changelog` — observed). 1.4.13 notes add `muse usage` allowance display and checkpoint-resilience fixes, no log-format change stated.
- Reader consequence: expect trimmed history in long sessions; live tailing is the primary path, export is reconciliation — exactly ARCH §8's stance, now evidenced.

## Export-vs-live reconciliation keys — observed

One `muse export --session <uuid> --redacted --out <0700-temp>/traj.json` on the 2895-line session (offline, no quota; temp deleted afterwards). Top-level keys: `export_schema_version (=1), redaction (="redacted"), exporter_version{display,semver,sha}, session_build{display,semver,sha}, session_terminated_abnormally (=true — session still open; cookbook: true means "no orderly end recorded"), sessions[1]{session_id, root_session_id, trajectory_id, turn_count, step_count, accepted_spawns, saw_history_gap, is_copied_context}, events[2895], diagnostics` (above).

- Export events reframe each live line as `{kind, envelope, derived, outer_log_ordinal}` with `kind ∈ {record (2874), gap (20), retained_frame (1)}`. `derived = {decoded, session_id, step_id, trajectory_id, turn_count[, model]}` — `step_id`/`trajectory_id`/`turn_count` are export-only join keys with no live-log counterpart; the reconciler must mint its mapping from them (e.g. `trajectory_id` ↔ Echo `session_id`, `step_id` ↔ `source.sequence`).
- `session_build` vs `exporter_version` gives the pin pair (build that ran vs build that exported); both carry `{display, semver, sha}`.
- `--redacted` runs payload strings through telemetry redaction rules; per the cookbook (`dev.meta.ai/docs/cookbook/audit-agent-sessions` — observed) encrypted reasoning blobs stay verbatim in both modes and redaction never rewrites the original log. Echo must still re-redact the export stream before parsing/storing (ARCH §8 rule stands).
- `muse trace inspect --session-log <jsonl> [--run-id|--all-runs] [--causal] [--max-text-bytes N] --format text|json` exists (`muse trace inspect --help` — observed) and can project run streams plus hashed workflow-child runs mirrored into the parent log; useful as a cross-check for the reader's child-lane assembly, not as the reader itself.

## Child-log coverage — observed

- Layout: `subagent/<child-id>/session.jsonl`, same 11-key envelope, `stream.id = <child-id>`, own header frame. Sampled child: 35 lines; sibling logs run 33–40 lines. The 2895-line parent fans out to ~28 child logs (paired ids, e.g. `01a17d72-3407…` / `01a17d72-3438…`); the 3956-line parent to ~24. No `peer-history.sqlite3` beside child logs.
- Parent→child linkage is explicit and ID-based: `memory_reminder_child_session_linked` carries `{child_session_id, parent_session_id, parent_run_id}`; `task_stream_linked` carries `{task_id, task_stream{id,kind}}`. No timestamp inference needed.
- Child→parent linkage inside the child log was **not** observed in the sampled child (no `parent_*` key beyond `parent_task_id: null`; child has its own `task_stream_linked` with its local `task_stream`). Link children from the parent side + hook `SubagentStart{ subagent_id, child_session_id }` (hook-events reference — observed). Mark `capture.gap{subagent_id}` when a referenced child log is missing — export omits nothing here by default (`accepted_spawns`, `saw_history_gap` flags exist to verify against).

## Build and schema pinning — observed

Store per session: `muse --version` output (`Muse Code 1.4.13 (1.4.13-R6996.1)`); sessions root + resolved source path; observed envelope key set + `(payload_type, event.kind)` taxonomy hash; `export_schema_version` (=1); `metadata.workspace_root` + `route_facts.cwd` for project attribution; `runtime.session.metadata` build `{semver, sha}`; redaction mode (`redacted` vs `raw`); Echo adapter version. `muse schema generate-ts` (offline, exact for the binary; `msp.d.ts`, 240 KiB stable surface, mentions of `SessionLog`, `retained_*`, `omitted_*`, `compaction_*` types) is the candidate adapter-type generator — reconciliation of wire types against log taxonomy is still open.

## Redaction surfaces — observed

Echo-owned storage must be gated, but the following native surfaces stay raw outside Echo: `session.jsonl`, `session.peer-history.sqlite3`, `cli-<uuid>.log`, `cron.db`, `tool-outputs/<id>/` (+`.spool/`), `input-assets/v1/sha256/..`, `approval-review/`, `.session.lock`. `--redacted` cleans only the exported copy. Disclose all of them (ARCH §8 lists only some). `show_reasoning` is off by default and independent of the summary line (`dev.meta.ai/docs/muse-code/interactive` — observed); `agent_stated` must not depend on it.

## Consequences for the capture-muse build

1. Discriminator is `(payload_type, payload.event.kind | payload.record.kind)`; `record_type` is constant. Unknown pairs → `agent.unknown`, preserved with hash.
2. Tool-call evidence joins on `tool_call_id` across three families: `assistant_tool_calls_committed` (args is a **string** — parse as JSON defensively), `tool_result_batch_committed` (inline `text` + `tool_output_ref` spillover), `tool_batch.effect.started/terminal` (join on `effect_id`, outcome in terminal record).
3. Approval evidence joins on `pending_action_id`: `requested → approval_wait.started → decision_applied → approval_wait.terminal → side_effect_intent{policy_decision}`. `decision_source{kind, action_digest}` is the "who allowed it" field.
4. Timestamps are µs ints; convert on ingest, keep raw, never order by them alone. `sequence` is authoritative per `stream.id`; marker lines occupy no sequence.
5. Marker lines (`retained_marker`/`omitted_record`/`omission_class`) are first-class `capture.compaction` evidence; only marker-less jumps are `capture.gap`. Persist `peer-history` anchor/retained rows as diagnostics.
6. Child events go into the parent tape on a `subagent` lane keyed by `child_session_id`/`task_stream.id`, linked from parent link events — never flattened as parent actions. Missing child log → `capture.gap`, not invention.
7. `reasoning_committed.text` and `reasoning_summary_*` are the only candidate `agent_stated` text; `encrypted_content` is excluded from tape and retrieval. No `show_reasoning` readability test yet — Q&A must work on observed evidence alone.
8. Export reconciliation keys: match on `(stream.id, sequence)` then `(record_type/payload_type/payload_kind + hash)`; carry `trajectory_id/step_id/turn_count` mapping; record `session_build` vs `exporter_version`; live wins for `observed_at`, export wins for completeness; conflicts keep both hashes + `capture.conflict`.
9. Deltas to fix in `ARCHITECTURE.md` §8: envelope key list (add `schema_version, id, stream, causation_id, payload_schema_version`; `record_type` constant); marker-line handling (absent); `tool_output_ref` → `tool-outputs/` resolution (absent); child linkage via `memory_reminder_child_session_linked` + `task_stream_linked` (stronger than assumed); hook table is now 19 events (`SessionFork`, `ToolUseStart` added) with 256 KiB stdin / 16 KiB stdout+stderr caps and a closed output schema (hook-events reference, checked against 1.3.0 — observed; out of reader scope but the §8 table is stale).
10. Trigger policy inputs exist natively: `PreToolUse.tool_input` (full args, JSON or raw string or `{}`), `PostToolUse.tool_response`, `PostToolBatch.tool_calls[]`, `Pre/PostLLMCall` previews (256-char message previews), `PreCompact.trigger`, `SubagentStart/Stop` ids — all from the hook-events reference (observed). Hooks stay timing/snapshot drivers, never transcript authority.

## Next prerequisite

Still unobserved (all need a runnable session, currently blocked on allowance): live-tailer attach/resume behavior on a running session; whether `PreCompact`/`PostCompact` hooks fire around marker emission; `show_reasoning` `text` readability; interrupted-tool `unknown`-outcome shape (`session.terminated_abnormally=true` export seen, but no in-flight intent without terminal observed); `muse --no-session-log` fallback evidence loss. Unblock path in order: restore subscription allowance (or `META_API_KEY`), then run the §9 fixture (file read, one edit, one failed tool, one reverted edit, one shell file change) in a scratch repo under `/tmp/opencode` and re-export.
