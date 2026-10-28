import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // eval/ holds the BUILD-PLAN §6 verification harnesses: integration
    // coverage that asserts against real ingest + snapshotter runs.
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "eval/**/*.test.ts",
    ],
    passWithNoTests: true,
  },
});
