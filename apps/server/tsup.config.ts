import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  external: ["isomorphic-git", "ignore"],
  removeNodeProtocol: false,
  noExternal: [/^@echo\//],
});
