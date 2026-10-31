import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// undici (via @echo/model) and oxc-parser (via @echo/graph) break when tsup
// inlines them into the ESM dist bundle: undici throws
// 'Dynamic require of "node:assert"', and oxc-parser cannot resolve its
// native binding from inside dist/index.js. Both must stay external and
// resolve from node_modules at runtime — the same precedent as
// isomorphic-git/ignore. This pins the config so a future edit cannot
// silently re-bundle them and break `node dist/index.js`.
const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_UNSAFE = ["undici", "oxc-parser"];

describe("server bundle externals", () => {
  it.each(BUNDLED_UNSAFE)("keeps %s external to the tsup bundle", (name) => {
    const tsupConfig = readFileSync(join(serverDir, "tsup.config.ts"), "utf8");
    expect(tsupConfig).toMatch(new RegExp(`external:\\s*\\[[^\\]]*"${name}"[^\\]]*\\]`, "s"));
  });

  it.each(BUNDLED_UNSAFE)("declares %s so dist resolves it at runtime", (name) => {
    const pkg = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.[name]).toBeDefined();
  });
});
