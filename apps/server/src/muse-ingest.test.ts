import fs, {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runMuseHook } from "@echo/capture-muse";
import { getReaderCheckpoint, getSessionBuildPin, listSnapshots, openEchoDb, readEvents } from "@echo/db";
import { resolveRepositoryIdentity } from "@echo/snapshots";
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { createMuseIngest, shouldExportSession } from "./muse-ingest";

const log = { info: () => {}, error: () => {} };

async function projectIdForRoot(projectRoot: string): Promise<string> {
  return (await resolveRepositoryIdentity(projectRoot)).projectId;
}

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
      // 2 log events + 1 baseline file.snapshot on first sight of the session.
      expect(result.eventsAdded).toBe(3);
      expect(result.skipped).toBe(1);
      const again = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
      return again.runOnce().then((second) => {
        expect(second.eventsAdded).toBe(0);
        db.close();
      });
    });
  });

  it("joins a subdirectory session to its repository remote project", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-identity-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-identity-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-identity-proj-"));
    await git.init({ fs, dir: projectRoot });
    await git.setConfig({
      fs,
      dir: projectRoot,
      path: "remote.origin.url",
      value: "git@github.com:example/echo.git",
    });
    const workDir = join(projectRoot, "packages", "app");
    mkdirSync(workDir, { recursive: true });
    writeSession(sessionsDir, "2026/10/28", "ses_muse_identity", [
      envelope(3, "id-identity", workDir),
    ]);

    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({
      dataDir,
      db,
      log,
      sessionsDir,
      projects: [join(projectRoot, "packages")],
    });
    const result = await ingest.runOnce();
    expect(result.capturedSessions).toBe(1);
    expect(result.eventsAdded).toBe(2);

    const identity = await resolveRepositoryIdentity(projectRoot);
    expect(identity.remoteUrl).toBe("github.com/example/echo");
    const tape = readFileSync(
      join(dataDir, "projects", identity.projectId, "sessions", "ses_muse_identity", "tape.jsonl"),
      "utf8",
    );
    expect(tape).toContain(identity.projectId);
    expect(tape).toContain(workDir);
    db.close();
  });

  it("does not capture a sibling directory just because it shares the repo", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-scope-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-scope-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-scope-proj-"));
    await git.init({ fs, dir: projectRoot });
    const workDir = join(projectRoot, "packages", "app");
    const otherDir = join(projectRoot, "packages", "other");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    writeSession(sessionsDir, "2026/10/28", "ses_muse_scope", [envelope(3, "id-scope", otherDir)]);

    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({
      dataDir,
      db,
      log,
      sessionsDir,
      projects: [workDir],
    });
    const result = await ingest.runOnce();
    expect(result.scanned).toBe(1);
    expect(result.capturedSessions).toBe(0);
    expect(result.eventsAdded).toBe(0);
    expect(result.skipped).toBe(1);
    db.close();
  });

  it("re-ingests an appended log and skips unchanged files", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-append-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-append-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-append-proj-"));
    writeSession(sessionsDir, "2026/10/28", "ses_muse_9", [envelope(3, "id-3", projectRoot)]);
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
    const first = await ingest.runOnce();
    // 1 log event + 1 baseline file.snapshot.
    expect(first.eventsAdded).toBe(2);
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

  it("resumes tailing from persisted checkpoints across restarts", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-resume-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-resume-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-resume-proj-"));
    const logFile = join(sessionsDir, "2026", "10", "28", "ses_muse_9", "session.jsonl");
    writeSession(sessionsDir, "2026/10/28", "ses_muse_9", [envelope(3, "id-3", projectRoot)]);
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const first = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
    // 1 log event + 1 baseline file.snapshot.
    expect((await first.runOnce()).eventsAdded).toBe(2);
    const checkpoint = getReaderCheckpoint(db, "ses_muse_9", "");
    expect(checkpoint?.offset).toBeGreaterThan(0);
    expect(checkpoint?.lastSequence).toBe(3);
    // Build pin recorded on ingest (muse binary presence varies by machine,
    // so only the adapter side is asserted here).
    expect(getSessionBuildPin(db, "ses_muse_9")).toMatchObject({ adapterVersion: "0.1.0" });
    // A new instance on the same DB reads zero new bytes and ingests nothing.
    const restarted = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
    expect((await restarted.runOnce()).eventsAdded).toBe(0);
    // Appends after the restart are picked up exactly once with no re-ingest.
    appendFileSync(logFile, `${envelope(4, "id-4", projectRoot)}\n`);
    const afterAppend = createMuseIngest({
      dataDir,
      db,
      log,
      sessionsDir,
      projects: [projectRoot],
    });
    expect((await afterAppend.runOnce()).eventsAdded).toBe(1);
    expect(getReaderCheckpoint(db, "ses_muse_9", "")?.lastSequence).toBe(4);
    expect((await afterAppend.runOnce()).eventsAdded).toBe(0);
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

describe("createMuseIngest spool drain", () => {
  it("converts spooled hooks into tape events and deletes them", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-spool-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-spool-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-spool-proj-"));
    runMuseHook({
      dataDir,
      event: "PreToolUse",
      rawStdin: JSON.stringify({ session_id: "s1", cwd: projectRoot, tool_name: "read" }),
      stdinTruncated: false,
      projects: [projectRoot],
      receivedAt: "2026-10-28T10:00:00.000Z",
    });
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
    const first = await ingest.runOnce();
    expect(first.drained).toBe(1);
    // 1 hook event + 1 baseline file.snapshot for the first-seen session.
    expect(first.eventsAdded).toBe(2);
    expect(first.unattributed).toBe(0);
    const spoolRoot = join(dataDir, "spool", "muse", "s1");
    const remaining = readdirSync(spoolRoot).filter((name) => name.endsWith(".json"));
    expect(remaining).toHaveLength(0);
    const second = await ingest.runOnce();
    expect(second.drained).toBe(0);
    expect(second.eventsAdded).toBe(0);
    db.close();
  });

  it("captures baseline and post-action snapshots for hook tool activity", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-snap-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-snap-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-snap-proj-"));
    writeFileSync(join(projectRoot, "notes.txt"), "a\n");
    runMuseHook({
      dataDir,
      event: "PostToolUse",
      rawStdin: JSON.stringify({ session_id: "ses_snap", cwd: projectRoot, tool_name: "write" }),
      stdinTruncated: false,
      projects: [projectRoot],
      receivedAt: "2026-10-28T10:00:00.000Z",
    });
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
    const result = await ingest.runOnce();
    expect(result.drained).toBe(1);
    expect(result.eventsAdded).toBe(3);

    const snapshots = listSnapshots(db, "ses_snap");
    expect(snapshots.map((snapshot) => snapshot.trigger)).toEqual(["baseline", "tool.post"]);
    const kinds = readEvents(db, "ses_snap", 0, 10).map((event) => event.kind);
    expect(kinds).toEqual(["file.snapshot", "tool.completed", "file.snapshot"]);
    db.close();
  });

  it("leaves unattributable spool entries on disk and counts them", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-spool-unattr-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-spool-unattr-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-spool-unattr-proj-"));
    runMuseHook({
      dataDir,
      event: "PreToolUse",
      rawStdin: JSON.stringify({ cwd: projectRoot, tool_name: "read" }),
      stdinTruncated: false,
      projects: [projectRoot],
      receivedAt: "2026-10-28T10:00:00.000Z",
    });
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
    const result = await ingest.runOnce();
    expect(result.unattributed).toBe(1);
    expect(result.drained).toBe(0);
    expect(result.eventsAdded).toBe(0);
    const leftovers = readdirSync(join(dataDir, "spool", "muse", "unattributed")).filter((name) =>
      name.endsWith(".json"),
    );
    expect(leftovers).toHaveLength(1);
    db.close();
  });

  it("deletes corrupt spool files instead of wedging the poll", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-spool-bad-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-spool-bad-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-spool-bad-proj-"));
    const dir = join(dataDir, "spool", "muse", "s9");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "{oops");
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
    const result = await ingest.runOnce();
    expect(result.drained).toBe(0);
    expect(result.eventsAdded).toBe(0);
    expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    db.close();
  });

  it("does not let undrainable spool starve later sessions", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-spool-cap-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-spool-cap-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-spool-cap-proj-"));
    for (let i = 0; i < 200; i++) {
      runMuseHook({
        dataDir,
        event: "PreToolUse",
        rawStdin: JSON.stringify({ cwd: projectRoot, tool_name: "read", n: i }),
        stdinTruncated: false,
        projects: [projectRoot],
        receivedAt: "2026-10-28T10:00:00.000Z",
      });
    }
    runMuseHook({
      dataDir,
      event: "PreToolUse",
      rawStdin: JSON.stringify({ session_id: "zzz", cwd: projectRoot, tool_name: "read" }),
      stdinTruncated: false,
      projects: [projectRoot],
      receivedAt: "2026-10-28T10:00:00.000Z",
    });
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
    const result = await ingest.runOnce();
    expect(result.unattributed).toBe(200);
    expect(result.drained).toBe(1);
    // 1 hook event + 1 baseline file.snapshot.
    expect(result.eventsAdded).toBe(2);
    db.close();
  });

  it("merges hook spool with the native log for one session", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-spool-both-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-spool-both-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-spool-both-proj-"));
    const envelope = (seq: number, id: string): string =>
      JSON.stringify({
        schema_version: 1,
        id,
        stream: { kind: "session", id: "ses_both" },
        sequence: seq,
        recorded_at: 1793097343000000 + seq * 1000,
        record_type: "event",
        durability: "durable",
        causation_id: null,
        payload_type: "runtime.user_intent.accepted",
        payload_schema_version: 1,
        payload: { kind: "accepted", metadata: { workspace_root: projectRoot } },
      });
    const dir = join(sessionsDir, "2026", "10", "28", "ses_both");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), `${envelope(3, "id-3")}\n`);
    runMuseHook({
      dataDir,
      event: "PreToolUse",
      rawStdin: JSON.stringify({ session_id: "ses_both", cwd: projectRoot, tool_name: "read" }),
      stdinTruncated: false,
      projects: [projectRoot],
      receivedAt: "2026-10-28T10:00:00.000Z",
    });
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
    const result = await ingest.runOnce();
    expect(result.drained).toBe(1);
    // 1 hook event + 1 log event + 1 baseline file.snapshot.
    expect(result.eventsAdded).toBe(3);
    const tape = readFileSync(
      join(
        dataDir,
        "projects",
        await projectIdForRoot(projectRoot),
        "sessions",
        "ses_both",
        "tape.jsonl",
      ),
      "utf8",
    );
    expect(tape).toContain("hook_spool");
    db.close();
  });
});

describe("shouldExportSession", () => {
  it("exports only quiescent sessions with unreconciled live events", () => {
    expect(shouldExportSession({ stablePolls: 2, hasEvents: true, reconciled: false })).toBe(true);
    expect(shouldExportSession({ stablePolls: 5, hasEvents: true, reconciled: false })).toBe(true);
    expect(shouldExportSession({ stablePolls: 1, hasEvents: true, reconciled: false })).toBe(false);
    expect(shouldExportSession({ stablePolls: 2, hasEvents: false, reconciled: false })).toBe(
      false,
    );
    expect(shouldExportSession({ stablePolls: 2, hasEvents: true, reconciled: true })).toBe(false);
  });
});

describe("createMuseIngest export reconciliation", () => {
  function streamEnvelope(
    streamId: string,
    seq: number,
    id: string,
    workspaceRoot: string,
  ): string {
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

  function writeMuseStub(dir: string, name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, body, { mode: 0o755 });
    return path;
  }

  function exportFixture(events: unknown[], schemaVersion = 1): string {
    return JSON.stringify({ export_schema_version: schemaVersion, events, diagnostics: [] });
  }

  it("exports quiescent sessions once and records reconciliation", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-export-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-export-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-export-proj-"));
    const dir = join(sessionsDir, "2026", "10", "28", "ses_exp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/session.jsonl`, `${streamEnvelope("ses_exp", 3, "id-3", projectRoot)}\n`);
    const exportJson = exportFixture([
      { kind: "record", envelope: { stream: { id: "ses_exp" }, sequence: 3 } },
      { kind: "record", envelope: { stream: { id: "ses_exp" }, sequence: 9 } },
    ]);
    const museBin = writeMuseStub(
      dataDir,
      "muse-stub.sh",
      `#!/bin/sh\nout="";\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--out" ]; then out="$2"; shift 2; else shift; fi\ndone\ncat > "$out" <<'EXPORT_EOF'\n${exportJson}\nEXPORT_EOF\n`,
    );
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({
      dataDir,
      db,
      log,
      sessionsDir,
      projects: [projectRoot],
      museBin,
    });
    expect((await ingest.runOnce()).eventsAdded).toBe(2);
    expect((await ingest.runOnce()).eventsAdded).toBe(0);
    const reconciled = await ingest.runOnce();
    expect(reconciled.reconciled).toBe(1);
    expect(reconciled.eventsAdded).toBe(3);
    const tape = readFileSync(
      join(
        dataDir,
        "projects",
        await projectIdForRoot(projectRoot),
        "sessions",
        "ses_exp",
        "tape.jsonl",
      ),
      "utf8",
    );
    const reconciledLines = tape.split("\n").filter((line) => line.includes("capture.reconciled"));
    expect(reconciledLines).toHaveLength(1);
    expect(JSON.parse(reconciledLines[0] as string).payload).toMatchObject({
      added: 1,
      merged: 1,
      conflicts: 0,
      export_schema_version: 1,
    });
    expect(tape).toContain("agent.unknown");
    const quiet = await ingest.runOnce();
    expect(quiet.eventsAdded).toBe(0);
    expect(quiet.reconciled).toBe(0);
    expect(listSnapshots(db, "ses_exp").map((snapshot) => snapshot.trigger)).toEqual([
      "baseline",
      "final",
    ]);
    db.close();
  });

  it("keeps the live tape and retries when export fails", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-export-fail-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-export-fail-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-export-fail-proj-"));
    const dir = join(sessionsDir, "2026", "10", "28", "ses_fail");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/session.jsonl`,
      `${streamEnvelope("ses_fail", 3, "id-3", projectRoot)}\n`,
    );
    const museBin = writeMuseStub(dataDir, "muse-fail.sh", "#!/bin/sh\nexit 3\n");
    const errors: unknown[][] = [];
    const loudLog = {
      info: () => {},
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    };
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({
      dataDir,
      db,
      log: loudLog,
      sessionsDir,
      projects: [projectRoot],
      museBin,
    });
    expect((await ingest.runOnce()).eventsAdded).toBe(2);
    expect((await ingest.runOnce()).eventsAdded).toBe(0);
    await ingest.runOnce();
    expect(
      errors.filter((args) => JSON.stringify(args).includes("muse export failed")),
    ).toHaveLength(1);
    await ingest.runOnce();
    expect(
      errors.filter((args) => JSON.stringify(args).includes("muse export failed")),
    ).toHaveLength(2);
    const tape = readFileSync(
      join(
        dataDir,
        "projects",
        await projectIdForRoot(projectRoot),
        "sessions",
        "ses_fail",
        "tape.jsonl",
      ),
      "utf8",
    );
    expect(tape).not.toContain("capture.reconciled");
    db.close();
  });

  it("flags a missing export binary once per boot", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-export-missing-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-export-missing-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-export-missing-proj-"));
    const dir = join(sessionsDir, "2026", "10", "28", "ses_nobin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/session.jsonl`,
      `${streamEnvelope("ses_nobin", 3, "id-3", projectRoot)}\n`,
    );
    const errors: unknown[][] = [];
    const loudLog = {
      info: () => {},
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    };
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({
      dataDir,
      db,
      log: loudLog,
      sessionsDir,
      projects: [projectRoot],
      museBin: "/nonexistent/muse-binary-xyz",
    });
    for (let i = 0; i < 6; i++) {
      await ingest.runOnce();
    }
    expect(
      errors.filter((args) => JSON.stringify(args).includes("muse export unavailable")),
    ).toHaveLength(1);
    db.close();
  });
});

describe("createMuseIngest missing child logs", () => {
  function wsLine(seq: number, sessionId: string, workspaceRoot: string): string {
    return JSON.stringify({
      schema_version: 1,
      id: `id-${seq}`,
      stream: { kind: "session", id: sessionId },
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

  function linkLine(seq: number, sessionId: string, childId: string): string {
    return JSON.stringify({
      schema_version: 1,
      id: `link-${seq}`,
      stream: { kind: "session", id: sessionId },
      sequence: seq,
      recorded_at: 1793097343000000 + seq * 1000,
      record_type: "event",
      durability: "durable",
      causation_id: null,
      payload_type: "runtime.session",
      payload_schema_version: 1,
      payload: {
        kind: "memory_reminder_child_session_linked",
        child_session_id: childId,
        parent_session_id: sessionId,
      },
    });
  }

  function childLine(streamId: string, seq: number, id: string): string {
    return JSON.stringify({
      schema_version: 1,
      id,
      stream: { kind: "session", id: streamId },
      sequence: seq,
      recorded_at: 1793097343000000 + seq * 1000,
      record_type: "event",
      durability: "durable",
      causation_id: null,
      payload_type: "runtime.session",
      payload_schema_version: 1,
      payload: { kind: "completed", task_id: "t9" },
    });
  }

  function gapEvents(tapePath: string): Array<{ kind: string; payload: unknown; links: unknown }> {
    const tape = readFileSync(tapePath, "utf8");
    return tape
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { kind: string; payload: unknown; links: unknown })
      .filter((event) => event.kind === "capture.gap");
  }

  it("writes a capture.gap for a referenced child with no log, but not for a present one", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "echo-muse-gapchild-"));
    const dataDir = mkdtempSync(join(tmpdir(), "echo-muse-gapchild-data-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "echo-muse-gapchild-proj-"));
    const dir = join(sessionsDir, "2026", "10", "28", "ses_gap");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.jsonl"),
      `${[
        wsLine(3, "ses_gap", projectRoot),
        linkLine(4, "ses_gap", "child-9"),
        linkLine(5, "ses_gap", "child-1"),
      ].join("\n")}\n`,
    );
    const presentDir = join(dir, "subagent", "child-1");
    mkdirSync(presentDir, { recursive: true });
    writeFileSync(join(presentDir, "session.jsonl"), `${childLine("child-1", 3, "c1")}\n`);
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({ dataDir, db, log, sessionsDir, projects: [projectRoot] });
    const result = await ingest.runOnce();
    expect(result.capturedSessions).toBe(1);
    const tapePath = join(
      dataDir,
      "projects",
      await projectIdForRoot(projectRoot),
      "sessions",
      "ses_gap",
      "tape.jsonl",
    );
    const gaps = gapEvents(tapePath);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      payload: { code: "missing_child", subagent_id: "child-9" },
    });
    expect(gaps[0]?.links).toMatchObject({ subagent_id: "child-9", parent_session_id: "ses_gap" });
    db.close();
  });
});
