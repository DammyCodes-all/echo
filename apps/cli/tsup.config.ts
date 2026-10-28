import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  removeNodeProtocol: false,
  // Mirrors apps/server: isomorphic-git carries dynamic requires that break
  // inside a bundled ESM file, so it (and ignore) stay external and resolve
  // from apps/cli/node_modules at runtime.
  external: ["isomorphic-git", "ignore"],
  noExternal: [/^@echo\//],
});
