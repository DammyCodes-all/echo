# @echo/landing — Echo landing page

Standalone static build of the Echo landing page. Zero imports from `@echo/*`;
it does not depend on the daemon, the web app or the model keys, so it can
deploy on its own to any static host.

## Develop

```sh
pnpm --filter @echo/landing dev
```

Vite dev server on `http://localhost:5174`.

## Build

```sh
pnpm --filter @echo/landing build
```

Outputs `apps/landing/dist/` — plain static files (HTML, CSS, one JS chunk,
`mark.svg`). Anything that can serve a folder can host it.

## Deploy

- **Cloudflare Pages** — build command `pnpm --filter @echo/landing build`,
  output directory `apps/landing/dist`.
- **Netlify** — same command/publish directory.
- **Vercel** — framework preset "Other", build command
  `pnpm --filter @echo/landing build`, output directory `apps/landing/dist`.

The page links to the GitHub repo and hosts placeholder CTAs for the demo
video and hosted demo (`TODO(demo-link)` markers in `src/components/demo-links.tsx`).
Swap those hrefs before sharing the link publicly.
