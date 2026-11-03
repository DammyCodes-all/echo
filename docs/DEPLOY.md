# Deploying the hosted demo

Host-neutral notes. No host chosen yet; this works anywhere that runs a
Docker image (Fly, Render, Railway, Cloud Run, a VPS).

## What the image is

`Containerfile` builds the server in `demo` profile plus a pre-baked bundle:

- read-only API over one baked session (ingest and write routes return 403)
- static web UI served from the bundle
- per-IP rate limits + global daily budgets (in memory; a restart resets
  counters, which is allowed)
- no volumes, no database service, no background jobs

The bundle is build input, not repo content: it lives in `demo-bundle/`
(beside the `Containerfile`), which is gitignored. Bake it on your machine,
then build the image in the same directory.

## Bake

```sh
pnpm build
node apps/cli/dist/index.js demo build --session <id> --out demo-bundle
node apps/cli/dist/index.js demo verify --dir demo-bundle
```

`demo build` bakes the session (tape, snapshots, story), scans for leaked
secrets, and smoke-tests the bundle. It fails closed: fix the finding,
don't ship around it. The source session stays on your machine; only the
redacted bundle ships.

## Build and run

```sh
docker build -t echo-demo .
docker run -p 8080:8080 -e META_API_KEY=... echo-demo
```

Then open `http://localhost:8080` and walk the golden path: inbox, story,
one card, one check. The container listens on `$PORT` when the host injects
one, otherwise 8080.

## Environment

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `META_API_KEY` | yes, as a secret | — | Never baked into the image. Without it, model paths are unavailable and stories fall back to skeletons. |
| `ECHO_MODEL_PROVIDER` | no | meta | `baseten` for the open-weights path. |
| `BASETEN_API_KEY`, `BASETEN_BASE_URL`, `BASETEN_MODEL_ID` | if baseten | see `.env.example` | |
| `ECHO_DEMO_ASK_PER_MIN` | no | 5 | Per-IP ask rate. |
| `ECHO_DEMO_ANSWER_PER_MIN` | no | 20 | Per-IP answer rate. |
| `ECHO_DEMO_MAX_ASKS_DAY` | no | 200 | Global daily ask budget. |
| `ECHO_DEMO_MAX_ANSWERS_DAY` | no | 500 | Global daily answer budget. |
| `ECHO_DEMO_MAX_TOKENS_DAY` | no | 5000000 | Token proxy for the spend cap. |
| `PORT` | host sets it | 8080 | Mapped to `ECHO_PORT` at boot. |

Set secrets through the host's secret mechanism, not `docker run` history
on a shared box, and not in any committed file.

## Before you hand judges the URL

- Cold open reads the story in under 60 seconds.
- Ask + check work with the key set, and degrade cleanly without one.
- Rate caps trigger correctly (limited blast radius if the URL leaks).
- The bundle contains no raw secrets (`demo build` already scanned it;
  re-verify after any re-bake).
