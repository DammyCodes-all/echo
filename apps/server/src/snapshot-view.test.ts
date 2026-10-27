import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { insertSnapshot, openEchoDb, upsertProject, upsertSession } from "@echo/db";
import { snapshotWorkingTree } from "@echo/snapshots";
import { describe, expect, it } from "vitest";
import { readSnapshotFile } from "./snapshot-view";

function write(root: string, path: string, content: string | Buffer): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

async function seedView() {
  const root = mkdtempSync(join(tmpdir(), "echo-view-root-"));
  const dataDir = mkdtempSync(join(tmpdir(), "echo-view-data-"));
  write(root, "README.md", "hello\n");
  write(root, "src/app.ts", "export const x = 1;\n");
  write(root, "assets/logo.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  upsertProject(db, { id: "prj_1", root, name: "root" });
  upsertSession(db, {
    id: "ses_1",
    projectId: "prj_1",
    agent: "opencode",
    model: null,
    directory: root,
    title: "view",
    startedAt: null,
    tapePath: join(dataDir, "tape.jsonl"),
    captureQuality: "import_only",
  });
  const shadowDir = join(dataDir, "projects", "prj_1", "shadow.git");
  const result = await snapshotWorkingTree({
    shadowDir,
    root,
    dataDir,
    sessionId: "ses_1",
    projectId: "prj_1",
    trigger: "baseline",
    eventId: "evt_snap_1",
    takenAt: new Date("2026-10-27T09:00:00.000Z"),
  });
  insertSnapshot(db, {
    id: result.commitOid,
    sessionId: "ses_1",
    commitOid: result.commitOid,
    parentOid: result.parentOid,
    trigger: result.trigger,
    eventId: "evt_snap_1",
    takenAt: result.takenAt,
    fileCount: result.fileCount,
    totalBytes: result.totalBytes,
    status: result.status,
    diagnostics: result.diagnostics,
    files: result.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      blobOid: file.blobOid,
      size: file.size,
      sha256: file.sha256,
      captured: file.captured,
      reason: file.reason,
    })),
  });
  return { db, dataDir, commitOid: result.commitOid };
}

describe("readSnapshotFile", () => {
  it("serves captured text from the shadow repo", async () => {
    const { db, dataDir, commitOid } = await seedView();
    const outcome = await readSnapshotFile(db, dataDir, "ses_1", commitOid, "src/app.ts");
    expect(outcome).toEqual({
      ok: true,
      content: {
        path: "src/app.ts",
        blobOid: outcome.ok ? outcome.content.blobOid : null,
        size: 20,
        truncated: false,
        content: "export const x = 1;\n",
      },
    });
    db.close();
  });

  it("reports missing sessions, snapshots, paths and uncaptured files", async () => {
    const { db, dataDir, commitOid } = await seedView();
    expect((await readSnapshotFile(db, dataDir, "ses_x", commitOid, "src/app.ts")).ok).toBe(false);
    expect((await readSnapshotFile(db, dataDir, "ses_1", "0".repeat(40), "src/app.ts")).ok).toBe(
      false,
    );
    expect((await readSnapshotFile(db, dataDir, "ses_1", commitOid, "nope.ts")).ok).toBe(false);
    const binary = await readSnapshotFile(db, dataDir, "ses_1", commitOid, "assets/logo.bin");
    expect(binary).toEqual({
      ok: false,
      code: "not_found",
      message: "file not captured: binary",
    });
    db.close();
  });

  it("rejects paths that escape the snapshot", async () => {
    const { db, dataDir, commitOid } = await seedView();
    for (const path of ["../echo.sqlite", "/etc/hostname", "..\\win", "a/./../b", ""]) {
      const outcome = await readSnapshotFile(db, dataDir, "ses_1", commitOid, path);
      expect(outcome).toMatchObject({ ok: false, code: "invalid_request" });
    }
    db.close();
  });
});
