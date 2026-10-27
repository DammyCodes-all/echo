import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openEchoDb } from "@echo/db";
import { describe, expect, it } from "vitest";
import { createMuseIngest } from "./muse-ingest";

const log = { info: () => {}, error: () => {} };

function writeSession(root: string, date: string, id: string, lines: string[]): void {
  const dir = join(root, ...date.split("/"), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl"), `${lines.join("\n")}\n`);
}

function envelope(seq: number, id: string, workspaceRoot: string): string {
  return JSON.stringify({
    schema_version: 1,
    id,
    stream: { kind: "session", id: "ses_muse_1" },
    sequence: seq,
    recorded_at: 1793097343000000 + seq * 1000,
    record_type: "event",
    durability: "durable",
    causation_id: null,
    payload_type: "runtime.user_intent.accepted",
    payload_schema_version: 1,
    payload: { kind: "accepted", metadata: { workspace_root: workspaceRoot } },
  });
}

describe("createMuseIngest", () => {
  it("ingests sessions under enabled projects and skips the rest", () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-sessions-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-proj-"));
    writeSession(sessionsDir, "2026/10/28", "ses_muse_1", [
      envelope(3, "id-3", projectRoot),
      envelope(4, "id-4", projectRoot),
    ]);
    writeSession(sessionsDir, "2026/10/28", "ses_muse_2", [envelope(3, "id-x", "/elsewhere")]);

    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
    return ingest.runOnce().then((result) => {
      expect(result.scanned).toBe(2);
      expect(result.capturedSessions).toBe(1);
      expect(result.eventsAdded).toBe(2);
      expect(result.skipped).toBe(1);
      const again = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
      return again.runOnce().then((second) => {
        expect(second.eventsAdded).toBe(0);
        db.close();
      });
    });
  });

  it("re-ingests an appended log and skips unchanged files", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-append-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-append-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-append-proj-"));
    writeSession(sessionsDir, "2026/10/28", "ses_muse_9", [envelope(3, "id-3", projectRoot)]);
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
    const first = await ingest.runOnce();
    expect(first.eventsAdded).toBe(1);
    const second = await ingest.runOnce();
    expect(second.eventsAdded).toBe(0);
    appendFileSync(
      join(sessionsDir, "2026", "10", "28", "ses_muse_9", "session.jsonl"),
      `${envelope(4, "id-4", projectRoot)}\n`,
    );
    const third = await ingest.runOnce();
    expect(third.eventsAdded).toBe(1);
    db.close();
  });

  it("resolves the sessions dir from the environment", async () => {
    const { resolveMuseSessionsDir } = await import("./muse-ingest");
    expect(resolveMuseSessionsDir({ MUSE_SESSIONS_DIR: "/tmp/custom" } as NodeJS.ProcessEnv)).toBe(
      "/tmp/custom",
    );
    expect(resolveMuseSessionsDir({} as NodeJS.ProcessEnv).endsWith(join("muse", "sessions"))).toBe(
      true,
    );
  });

  it("ignores a missing sessions dir without throwing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-data-"));
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({
      dataDir,
      db,
      log,
      sessionsDir: join(dataDir, "nope"),
      projects: ["/repo"],
    });
    const result = await ingest.runOnce();
    expect(result.scanned).toBe(0);
    db.close();
    expect(dirname(dataDir)).toContain(tmpdir());
  });
});
