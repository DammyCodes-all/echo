import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEchoDb, upsertProject, upsertSession, upsertSessionBuildPin } from "@echo/db";
import { describe, expect, it } from "vitest";
import { runDoctor } from "./doctor";

function stubMuse(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

function seedPin(dataDir: string, version: string | null): void {
  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  try {
    upsertProject(db, { id: "prj_1", root: "/repo", name: "repo" });
    upsertSession(db, {
      id: "ses_1",
      projectId: "prj_1",
      agent: "muse",
      model: null,
      directory: "/repo",
      title: null,
      startedAt: null,
      tapePath: "/data/tape.jsonl",
      captureQuality: "full",
    });
    upsertSessionBuildPin(db, {
      sessionId: "ses_1",
      museVersion: version,
      adapterVersion: "0.1.0",
      exportSchemaVersion: null,
      observedAt: "2026-10-28T10:00:00.000Z",
    });
  } finally {
    db.close();
  }
}

describe("runDoctor", () => {
  it("reports a missing database and missing binary without failing", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-doctor-empty-"));
    const report = runDoctor({
      dataDir,
      projects: [],
      museBin: "/nonexistent/muse-binary-xyz",
      sessionsDir: join(dataDir, "nope"),
      configFile: join(dataDir, "config.json"),
    });
    expect(report.lines.join("\n")).toContain("database: none yet (daemon never ran)");
    expect(report.lines.join("\n")).toContain("muse: not found");
    expect(report.warnings).toHaveLength(1);
  });

  it("lists pinned builds and warns on drift", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-doctor-"));
    const binDir = mkdtempSync(join(tmpdir(), "echo-doctor-bin-"));
    seedPin(dataDir, "Muse Code 1.4.13");
    const drifted = stubMuse(binDir, "muse-new.sh", "#!/bin/sh\necho 'Muse Code 9.9.9'\n");
    const driftedReport = runDoctor({
      dataDir,
      projects: ["/repo"],
      museBin: drifted,
      sessionsDir: binDir,
      configFile: join(dataDir, "config.json"),
    });
    expect(driftedReport.lines.join("\n")).toContain("Muse Code 1.4.13");
    expect(driftedReport.warnings.join("\n")).toContain("build drift");
    const current = stubMuse(binDir, "muse-same.sh", "#!/bin/sh\necho 'Muse Code 1.4.13'\n");
    const cleanReport = runDoctor({
      dataDir,
      projects: ["/repo"],
      museBin: current,
      sessionsDir: binDir,
      configFile: join(dataDir, "config.json"),
    });
    expect(cleanReport.warnings).toHaveLength(0);
  });
});
