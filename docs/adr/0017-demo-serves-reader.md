# ADR 0017: Demo bundle serves the reader, not the story

Status: Accepted, 2026-11-03

## Context

ADR 0014 §i deleted the story pipeline and its routes, which orphaned
the demo: `demo build` required `story.json`, `demo verify` hit `GET
/api/sessions/:id/story` (now 404), and the only demo write-hole was
`POST /api/sessions/:id/progress`, which the reader added after the
demo's 403 list was written. Ask also lost its reader entry point, so
the demo page promised "ask why" with nowhere to ask it.

## Decision

a. The bake artifact is `changes.json`, validated strictly by a new
`ChangesArtifactSchema` in `@echo/contracts` (the server keeps its
lenient forward-compat reader; the builder must prove what it ships).
Sessions with zero reviewed changes cannot bake. Bundle meta is
version 2; version 1 means story-era.
b. The builder wipes `change_refs` and `change_progress` so visitors
start un-progressed, and runs full-table wipes before narrowing
parents (both tables carry session REFERENCES; wiping after tripped
foreign-key enforcement on real databases).
c. `POST /api/sessions/:id/progress` is 403 `readonly_demo` in demo
mode, like every other demo mutation. `GET /changes` and `GET
/changes/:changeId/code` are served baked as-is (both are read-only).
d. The demo page hosts ask: an "Ask why" button opens the existing
`AskThreadPanel` slide-over unanchored, with citation clicks landing
on the session reader. No reader changes — the reader's ask product
call stays deferred.
e. The bundle scanner treats `[REDACTED:*]` placeholders as empty
values (`""`), not absent text: stripping to empty glued `KEY="` to
trailing code in redaction-test fixtures and the env-assignment rule
matched the code as a secret.

## Consequences

- Smoke is 11 checks: reader changes, change code diffs, baked
generate, MCQ grading, off-tape refusal, judgment-call 503, skip 403,
progress 403, unknown-session 404, web index.
- Story-era bundles (meta v1) are not served; rebake from a live data
dir. `demo build` from a bundle's own data dir still works for v2.
- Builder-side reading state never ships; per-visitor ask/check
overlays stay memory-only as before.
