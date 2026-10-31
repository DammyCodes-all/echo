import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // isomorphic-git, ignore, undici (via @echo/model), and oxc-parser (via
  // @echo/graph) carry dynamic requires or native bindings that break
  // inside a bundled ESM file, so they stay external and resolve from
  // node_modules at runtime.
  external: ["isomorphic-git", "ignore", "undici", "oxc-parser"],
  removeNodeProtocol: false,
  noExternal: [/^@echo\//],
});
