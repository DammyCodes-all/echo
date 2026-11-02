import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EchoDb, openEchoDb } from "@echo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disableSettingsProject,
  enableSettingsProject,
  getSettings,
  installSettingsHooks,
  resolveSettingsFolder,
} from "./settings";

function env() {
  const dir = mkdtempSync(join(tmpdir(), "echo-settings-"));
  return {
    ...process.env,
    ECHO_CONFIG_DIR: join(dir, "config"),
    ECHO_MUSE_SETTINGS_PATH: join(dir, "muse", "settings.json"),
    ECHO_CLI_BIN: join(dir, "echo-cli"),
  } as NodeJS.ProcessEnv;
}

function openTestDb(): { db: EchoDb; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "echo-settings-db-"));
  const db = openEchoDb(join(dir, "echo.sqlite"));
  return { db, close: () => db.close() };
}

const log = { error: vi.fn() };
afterEach(() => log.error.mockClear());

describe("settings service", () => {
  it("reports empty projects and missing hooks on a fresh machine", () => {
    const outcome = getSettings(env());
    expect(outcome.status).toBe(200);
    const body = outcome.body as { projects: string[]; hooks: { installed: boolean } };
    expect(body.projects).toEqual([]);
    expect(body.hooks.installed).toBe(false);
  });

  it("installs every hook event and reports already-installed on repeat", () => {
    const testEnv = env();
    const first = installSettingsHooks(testEnv);
    expect(first.status).toBe(200);
    const firstBody = first.body as {
      changed: boolean;
      backupPath: null;
      eventsInstalled: string[];
    };
    expect(firstBody.changed).toBe(true);
    expect(firstBody.eventsInstalled.length).toBeGreaterThan(0);

    const status = getSettings(testEnv).body as { hooks: { installed: boolean } };
    expect(status.hooks.installed).toBe(true);

    const second = installSettingsHooks(testEnv);
    expect((second.body as { changed: boolean }).changed).toBe(false);
  });

  it("refuses a hand-broken settings file instead of guessing", () => {
    const testEnv = env();
    mkdirSync(join(testEnv.ECHO_MUSE_SETTINGS_PATH as string, ".."), { recursive: true });
    writeFileSync(testEnv.ECHO_MUSE_SETTINGS_PATH as string, "{oops");
    const outcome = installSettingsHooks(testEnv);
    expect(outcome.status).toBe(400);
  });

  it("enables a folder, persists it, and stays idempotent", async () => {
    const testEnv = env();
    const { db, close } = openTestDb();
    try {
      const root = mkdtempSync(join(tmpdir(), "echo-enable-"));
      const first = await enableSettingsProject(db, root, testEnv, log);
      expect(first.status).toBe(200);
      expect((first.body as { path: string }).path).toBe(root);

      const second = await enableSettingsProject(db, root, testEnv, log);
      expect(second.status).toBe(200);
      const projects = (getSettings(testEnv).body as { projects: string[] }).projects;
      expect(projects).toEqual([root]);
    } finally {
      close();
    }
  });

  it("rejects missing paths and files, not folders", async () => {
    const testEnv = env();
    const { db, close } = openTestDb();
    try {
      const missing = await enableSettingsProject(
        db,
        join(tmpdir(), "echo-nope-missing"),
        testEnv,
        log,
      );
      expect(missing.status).toBe(404);

      const file = join(mkdtempSync(join(tmpdir(), "echo-enable-")), "f.txt");
      writeFileSync(file, "x");
      const notDir = await enableSettingsProject(db, file, testEnv, log);
      expect(notDir.status).toBe(400);
    } finally {
      close();
    }
  });

  it("disables an enabled folder and reports unknown paths as not removed", async () => {
    const testEnv = env();
    const { db, close } = openTestDb();
    try {
      const root = mkdtempSync(join(tmpdir(), "echo-disable-"));
      await enableSettingsProject(db, root, testEnv, log);
      expect(disableSettingsProject(root, testEnv).body).toMatchObject({ removed: true });
      expect((getSettings(testEnv).body as { projects: string[] }).projects).toEqual([]);
      expect(disableSettingsProject(root, testEnv).body).toMatchObject({ removed: false });
    } finally {
      close();
    }
  });

  it("resolves a picker name to machine paths, sorted", () => {
    const home = mkdtempSync(join(tmpdir(), "echo-resolve-"));
    mkdirSync(join(home, "work", "echo"), { recursive: true });
    mkdirSync(join(home, "dev", "echo"), { recursive: true });
    mkdirSync(join(home, ".hidden", "echo"), { recursive: true });
    mkdirSync(join(home, "dev", "node_modules", "echo"), { recursive: true });
    writeFileSync(join(home, "echo"), "x");
    const outcome = resolveSettingsFolder("echo", home);
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({
      name: "echo",
      matches: [join(home, "dev", "echo"), join(home, "work", "echo")],
      truncated: false,
    });
  });

  it("answers no-match with an empty list and rejects path-like names", () => {
    const home = mkdtempSync(join(tmpdir(), "echo-resolve-"));
    expect(resolveSettingsFolder("nope", home).body).toMatchObject({ matches: [] });
    expect(resolveSettingsFolder("../escape", home).status).toBe(400);
    expect(resolveSettingsFolder("  ", home).status).toBe(400);
  });
});
