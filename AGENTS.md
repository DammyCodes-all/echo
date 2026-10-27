# AGENTS.md

Working rules for any agent operating in this repository.

## Ground truth

- Product intent: [docs/echo-spec.md](docs/echo-spec.md). Mechanism: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- A conflict on intent is settled by the spec; a conflict on mechanism by the architecture. A call neither document settles becomes an ADR in `docs/adr/` (next number, same format).
- Observed Muse schemas and external API facts live in `docs/spikes/`. An API shape recalled from memory is a guess; verify it or record it as a spike item.

## Working agreement

- Build the confirmed phase only, then checkpoint: report what is done and verified, and stop. Starting the next phase's work is a scope expansion — stop and ask, with options and a recommendation.
- Everything in this repo is built during the event (Oct 27 – Nov 4, 2026). Flag any code or asset that predates the event before it lands.
- Installs and registry operations belong to the user. When a dependency is missing, hand over a paste-safe one-line command and verify the result read-only afterwards.
- The user owns git history. Stage and commit nothing; propose a conventional-commit message when asked.
- For a decision that shapes later work and is genuinely balanced, ask via the interactive question tool with concrete options and a recommendation. Otherwise decide, then state the decision and its reason in the reply.

## Code rules

- Import direction is part of the contract (ARCHITECTURE §4): `web` imports `@echo/contracts` only; the model package never imports `@echo/db`; capture adapters never import the server; only the server composes packages.
- Every write to Echo-owned storage passes the redaction gate first — tape, shadow Git, SQLite, spool, artifacts, model requests. A redaction failure drops the content and records a content-free diagnostic.
- Gaps are data. Missing snapshots, sequence jumps, unknown outcomes and schema drift become diagnostics; a fabricated record is a product failure.
- Evidence carries a label: `observed`, `agent_stated`, or `uncertain`. Inference is never rendered as the agent's reasoning.
- Validate at system boundaries only: hook payloads, native log lines, model output, HTTP input, config. Internal code trusts its callers.
- Ship complete units: no half-finished flows, no compatibility shims, no speculative abstractions. Three similar lines beat an early helper.
- Logs go through pino in server and CLI; `console.log` stays out of server and CLI code.
- Comments carry non-obvious why only — hidden constraints, workarounds, invariants.

## Tests

- Changes to `packages/*` logic land with colocated vitest coverage (`*.test.ts` beside the source). UI is exempt until the Playwright phase exists.
- Tests are deterministic: fixtures over network, injected clocks where ordering matters, fixture repos under `fixtures/`.

## The gate

Before reporting any work done:

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

- UI changes additionally run in the browser: start `pnpm dev`, exercise the golden path plus one edge case, and close your processes afterwards.
- Capture changes additionally verify against the fixture sequence (ARCHITECTURE §22), asserting what was captured and what was missed.

## Environment gotchas

- TypeScript 7 removed `baseUrl`: `paths` entries in `tsconfig.json` must be relative (`"./..."`).
- pnpm blocks install scripts by default. A new native dependency goes into `onlyBuiltDependencies` in `pnpm-workspace.yaml`, and the user approves it with `pnpm approve-builds <pkg>`.
