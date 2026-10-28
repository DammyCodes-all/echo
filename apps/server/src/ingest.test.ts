import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openEchoDb } from "@echo/db";
import { resolveRepositoryIdentity } from "@echo/snapshots";
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { createIngest } from "./ingest";

const log = { info: () => {}, error: () => {} };

async function makeGitProject(): Promise<{ root: string; workDir: string }> {
  const root = mkdtempSync(join(tmpdir(), "echo-opencode-identity-"));
  await git.init({ fs, dir: root });
  await git.setConfig({
    fs,
    dir: root,
    path: "remote.origin.url",
    value: "https://github.com/example/echo.git",
  });
  const workDir = join(root, "packages", "app");
  return { root, workDir };
}

function makeSource(sessionId: string, directory: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "echo-opencode-source-")), `${sessionId}.db`);
  const store = new DatabaseSync(path);
  store.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, agent TEXT,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, data TEXT
    );
  `);
  store
    .prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(sessionId, "identity", directory, null, "opencode", 1793097800000, 1793097801000);
  store
    .prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "msg_user",
      sessionId,
      "user",
      1,
      1793097800000,
      JSON.stringify({ text: "read the file", time: { created: 1793097800000 } }),
    );
  store.close();
  return path;
}

describe("createIngest project identity", () => {
  it("joins an OpenCode session in a subdirectory to its repository project", async () => {
    const { workDir } = await makeGitProject();
    const dataDir = mkdtempSync(join(tmpdir(), "echo-opencode-identity-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "echo-opencode-identity-config-"));
    const source = makeSource("ses_opencode_identity", workDir);
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ projects: [workDir], opencode_db: source, poll_interval_ms: 250 }),
    );
    const previousConfigDir = process.env.ECHO_CONFIG_DIR;
    process.env.ECHO_CONFIG_DIR = configDir;
    try {
      const db = openEchoDb(join(dataDir, "echo.sqlite"));
      try {
        const result = await createIngest({ dataDir, db, log }).runOnce();
        expect(result.capturedSessions).toBe(1);
        expect(result.eventsAdded).toBeGreaterThan(0);

        const identity = await resolveRepositoryIdentity(workDir);
        expect(identity.remoteUrl).toBe("github.com/example/echo");
        const tape = await readFile(
          join(
            dataDir,
            "projects",
            identity.projectId,
            "sessions",
            "ses_opencode_identity",
            "tape.jsonl",
          ),
          "utf8",
        );
        expect(tape).toContain("ses_opencode_identity");
      } finally {
        db.close();
      }
    } finally {
      if (previousConfigDir === undefined) delete process.env.ECHO_CONFIG_DIR;
      else process.env.ECHO_CONFIG_DIR = previousConfigDir;
    }
  });

  it("does not capture a sibling directory just because it shares the repo", async () => {
    const { root, workDir } = await makeGitProject();
    const otherDir = join(root, "packages", "other");
    const dataDir = mkdtempSync(join(tmpdir(), "echo-opencode-scope-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "echo-opencode-scope-config-"));
    const source = makeSource("ses_opencode_scope", otherDir);
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ projects: [workDir], opencode_db: source, poll_interval_ms: 250 }),
    );
    const previousConfigDir = process.env.ECHO_CONFIG_DIR;
    process.env.ECHO_CONFIG_DIR = configDir;
    try {
      const db = openEchoDb(join(dataDir, "echo.sqlite"));
      try {
        const result = await createIngest({ dataDir, db, log }).runOnce();
        expect(result.capturedSessions).toBe(0);
        expect(result.eventsAdded).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      if (previousConfigDir === undefined) delete process.env.ECHO_CONFIG_DIR;
      else process.env.ECHO_CONFIG_DIR = previousConfigDir;
    }
  });
});
