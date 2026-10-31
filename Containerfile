# Hosted demo image (ARCH §18): the server in demo mode plus a baked bundle.
# The image is built from the repo root with a prebuilt bundle beside it:
#
#   node apps/cli/dist/index.js demo build --session <id> --out demo-bundle
#   docker build -t echo-demo .        # or: podman build -t echo-demo .
#   docker run -p 8080:8080 -e ECHO_MODEL_API_KEY=... echo-demo
#
# The bundle is build input, not build output: the source session lives on
# the baker's machine, never in this repo. `demo build` already ran the
# smoke suite, so the image only needs to boot and serve.
#
# Release pinning: releases should pin the base image by digest
# (ARCH §17 supply-chain row); the tag below floats by design so local
# builds do not rot.

FROM node:24-slim AS builder

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src
# One copy instead of a manifest-first layer: the demo image builds rarely
# and correctness beats cache granularity here.
COPY . .
RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm --filter @echo/server --prod deploy /opt/echo \
  && cp -r apps/server/dist /opt/echo/dist

FROM node:24-slim AS runtime

RUN useradd --create-home --shell /usr/sbin/nologin echo
WORKDIR /opt/echo
COPY --from=builder /opt/echo /opt/echo
# Writable by the app user on purpose: the demo opens its sqlite copy in WAL
# mode and keeps derived caches in the container layer (ephemeral by design).
COPY --chown=echo:echo demo-bundle ./bundle
USER echo
ENV ECHO_MODE=demo \
  ECHO_DATA_DIR=/opt/echo/bundle/data \
  ECHO_DEMO_WEB_DIR=/opt/echo/bundle/web \
  ECHO_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
