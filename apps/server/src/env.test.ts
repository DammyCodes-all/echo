import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalEnv } from "./env";

afterEach(() => {
  delete process.env.ECHO_TEST_LOAD_KEY;
});

describe("loadLocalEnv", () => {
  it("picks up .env.local walking up from the launch directory", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-env-root-"));
    const nested = join(root, "apps", "server");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".env.local"), "ECHO_TEST_LOAD_KEY=loaded\n");
    const found = loadLocalEnv(nested);
    expect(found).toBe(join(root, ".env.local"));
    expect(process.env.ECHO_TEST_LOAD_KEY).toBe("loaded");
  });

  it("never overrides a real environment variable", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-env-override-"));
    writeFileSync(join(root, ".env.local"), "ECHO_TEST_LOAD_KEY=from-file\n");
    process.env.ECHO_TEST_LOAD_KEY = "from-env";
    loadLocalEnv(root);
    expect(process.env.ECHO_TEST_LOAD_KEY).toBe("from-env");
  });

  it("returns null when no env file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-env-missing-"));
    expect(loadLocalEnv(root, ".env.local.definitely-absent")).toBeNull();
  });
});
