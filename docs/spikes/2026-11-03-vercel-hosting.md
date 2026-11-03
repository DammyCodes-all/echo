# Vercel Hosting for Echo Demo — Research Spike

Date: 2026-11-03
Question: Can the Echo demo (`apps/server` in `ECHO_MODE=demo`, Fastify on `$PORT`, SQLite via `better-sqlite3` WAL, shadow git repo + `git` CLI, static `demo-bundle/web`) be hosted on Vercel as-is?

## Verdict

**Partial / Not recommended — technically bootable via the Container Runtime (Beta) with zero code change, but a poor fit for the demo's architecture. `No` for a production-quality, zero-refactor lift on the standard Node runtime; `Partial` only if you accept Vercel's function model and ephemeral storage tradeoffs.**

The demo is a long-running stateful container (SQLite file + WAL, git on disk, in-memory rate-limit maps, healthcheck) built for Fly / Render / Cloud Run. Vercel is a request-driven Functions platform (including container Functions) that scales to zero, has a read-only filesystem, bounded invocation duration, and no persistent local disk. You can shoehorn the Docker image into Vercel, but you lose the invariants the demo relies on.

## What Vercel Offers

### 1. Request-driven Functions, including container Functions
- Vercel runs code as **Vercel Functions** — one invocation per request, auto-scales with traffic, scales to zero when idle. Fluid compute multiplexes concurrent requests per instance [https://vercel.com/docs/functions](https://vercel.com/docs/functions).
- Multiple **runtimes**: Node.js, Python, Go, Rust, Bun, Edge, and **Container** (any OCI image from a `Dockerfile`/`Containerfile`) [https://vercel.com/docs/functions/runtimes](https://vercel.com/docs/functions/runtimes).
- Express/Fastify style apps are explicitly supported: "Vercel bundles your entire Express app into a single Vercel Function. Every incoming request goes to that function" on Fluid compute, subject to the 250 MB bundle limit [https://vercel.com/kb/guide/ship-a-express-app-on-vercel](https://vercel.com/kb/guide/ship-a-express-app-on-vercel) ; also [https://vercel.com/docs/functions/runtimes/node-js](https://vercel.com/docs/functions/runtimes/node-js) notes full Node.js API coverage and Node 24 LTS support (build image supports `22.x`, `24.x`, `26.x`) [https://vercel.com/docs/builds/build-image](https://vercel.com/docs/builds/build-image).

### 2. Container Runtime (Beta)
- Beta runtime available on all plans: build an OCI image from a root `Dockerfile`/`Containerfile` (or per-service `Dockerfile`), push to Vercel Container Registry (VCR), route all traffic to it as a Function. `Dockerfile.vercel`/`Containerfile.vercel` takes precedence over framework detection [https://vercel.com/docs/functions/runtimes/container](https://vercel.com/docs/functions/runtimes/container); confirmed in [https://vercel.com/kb/guide/does-vercel-support-docker-deployments](https://vercel.com/kb/guide/does-vercel-support-docker-deployments).
- Image total size up to **15 GB** compressed layers, 2 GB per layer, 2M filesystem entries; storage $0.10/GB [https://vercel.com/docs/container-registry/limits-and-pricing](https://vercel.com/docs/container-registry/limits-and-pricing).
- Serves HTTP on port `80` by default, override via `PORT` env var — compatible with Echo's `ECHO_PORT=${PORT:-$ECHO_PORT}` pattern [https://vercel.com/docs/functions/runtimes/container](https://vercel.com/docs/functions/runtimes/container).
- Scale-in: idle functions scale down after **5 min (production)** / 30s (preview), sending `SIGTERM` with 30s grace [https://vercel.com/docs/functions/runtimes/container](https://vercel.com/docs/functions/runtimes/container).
- Same Function limits and Active CPU pricing apply to container images [https://vercel.com/docs/functions/runtimes/container](https://vercel.com/docs/functions/runtimes/container).
- Local dev via `vercel dev` requires Docker daemon [https://vercel.com/kb/guide/does-vercel-support-docker-deployments](https://vercel.com/kb/guide/does-vercel-support-docker-deployments).

### 3. Long-running worker alternative: Daemons (Beta)
- **Daemons** run continuous container processes (queue consumers, workflow workers) from a `Dockerfile` with fixed instance counts per region, not request-driven, production-only during beta [https://vercel.com/docs/daemons](https://vercel.com/docs/daemons); limits: 1/2/4/8 GiB memory, ephemeral storage only [https://vercel.com/docs/daemons/limits](https://vercel.com/docs/daemons/limits).
- Not a fit for the demo HTTP server (daemons receive **no inbound HTTP/TCP** [https://vercel.com/docs/daemons/limits](https://vercel.com/docs/daemons/limits)) but relevant if Echo later needs background ingest workers.

### 4. Durations, memory, bundle limits (Fluid compute)
- Max duration: **Hobby 300s** (default=max), **Pro/Enterprise 800s** max (1800s extended beta for `nodejs22.x`/`24.x`/`26.x`) [https://vercel.com/docs/functions/limitations](https://vercel.com/docs/functions/limitations); also summarized at [https://vercel.com/docs/limits](https://vercel.com/docs/limits).
- Memory: **Hobby 2 GB/1 vCPU**, **Pro/Enterprise up to 4 GB/2 vCPU** (daemons up to 8 GB) [https://vercel.com/docs/functions/limitations](https://vercel.com/docs/functions/limitations).
- Bundle: **250 MB uncompressed** (500 MB Python, 5 GB Large Functions beta with `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` on Node/Bun/Python) [https://vercel.com/docs/functions/limitations](https://vercel.com/docs/functions/limitations).
- Proxied request timeout 120s, build time 45 min caps also apply [https://vercel.com/docs/limits](https://vercel.com/docs/limits).

### 5. Filesystem & state model
- Standard Node/Bun Functions: **read-only filesystem with writable `/tmp` up to 500 MB**; archived when idle (production 2 weeks) with ~1s extra cold start [https://vercel.com/docs/functions/runtimes](https://vercel.com/docs/functions/runtimes).
- Container comparison explicitly states: "Instance-local data is temporary; use external services for durable state" and "local memory and files are not durable storage" [https://vercel.com/kb/guide/docker-on-vercel-vs-render](https://vercel.com/kb/guide/docker-on-vercel-vs-render) and [https://vercel.com/kb/guide/does-vercel-support-docker-deployments](https://vercel.com/kb/guide/does-vercel-support-docker-deployments).
- Daemons also have **no persistent local storage** [https://vercel.com/docs/daemons/limits](https://vercel.com/docs/daemons/limits).
- Storage guidance: Vercel directs apps to **Blob** (files), **Global Config**, or **Marketplace databases** (Neon, Upstash, Supabase) and notes to co-locate functions near data [https://vercel.com/docs/storage](https://vercel.com/docs/storage).

### 6. Native modules & system deps
- Node runtime claims **"Full Node.js coverage"** [https://vercel.com/docs/functions/limitations](https://vercel.com/docs/functions/limitations) and builds on **Amazon Linux 2023** [https://vercel.com/docs/builds/build-image](https://vercel.com/docs/builds/build-image); native deps must target Linux `x64` — Build Output API warns local builds may mismatch and recommends Linux `x64` matching the build image [https://vercel.com/docs/build-output-api](https://vercel.com/docs/build-output-api).
- Container runtime avoids this by letting you control the base image and `dnf` installs [https://vercel.com/docs/builds/build-image](https://vercel.com/docs/builds/build-image) — so `better-sqlite3` and `git` are only reliably packaged via container, not via standard Node Function without extra install commands.
- Build-time `dnf install -y` is supported [https://vercel.com/docs/builds/build-image](https://vercel.com/docs/builds/build-image).

## Misfits for Echo

| Echo Requirement | Why Vercel breaks it (with source) |
|---|---|
| **Long-running Fastify server** (`node dist/index.js` listening on `$PORT`, healthcheck on `/api/health`) | Vercel Functions are **invocation-bounded** (300–1800s) then terminated with `FUNCTION_INVOCATION_TIMEOUT` [https://vercel.com/docs/functions/limitations](https://vercel.com/docs/functions/limitations) and [https://vercel.com/docs/functions/configuring-functions/duration](https://vercel.com/docs/functions/configuring-functions/duration). Even container Functions scale to zero after 5 min idle and receive `SIGTERM` [https://vercel.com/docs/functions/runtimes/container](https://vercel.com/docs/functions/runtimes/container). There is no always-on instance; Echo's healthcheck model assumes a persistent process. |
| **`better-sqlite3` native addon** (requires compiled `.node` binary) | Standard Node Functions bundle on build host Linux x64; local macOS/ARM builds will mismatch unless built on Linux x64 [https://vercel.com/docs/build-output-api](https://vercel.com/docs/build-output-api). Works only if the Vercel build image happens to compile the addon correctly, but bundle limit is 250 MB (5 GB beta) [https://vercel.com/docs/functions/limitations](https://vercel.com/docs/functions/limitations). Container runtime sidesteps this (you `RUN pnpm install` inside `node:24-slim`), so this is a misfit only for the non-container path. |
| **SQLite file + WAL writes** (`demo-bundle/data/echo.sqlite` opened in WAL mode, plus ephemeral caches) | Standard Functions filesystem is **read-only except `/tmp` 500 MB** [https://vercel.com/docs/functions/runtimes](https://vercel.com/docs/functions/runtimes) — opening the DB at its baked path fails. Container ephemeral writes survive per-instance but are **not shared across instances and vanish on scale-down** [https://vercel.com/kb/guide/docker-on-vercel-vs-render](https://vercel.com/kb/guide/docker-on-vercel-vs-render). WAL writes from multiple concurrent instances would diverge; demo assumes single writer on local disk (Containerfile `COPY demo-bundle ./bundle` writable by app user). |
| **Shadow git repo `demo-bundle/data/projects/<id>/shadow.git` + `git` CLI / `isomorphic-git`** | No `git` binary in the microVM runtime by default; you would need a container or a custom `dnf install git` install command [https://vercel.com/docs/builds/build-image](https://vercel.com/docs/builds/build-image). Even then, writes to `.git` are ephemeral per the previous row. `isomorphic-git` pure-JS path helps but CLI fallback still needs the binary. |
| **Static asset serving `demo-bundle/web`** | Standard Vercel serves statics via `public/` + CDN and ignores `express.static()` on Functions [https://vercel.com/kb/guide/ship-a-express-app-on-vercel](https://vercel.com/kb/guide/ship-a-express-app-on-vercel). Container can serve from its own FS, but you lose CDN caching benefits. |
| **In-memory per-IP rate limits + daily token budgets** | Fluid compute runs multiple instances with **1,024 file descriptors shared across concurrent executions** and optimized concurrency [https://vercel.com/docs/functions/limitations](https://vercel.com/docs/functions/limitations). Each instance has isolated memory — budgets fragment across instances and reset on scale-to-zero. No cross-instance coherence. |
| **`$PORT` injection** | Container expects `PORT` (default 80) [https://vercel.com/docs/functions/runtimes/container](https://vercel.com/docs/functions/runtimes/container); Echo's `ECHO_PORT=${PORT:-$ECHO_PORT}` already handles this, so this one **is compatible** if you set `PORT` in Vercel project env. |
| **Bundle / image size for demo-bundle** | If kept as a file inside a Node Function bundle, the SQLite file + shadow repos + web assets count toward the **250 MB uncompressed** limit [https://vercel.com/docs/functions/limitations](https://vercel.com/docs/functions/limitations) (5 GB with large-functions beta). Container images allow **up to 15 GB** [https://vercel.com/docs/container-registry/limits-and-pricing](https://vercel.com/docs/container-registry/limits-and-pricing), so a large demo-bundle fits only via container. |

## What Would Need to Change

To make the demo *Vercel-native* (i.e., not just wrapping the Docker image), the closest compatible architecture is:

### Option A — Container Function (least change, still compromises)
1. Put `Dockerfile`/`Containerfile` at repo root (or `Containerfile.vercel` to override framework detection) and set framework to `container` [https://vercel.com/docs/functions/runtimes/container](https://vercel.com/docs/functions/runtimes/container).
2. Keep the multi-stage build: compile `better-sqlite3` inside `node:24-slim`, `dnf`/ `apt-get install git` (already present in builder stage), `COPY demo-bundle ./bundle`.
3. On startup, **copy** `echo.sqlite` into writable ephemeral space (e.g., `/tmp` or container writable layer) and open it there — WAL writes then succeed per-instance.
4. Accept: each instance gets its own SQLite copy (no global consistency), rate-limit state is per-instance and resets on the 5-minute scale-down `SIGTERM` [https://vercel.com/docs/functions/runtimes/container](https://vercel.com/docs/functions/runtimes/container), and you cannot use Secure Compute/Static IPs in container beta [https://vercel.com/docs/functions/runtimes/container](https://vercel.com/docs/functions/runtimes/container).
5. Remove healthcheck; Vercel provides platform health via the `PORT` and logs via `stdout`/`stderr` broadcast [https://vercel.com/docs/functions/runtimes/container](https://vercel.com/docs/functions/runtimes/container).

**Effort:** ~1–2 days. **Result:** boots, serves, but demo is no longer single-source-of-truth — reviewers on different instances see different WALs; reproducible for a hermetic read-only bundle only if you also make WAL writes fully ephemeral and disable any cross-invocation expectation.

### Option B — Stateless Functions + external data (true Vercel shape, most work)
1. Replace `better-sqlite3` + local SQLite file with a Vercel Marketplace Postgres (Neon/Supabase) or edge SQLite (Turso/libSQL) accessed via HTTP — Vercel's storage guidance explicitly points here [https://vercel.com/docs/storage](https://vercel.com/docs/storage).
2. Extract `demo-bundle/data/echo.sqlite` into a seeded external DB at deploy time (static import or build-time script).
3. Replace shadow git on disk with **Vercel Blob** or an external object store, or generate the git views at build time as static assets — local disk is not durable [https://vercel.com/docs/daemons/limits](https://vercel.com/docs/daemons/limits).
4. Rewrite server from long-running Fastify `listen()` to a single-export `fetch` handler per `api/index.ts` (the documented Express/Fastify pattern) [https://vercel.com/docs/functions/runtimes/node-js](https://vercel.com/docs/functions/runtimes/node-js) / [https://vercel.com/kb/guide/ship-a-express-app-on-vercel](https://vercel.com/kb/guide/ship-a-express-app-on-vercel) — effectively re-architecting the server as serverless routes.
5. Move per-IP rate limits and daily token budgets into an external KV (Upstash Redis via Marketplace) since memory is per-instance and ephemeral [https://vercel.com/docs/functions/runtimes](https://vercel.com/docs/functions/runtimes).
6. Enable Large Functions if bundle + deps exceed 250 MB [https://vercel.com/docs/functions/limitations](https://vercel.com/docs/functions/limitations) or use container services via `services` + `rewrites` [https://vercel.com/kb/guide/does-vercel-support-docker-deployments](https://vercel.com/kb/guide/does-vercel-support-docker-deployments).

**Effort:** 1–2 weeks (DB migration, blob migration, route splitting, rate-limit extraction). **Result:** idiomatic Vercel, but you have rewritten the demo's storage layer — the baked `demo-bundle/` concept disappears, and you now operate a real database.

### Option C — Build Output API static export
- Use `.vercel/output` primitives to pre-render as much of the demo as possible at build time (framework-defined infrastructure) [https://vercel.com/docs/build-output-api](https://vercel.com/docs/build-output-api). Viable only if the demo can be made fully static (no per-request SQLite queries). For Echo's interactive timeline it cannot, so this is not recommended.

## Recommendation

**Keep the demo on a container PaaS — Fly.io, Render, or Cloud Run — and do not host the current `demo-bundle` demo on Vercel for public evaluation.**

- Those platforms give you a **single long-running container** with a writable filesystem, WAL support, local git, in-memory coherence, and no invocation-duration cap — exactly what `Containerfile:36-45` (writable `bundle` dir, `ECHO_MODE=demo`, `WAL` mode) assumes. Vercel's container model is request-bounded and ephemeral (scale-to-zero after 5 min, per-instance disk) [https://vercel.com/docs/functions/runtimes/container](https://vercel.com/docs/functions/runtimes/container), [https://vercel.com/kb/guide/docker-on-vercel-vs-render](https://vercel.com/kb/guide/docker-on-vercel-vs-render).
- If Vercel is mandatory (e.g., team already on Vercel, want preview deploys for the web UI), prefer **Container Function (Option A)** only for a short-lived, read-only marketing demo where ephemeral WAL divergence is acceptable and rate limits can be lax. Pin `Node 24`, ensure the Dockerfile compiles `better-sqlite3` inside the image, and document that per-instance state is not shared.
- For a durable Vercel-hosted Echo (not just demo), invest in **Option B** (Neon/Postgres + Blob + KV for rate limits) — but weigh that against the cost of abandoning the `demo-bundle` hermetic artifact, which ARCH §18 explicitly treats as the demo's distribution unit. The re-architecture negates the bundle's value proposition.

In short: **Vercel can run the code; it cannot faithfully run the demo's *artifact* without compromise.** The closest honest Vercel story is "container Function for the HTTP demo, external services for anything that must persist," and even then Fly/Render remain simpler.

## Sources

- Vercel Functions overview (request-driven, Fluid compute, CDN) — [https://vercel.com/docs/functions](https://vercel.com/docs/functions)
- Runtimes, filesystem (read-only + `/tmp` 500 MB), archiving, microVM isolation — [https://vercel.com/docs/functions/runtimes](https://vercel.com/docs/functions/runtimes)
- Container Runtime (Beta) — Dockerfile at root, `PORT` handling, scale-in SIGTERM, same Function limits/pricing — [https://vercel.com/docs/functions/runtimes/container](https://vercel.com/docs/functions/runtimes/container)
- Does Vercel support Docker deployments? (OCI, VCR, port 80 default, `vercel dev` Docker requirement) — [https://vercel.com/kb/guide/does-vercel-support-docker-deployments](https://vercel.com/kb/guide/does-vercel-support-docker-deployments)
- Docker on Vercel vs Render (state is temporary, durable external storage, always-on vs scale-to-zero) — [https://vercel.com/kb/guide/docker-on-vercel-vs-render](https://vercel.com/kb/guide/docker-on-vercel-vs-render)
- Vercel Functions limits — max duration (300/800/1800s), memory (2/4 GB), bundle 250 MB / 5 GB beta, file descriptors 1,024, full Node API — [https://vercel.com/docs/functions/limitations](https://vercel.com/docs/functions/limitations)
- General limits — proxied timeout 120s, build 45 min — [https://vercel.com/docs/limits](https://vercel.com/docs/limits)
- Node.js runtime — full Node API, Node 24 support, `api/index.ts` single-function pattern — [https://vercel.com/docs/functions/runtimes/node-js](https://vercel.com/docs/functions/runtimes/node-js)
- Ship an Express app on Vercel — zero-config detection, single-function bundling, 250 MB limit, streaming, `public/` statics — [https://vercel.com/kb/guide/ship-a-express-app-on-vercel](https://vercel.com/kb/guide/ship-a-express-app-on-vercel)
- Build image (Amazon Linux 2023, Node `22.x`/`24.x`/`26.x`, `dnf install`) — [https://vercel.com/docs/builds/build-image](https://vercel.com/docs/builds/build-image)
- Build Output API (native-deps x64 warning, `.vercel/output` spec) — [https://vercel.com/docs/build-output-api](https://vercel.com/docs/build-output-api)
- Configuring max duration (per-function `maxDuration`, 1800s beta only for `nodejs22.x`/`24.x`/`26.x`) — [https://vercel.com/docs/functions/configuring-functions/duration](https://vercel.com/docs/functions/configuring-functions/duration)
- How to choose between Functions, containers, and Daemons — [https://vercel.com/kb/guide/vercel-functions-containers-daemons](https://vercel.com/kb/guide/vercel-functions-containers-daemons)
- Daemons overview (continuous workers, fixed instances, `SIGTERM` 30s) — [https://vercel.com/docs/daemons](https://vercel.com/docs/daemons)
- Daemons limits (no inbound HTTP, no persistent disk, memory 1–8 GB, Hobby quota) — [https://vercel.com/docs/daemons/limits](https://vercel.com/docs/daemons/limits)
- Storage overview (Blob, Global Config, Marketplace Postgres/KV) — [https://vercel.com/docs/storage](https://vercel.com/docs/storage)
- Container Registry limits (15 GB image, 2 GB layer, 2M entries, $0.10/GB) — [https://vercel.com/docs/container-registry/limits-and-pricing](https://vercel.com/docs/container-registry/limits-and-pricing)
- WebSockets on Functions (pinned, duration-bounded, reconnect semantics) — [https://vercel.com/docs/functions/websockets](https://vercel.com/docs/functions/websockets) / [https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)
