import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEchoDb } from "@echo/db";
import { describe, expect, it } from "vitest";
import { importMuseSession } from "./import";

function envelope(seq: number, id: string, streamId: string, workspaceRoot: string): string {
  return JSON.stringify({
    schema_version: 1,
    id,
    stream: { kind: "session", id: streamId },
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

function setup(): { dataDir: string; projectRoot: string; sessionsDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-import-data-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "echo-import-proj-"));
  const sessionsDir = mkdtempSync(join(tmpdir(), "echo-import-sessions-"));
  writeFileSync(join(projectRoot, "app.ts"), "export const app = 1;\n");
  return { dataDir, projectRoot, sessionsDir };
}

describe("importMuseSession", () => {
  it("reads a native log, takes one final snapshot, and marks import_only", async () => {
    const { dataDir, projectRoot, sessionsDir } = setup();
    const dir = join(sessionsDir, "2026", "10", "28", "ses_imp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.jsonl"),
      `${envelope(3, "id-3", "ses_imp", projectRoot)}\n${envelope(4, "id-4", "ses_imp", projectRoot)}\n`,
    );
    const result = await importMuseSession({ dataDir, sessionId: "ses_imp", sessionsDir });
    expect(result.sessionId).toBe("ses_imp");
    expect(result.quality).toBe("import_only");
    expect(result.eventsAdded).toBeGreaterThan(0);
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    try {
      const row = db
        .prepare("SELECT capture_quality FROM sessions WHERE id = ?")
        .get("ses_imp") as { capture_quality: string };
      expect(row.capture_quality).toBe("import_only");
      const files = db
        .prepare("SELECT trigger FROM snapshots WHERE session_id = ?")
        .all("ses_imp") as Array<{ trigger: string }>;
      // Exactly one snapshot, and it is the final state — no intermediates.
      expect(files.map((file) => file.trigger)).toEqual(["final"]);
    } finally {
      db.close();
    }
    const tape = readFileSync(result.tapePath, "utf8");
    expect(tape).toContain("file.snapshot");
    expect(tape).toContain("import_only");
  });

  it("imports by direct log path and re-imports idempotently", async () => {
    const { dataDir, projectRoot, sessionsDir } = setup();
    const dir = join(sessionsDir, "2026", "10", "28", "ses_path");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "session.jsonl");
    writeFileSync(logPath, `${envelope(3, "id-3", "ses_path", projectRoot)}\n`);
    const first = await importMuseSession({ dataDir, path: logPath });
    expect(first.eventsAdded).toBeGreaterThan(0);
    const second = await importMuseSession({ dataDir, path: logPath });
    expect(second.eventsAdded).toBe(0);
    expect(second.snapshotCommit).toBe(first.snapshotCommit);
  });

  it("reconciles a provided redacted export without writing it raw", async () => {
    const { dataDir, projectRoot, sessionsDir } = setup();
    const dir = join(sessionsDir, "2026", "10", "28", "ses_exp");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "session.jsonl");
    writeFileSync(logPath, `${envelope(3, "id-3", "ses_exp", projectRoot)}\n`);
    const exportPath = join(dataDir, "trajectory.json");
    writeFileSync(
      exportPath,
      JSON.stringify({
        export_schema_version: 1,
        events: [{ kind: "record", envelope: { stream: { id: "ses_exp" }, sequence: 99 } }],
      }),
    );
    const result = await importMuseSession({ dataDir, path: logPath, exportPath });
    expect(result.diagnostics.some((entry) => entry.startsWith("export_reconciled"))).toBe(true);
    expect(readFileSync(result.tapePath, "utf8")).toContain("export_recovery");
  });

  it("refuses unattributable logs and missing sessions instead of guessing", async () => {
    const { dataDir, sessionsDir } = setup();
    await expect(importMuseSession({ dataDir, sessionId: "nope", sessionsDir })).rejects.toThrow(
      /not found/,
    );
    const dir = join(sessionsDir, "2026", "10", "28", "ses_bare");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "session.jsonl");
    writeFileSync(
      logPath,
      `${JSON.stringify({
        schema_version: 1,
        id: "id-1",
        stream: { kind: "session", id: "ses_bare" },
        sequence: 3,
        recorded_at: 1793097343000000,
        record_type: "event",
        durability: "durable",
        causation_id: null,
        payload_type: "runtime.user_intent.accepted",
        payload_schema_version: 1,
        payload: { kind: "accepted" },
      })}\n`,
    );
    await expect(importMuseSession({ dataDir, path: logPath })).rejects.toThrow(/--project/);
  });
});
