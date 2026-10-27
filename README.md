# Echo

Replay what your coding agent did and why. Then prove you understood it before you approve.

Echo is a local-first recorder and review loop for coding-agent sessions. It records a normal interactive Muse Code session, replays the captured actions and file states, answers questions only from evidence on the tape, and checks understanding by running code instead of trusting a feeling of understanding.

Built during the Meta Global AI Developer Hackathon 2026 (Oct 27 to Nov 4). Muse Code is Meta's agent; Echo is the recorder and review layer.

## Status

This repository is at the scaffold stage: workspace tooling, package boundaries and runnable app shells. Capture, replay, Q&A and checks are the next implementation steps.

- pnpm workspace with `@echo/*` packages and `apps/{cli,server,web}`
- Fastify daemon shell with `GET /api/health`
- Vite + React + Tailwind review UI shell with the planned routes
- `echo-cli` binary shell
- SQLite/Drizzle, shadow Git, redaction, model and sandbox packages stubbed at their boundaries

## Layout

```text
apps/
  cli/                     @echo/cli, bin: echo-cli
  server/                  @echo/server, bin: echo-daemon
  web/                     @echo/web, Vite React SPA
packages/
  contracts/               Zod schemas, API types, tape types, error codes
  core/                    IDs, time, result types, domain constants
  config/                  paths, config load/validate, secrets lookup
  db/                      Drizzle schema, migrations, repositories
  tape/                    tape writer/reader, validation, repair, merge
  capture/                 adapter interface, orchestrator, spool, reconciliation
  capture-muse/            Muse hook translator, native-log reader, export reconciler
  capture-opencode/        OpenCode V2 plugin and adapter (optional)
  snapshots/               shadow Git repo, manifest, snapshotter, blame queries
  redaction/               detectors, placeholders, preview, policy
  retrieval/               evidence bundle builder, FTS ranking, token budget
  model/                   provider interface, Meta/Baseten clients, structured output, cache
  checks/                  hunk scoring, generation, verification gate, grading, calibration
  sandbox/                 runner interface, container/bwrap/WASM backends
  graph/                   TypeScript import graph and project overlay
  notifier/                desktop notification, browser open
  fixtures/                fixture builders used by tests and evals
```

## Development

Requires Node 24 and pnpm 12.

```sh
pnpm install
pnpm dev          # daemon on 127.0.0.1:4783 and Vite on :5173
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The web dev server proxies `/api` to the daemon. Model keys are read from `META_API_KEY` and `BASETEN_API_KEY`; see `.env.example`.

## Design decisions

Ground truth lives in the repo:

- [`docs/echo-spec.md`](./docs/echo-spec.md) — product spec. Where spec and architecture disagree on product intent, the spec wins.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — technical mechanism. Each section maps to the packages above; §23 is the build order.
- [`docs/adr`](./docs/adr) — accepted architecture decisions.
- [`docs/spikes`](./docs/spikes) — real-session notes and observed Muse schemas, written as the spikes in §27 run.

