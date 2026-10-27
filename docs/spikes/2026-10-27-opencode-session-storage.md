# Spike: OpenCode V2.1.4 — session storage and plugin surface (observed)

Date: 2026-10-27. Spike run on this machine after Muse credential loss (see `2026-10-27-muse-providers-and-access.md`). OpenCode V2 is the documented second capture path (ARCHITECTURE §9, `capture-opencode`).

**Result: PASS for storage schema; plugin surface delta vs docs confirmed.** One live `agentrouter/gpt-6.1-sol` session (user's AgentRouter config) was run in the scratch repo and its durable records inspected. Schema-level only; no conversation content in this note.

## CLI and storage

- `opencode v2.1.4`. Config: `~/.config/opencode/opencode.json` (provider `agentrouter`, `@ai-sdk/openai-compatible`, custom `models` entries with `variants`/`reasoning_effort`). Plugins: `~/.config/opencode/plugins/*.js`.
- Durable store is **SQLite**, not JSONL: `~/.local/share/opencode/opencode.db` (+WAL). Key tables:

| Table | Rows | Notable columns |
| --- | --- | --- |
| `session_v2` | 19 | `id` (`ses_…`), `project_id`, `directory`, `title`, `model`, `agent`, token/cost summaries, `time_compacting`, `revert`, `permission` |
| `session_message` | 706 | `id`, `session_id`, `type` (`user`/`assistant`/`system`), `seq`, `data` (JSON blob) |
| `event` / `event_sequence` | 0 / 20 | Append-only event log with per-aggregate sequences — present but empty in normal use; live events flow through the server API instead |
| `project` | 2 | `worktree`, `vcs`, `sandboxes`, `commands` |
| `credential` | 1 | `integration_id`, `value` — provider credentials live here |
| `permission` | 0 | `action`, `resource` — approval records table |

## Message and part shapes (observed)

`session_message.data` for `assistant` messages:

- `content` is a **list of typed parts**: `reasoning` (`text`, `native`, `time`), `tool` (`id`, `name`, `state{status, input, content}`, `executed`, `native`), and text/step parts in completed runs.
- **`snapshot: {start: <git-oid>, end: <git-oid>}`** — OpenCode records the repo HEAD before and after each assistant message. Free file-state provenance anchored to real Git commits in the user's repo (a different model than Echo's shadow repo; both can be represented in Echo contracts as snapshot references with provenance).
- `model: {id, providerID, variant}` — model attribution per message.
- A killed mid-run session degrades gracefully: later messages carry `snapshot.start` only; partial runs are visible, not fabricated.
- `reasoning` parts carry readable text with a `native` flag — `agent_stated` evidence exists in OpenCode records (unlike Muse's encrypted reasoning).

## Plugin surface delta vs ARCHITECTURE §9

The documented surface (`ctx.tool.hook("execute.before"/"execute.after")`, `ctx.event.subscribe`, `ctx.session.list/get`) does not match what the installed 2.1.4 accepts. The user's working plugin uses:

```js
export default Plugin.define({ id, async setup(ctx) {
  await ctx.session.hook("http.request",  (event) => {...}, { providerID })
  await ctx.session.hook("http.response", (event) => {...})
}})
```

i.e. **`ctx.session.hook` with `http.request` / `http.response` channel names**. Consequences:

1. ARCHITECTURE §9's plugin mapping needs a revision before `capture-opencode` is built; treat §9 as documented-not-current until a plugin probe exercises tool/event hooks on 2.1.4.
2. An http-level hook sees model traffic (SSE frames) but not tool semantics — tool-level capture still needs a tool/event hook probe (follow-up).

## Follow-up observations (same day, read-only re-check)

- **`snapshot.start`/`snapshot.end` are tree OIDs, not commit OIDs.** `git cat-file -t 853694a…` returns `tree`; `readCommit` fails. The adapter's shadow reader therefore accepts both commit and tree OIDs.
- **Sequence numbers are sparse, not contiguous.** One real session stored messages at `seq` 5, 6, 8, 34, 61, 83. A sequence jump alone is not evidence of a missing record; only a lower maximum on re-import (reset) or a vanished message id is.
- **Assistant parts carry their own timestamps**: `reasoning` has `time.created/completed`; `tool` has `time.created/ran/completed`. Tool events use `time.created` when present instead of the message timestamp.
- **`idle` messages carry the turn outcome**: `{ time, outcome, error: { type, message, status, response } }`. Observed `outcome: "failed"` with `error.type: "provider.rate-limit"` and `code: "no_capacity"`. Echo maps this to `turn.failed` and stores only the bounded error summary.
- **`session_v2.model` is a JSON string** such as `{"id":"gpt-6.1-sol","providerID":"agentrouter"}`; `agent` can be null. Echo keeps the raw value in the tape and a `provider/id` label for display.

## Consequences for Echo

1. `capture-opencode` reads SQLite (`session_v2`, `session_message`), not a JSONL tail: recovery/reconciliation is queryable rather than tailed — weaker "live" story than Muse, stronger replay story.
2. The canonical event envelope needs `snapshot` refs (git OIDs) as a first-class link type, and `reasoning` → `agent_stated` with a `native` flag.
3. A read-only SQLite connection suffices for import; the daemon must open it `mode=ro` and never write.
4. Next probe (task follow-up): a minimal capture plugin on 2.1.4 exercising `ctx.session.hook` with tool/event channels, and the `event` table's write path via `opencode serve`.
