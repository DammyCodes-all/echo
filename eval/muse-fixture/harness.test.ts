import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMuseIngest } from "../../apps/server/src/muse-ingest";
import { finalizeMuseSession, runMuseHook } from "../../packages/capture-muse/src/index";
import { projectIdForDirectory } from "../../packages/core/src/index";
import { openEchoDb } from "../../packages/db/src/index";
import { FIXTURE_SYNTHETIC_SECRET } from "../../packages/fixtures/src/index";
import { readShadowBlob } from "../../packages/snapshots/src/index";
import { scanSurfaces } from "./scan";

const SID = "ses_eval_1";
const BASE_US = 1793097343000000;
const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// Markers that must never appear in Echo artifacts. The intermediates are
// written to the working tree and overwritten before any snapshot runs;
// the encrypted blob and torn tail exist only in the native log input.
const INTERMEDIATE_APP = "echo-fixture-intermediate-app";
const INTERMEDIATE_FLAG = "echo-fixture-intermediate-flag";
const ENCRYPTED_MARKER = "ENCRYPTED_FIXTURE_BLOB_9f8";
const TORN_MARKER = "TORN_FIXTURE_PARTIAL_LINE";
const SECRET = FIXTURE_SYNTHETIC_SECRET;

function line(seq: number, streamId: string, payloadType: string, payload: unknown): string {
  return JSON.stringify({
    schema_version: 1,
    id: `id-${seq}`,
    stream: { kind: "session", id: streamId },
    sequence: seq,
    recorded_at: BASE_US + seq * 1000,
    record_type: "event",
    durability: "durable",
    causation_id: null,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  });
}

function hookPayload(extra: Record<string, unknown>): string {
  return JSON.stringify({ session_id: SID, cwd: extra.cwd as string, ...extra });
}

describe("eval/muse-fixture capture integrity", () => {
  it("covers the ARCHITECTURE §22 fixture sequence with zero raw-secret leakage", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-eval-"));
    const repo = join(root, "repo");
    const sessionsDir = join(root, "sessions");
    const dataDir = join(root, "echodata");
    const logsDir = join(root, "logs");
    mkdirSync(repo, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    const logLines: string[] = [];
    const log = {
      info: (obj: unknown, message?: string) => {
        logLines.push(`${message ?? ""} ${JSON.stringify(obj)}`);
      },
      error: (obj: unknown, message?: string) => {
        logLines.push(`ERROR ${message ?? ""} ${JSON.stringify(obj)}`);
      },
    };

    // Fixture repo, final state first: rapid intermediates are overwritten
    // before any snapshot runs, so no snapshot can ever claim them.
    writeFileSync(join(repo, "README.md"), "# fixture repo\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), `export const greeting = "hi";\n`);
    writeFileSync(join(repo, "src", "flag.ts"), `export const flag = "${INTERMEDIATE_FLAG}";\n`);
    writeFileSync(join(repo, "src", "flag.ts"), `export const flag = "off";\n`);
    writeFileSync(join(repo, "src", "app.ts"), `export const greeting = "${INTERMEDIATE_APP}";\n`);
    writeFileSync(join(repo, "src", "app.ts"), `export const greeting = "hi";\n`);
    mkdirSync(join(repo, "notes"), { recursive: true });
    writeFileSync(join(repo, "notes", "out.txt"), "shell-built output\n");
    mkdirSync(join(repo, "config"), { recursive: true });
    writeFileSync(join(repo, "config", "keys.txt"), `META_API_KEY=${SECRET}\n`);
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    writeFileSync(join(repo, ".env"), `META_API_KEY=${SECRET}\n`);
    mkdirSync(join(repo, "assets"), { recursive: true });
    writeFileSync(
      join(repo, "assets", "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    );
    writeFileSync(join(repo, "big-blob.bin"), Buffer.alloc(2_500_000, 0x78));

    // Fake native sessions tree: parent log with a sequence jump (4→9), a
    // retained marker explaining the 9→14 jump, an interrupted tool, an
    // encrypted reasoning blob, and a torn tail — plus one present and one
    // missing child log.
    const sessionDir = join(sessionsDir, "2026", "10", "28", SID);
    mkdirSync(sessionDir, { recursive: true });
    const parentLines = [
      line(3, SID, "runtime.user_intent.accepted", {
        kind: "accepted",
        metadata: { workspace_root: repo },
      }),
      line(4, SID, "tool_batch.effect.started", {
        tool: "read",
        path: "README.md",
        content: `META_API_KEY=${SECRET}`,
      }),
      line(9, SID, "tool_batch.effect.terminal", {
        tool: "write",
        path: "src/app.ts",
        outcome: "ok",
      }),
      JSON.stringify({
        schema_version: 1,
        id: "marker-1",
        stream: { kind: "session", id: SID },
        sequence: 9,
        recorded_at: BASE_US + 9500,
        retained_marker: true,
        omission_class: "checkpoint_trim",
      }),
      line(14, SID, "tool_batch.effect.terminal", {
        tool: "exec",
        command: "write notes/out.txt",
        outcome: "ok",
      }),
      line(15, SID, "runtime.session", {
        kind: "failed",
        tool: "format",
        error: { type: "command_not_found", detail: "prettier: not found" },
      }),
      line(16, SID, "runtime.session", {
        kind: "cancelled",
        tool_call_id: "call_test_1",
        detail: "interrupted by user",
      }),
      line(17, SID, "runtime.session", {
        kind: "memory_reminder_child_session_linked",
        child_session_id: "child-1",
        parent_session_id: SID,
      }),
      line(18, SID, "runtime.session", {
        kind: "memory_reminder_child_session_linked",
        child_session_id: "child-9",
        parent_session_id: SID,
      }),
      line(19, SID, "runtime.session", {
        kind: "reasoning_committed",
        text: "fixup summary",
        encrypted_content: ENCRYPTED_MARKER,
      }),
    ];
    const tornTail = `{"schema_version":1,"id":"torn","stream":{"kind":"session","id":"${SID}"},"sequence":20,"note":"${TORN_MARKER}"`;
    writeFileSync(join(sessionDir, "session.jsonl"), `${parentLines.join("\n")}\n${tornTail}`);
    const childDir = join(sessionDir, "subagent", "child-1");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(childDir, "session.jsonl"),
      `${line(3, "child-1", "tool_batch.effect.terminal", { tool: "lint", outcome: "ok" })}\n`,
    );

    // Fake hook payloads through the real spool path (fixed timestamps keep
    // event ids deterministic across runs).
    const hooks: Array<[string, Record<string, unknown>]> = [
      ["SessionStart", {}],
      ["UserPromptSubmit", { prompt: `Add a greeting. Signing key ${SECRET} for the demo.` }],
      ["PreToolUse", { tool_name: "read", tool_input: { path: "README.md", hint: SECRET } }],
      ["PostToolUse", { tool_name: "read", tool_response: { preview: "ok" } }],
      ["PreToolUse", { tool_name: "exec", tool_input: { command: "write notes/out.txt" } }],
      ["PostToolUse", { tool_name: "exec", tool_response: { exit_code: 0 } }],
      ["PostToolUseFailure", { tool_name: "format", error: "prettier: not found" }],
      ["SubagentStart", { subagent_id: "child-1" }],
      ["SubagentStop", { subagent_id: "child-1", outcome: "ok" }],
      ["PostToolBatch", { batch: "b1" }],
      ["Stop", { outcome: "ok" }],
      ["SessionEnd", { outcome: "ok" }],
    ];
    hooks.forEach(([event, payload], index) => {
      runMuseHook({
        dataDir,
        event,
        rawStdin: hookPayload({ cwd: repo, ...payload }),
        stdinTruncated: false,
        projects: [repo],
        receivedAt: new Date(Date.parse("2026-10-28T12:00:00.000Z") + index * 1000).toISOString(),
      });
    });

    // Stub muse export: one merged record (seq 3) plus one export-only
    // record (seq 99). Key-only reconcile merges the first, adds the second.
    const cannedExport = {
      export_schema_version: 1,
      events: [
        { kind: "record", envelope: { stream: { id: SID }, sequence: 3 } },
        { kind: "record", envelope: { stream: { id: SID }, sequence: 99 } },
      ],
      diagnostics: [],
    };
    const cannedPath = join(root, "canned-export.json");
    writeFileSync(cannedPath, JSON.stringify(cannedExport));
    const stubPath = join(root, "muse-stub.sh");
    writeFileSync(
      stubPath,
      `#!/bin/sh\nout="";\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--out" ]; then out="$2"; shift 2; else shift; fi\ndone\ncat "${cannedPath}" > "$out"\n`,
      { mode: 0o755 },
    );

    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    const ingest = createMuseIngest({
      dataDir,
      db,
      log,
      sessionsDir,
      projects: [repo],
      museBin: stubPath,
    });
    const first = await ingest.runOnce();
    expect(first.drained).toBe(hooks.length);
    expect(first.capturedSessions).toBe(1);
    await ingest.runOnce();
    const reconciled = await ingest.runOnce();
    expect(reconciled.reconciled).toBe(1);

    const projectId = projectIdForDirectory(repo);
    const tapePath = join(dataDir, "projects", projectId, "sessions", SID, "tape.jsonl");
    const tapeText = readFileSync(tapePath, "utf8");
    const tapeEvents = tapeText
      .split("\n")
      .filter((entry) => entry.length > 0)
      .map(
        (entry) => JSON.parse(entry) as { kind: string; payload: unknown; diagnostics: string[] },
      );

    const byKind = (kind: string) => tapeEvents.filter((event) => event.kind === kind);
    for (const kind of [
      "session.started",
      "prompt.submitted",
      "tool.requested",
      "tool.completed",
      "tool.failed",
      "tool.batch",
      "subagent.started",
      "subagent.stopped",
      "turn.ended",
      "session.ended",
      "file.snapshot",
      "capture.gap",
      "capture.reconciled",
      "capture.compaction",
      "agent.unknown",
      "model.response",
    ]) {
      expect(byKind(kind).length, `expected tape kind ${kind}`).toBeGreaterThan(0);
    }

    // Capture gaps: the 4→9 jump and the missing child are data; the
    // marker-adjacent 9→14 jump is compaction, never a gap.
    const gaps = byKind("capture.gap").map((event) => event.payload as Record<string, unknown>);
    expect(gaps).toContainEqual({
      code: "sequence_jump",
      stream_id: SID,
      from_sequence: 4,
      to_sequence: 9,
    });
    expect(gaps).toContainEqual({ code: "missing_child", subagent_id: "child-9" });
    expect(gaps.some((gap) => JSON.stringify(gap).includes("9-14"))).toBe(false);
    expect(gaps.some((gap) => (gap as { subagent_id?: string }).subagent_id === "child-1")).toBe(
      false,
    );
    // Interrupted tool: failure recorded, completion never fabricated.
    expect(
      tapeEvents.some(
        (event) => event.kind === "tool.completed" && JSON.stringify(event).includes("call_test_1"),
      ),
    ).toBe(false);
    // Encrypted reasoning stripped at the boundary, removal recorded.
    expect(tapeText).toContain("encrypted_content_removed");
    // Torn tail dropped with a diagnostic, never ingested.
    expect(logLines.join("\n")).toContain("truncated_tail");

    // Reconciled marker carries the conflicts count (always 0: key-only merge
    // performs no content comparison by design).
    const reconciledEvents = byKind("capture.reconciled");
    expect(reconciledEvents).toHaveLength(1);
    expect((reconciledEvents[0] as { payload: unknown }).payload).toEqual({
      added: 1,
      merged: 1,
      conflicts: 0,
      export_schema_version: 1,
    });
    expect(
      byKind("agent.unknown").some((event) => event.diagnostics.includes("export_recovery")),
    ).toBe(true);

    // Quality choke point: ingest persists exactly what finalizeMuseSession
    // computes from the same inputs — it never recomputes it.
    const liveContent = readFileSync(join(sessionDir, "session.jsonl"), "utf8");
    const direct = finalizeMuseSession({
      sessionId: SID,
      projectId,
      build: null,
      liveContent,
      childContents: [
        { id: "child-1", content: readFileSync(join(childDir, "session.jsonl"), "utf8") },
      ],
      exportDoc: cannedExport,
    });
    const row = db.prepare("SELECT capture_quality FROM sessions WHERE id = ?").get(SID) as {
      capture_quality: string;
    };
    expect(row.capture_quality).toBe("partial");
    expect(row.capture_quality).toBe(direct.quality);

    // Shadow repo: baseline plus final (and trigger snapshots) with
    // metadata-only rows for binary, ignored .env, and the oversized blob.
    const shadowDir = join(dataDir, "projects", projectId, "shadow.git");
    const sessionRef = `refs/echo/sessions/${SID}`;
    const head = execFileSync("git", ["--git-dir", shadowDir, "rev-list", "--count", sessionRef], {
      encoding: "utf8",
    }).trim();
    expect(Number(head)).toBeGreaterThanOrEqual(2);
    const snapshotRows = db
      .prepare("SELECT id, trigger FROM snapshots WHERE session_id = ?")
      .all(SID) as Array<{ id: string; trigger: string }>;
    expect(snapshotRows.map((snapshot) => snapshot.trigger)).toContain("baseline");
    expect(snapshotRows.map((snapshot) => snapshot.trigger)).toContain("final");
    const finalSnapshot = snapshotRows.find((snapshot) => snapshot.trigger === "final");
    if (finalSnapshot === undefined) throw new Error("final snapshot missing");
    const fileRows = db
      .prepare("SELECT path, captured, reason FROM snapshot_files WHERE snapshot_id = ?")
      .all(finalSnapshot.id) as Array<{ path: string; captured: number; reason: string | null }>;
    const fileByPath = new Map(fileRows.map((file) => [file.path, file]));
    expect(fileByPath.get("src/app.ts")).toMatchObject({ captured: 1 });
    expect(fileByPath.get("notes/out.txt")).toMatchObject({ captured: 1 });
    expect(fileByPath.get("assets/logo.png")).toMatchObject({ captured: 0, reason: "binary" });
    expect(fileByPath.get(".env")).toMatchObject({ captured: 0, reason: "ignored" });
    expect(fileByPath.get("big-blob.bin")).toMatchObject({ captured: 0, reason: "too_large" });
    const keysRow = fileByPath.get("config/keys.txt");
    expect(keysRow).toMatchObject({ captured: 1 });
    const blobOids = db
      .prepare("SELECT DISTINCT blob_oid AS oid FROM snapshot_files WHERE blob_oid IS NOT NULL")
      .all() as Array<{ oid: string }>;

    // Raw-secret scan over every Echo-owned surface. The input fixture dir
    // (native log, working tree, .env) is the only place the raw secret,
    // intermediates, and opaque markers may exist. Zero tolerance.
    const bundleDir = join(root, "bundle");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "tape.jsonl"), tapeText);
    writeFileSync(
      join(bundleDir, "meta.json"),
      JSON.stringify({ session_id: SID, capture_quality: row.capture_quality }),
    );
    writeFileSync(join(bundleDir, "diagnostics.jsonl"), `${direct.diagnostics.join("\n")}\n`);
    execFileSync("git", [
      "--git-dir",
      shadowDir,
      "bundle",
      "create",
      join(bundleDir, "session.gitbundle"),
      sessionRef,
    ]);
    writeFileSync(join(logsDir, "echo.log"), `${logLines.join("\n")}\n`);
    const forbidden = [SECRET, INTERMEDIATE_APP, INTERMEDIATE_FLAG, ENCRYPTED_MARKER, TORN_MARKER];
    const hits = scanSurfaces(
      [join(dataDir, "spool"), logsDir, bundleDir],
      [tapePath, join(dataDir, "echo.sqlite")],
      await Promise.all(
        blobOids.map(async (blob) => ({
          name: `shadow:${blob.oid}`,
          data: Buffer.from(await readShadowBlob(shadowDir, blob.oid)),
        })),
      ),
      forbidden,
    );
    expect(hits).toEqual([]);
    // Redaction did fire: placeholders outlive the secrets they replaced.
    expect(tapeText).toContain("[REDACTED");

    // Spec §9 mapping output: only capture integrity is fixture-measurable.
    const coverage = [
      { item: "file read", status: "pass", detail: "tool.requested/completed for read" },
      { item: "successful edit", status: "pass", detail: "tool.completed + final snapshot state" },
      { item: "failed tool", status: "pass", detail: "tool.failed with exit detail" },
      {
        item: "reverted edit",
        status: "pass",
        detail: `intermediate ${INTERMEDIATE_APP} absent; final state captured`,
      },
      {
        item: "shell-driven change",
        status: "pass",
        detail: "notes/out.txt in final snapshot without editor event",
      },
      {
        item: "interrupted tool",
        status: "pass",
        detail: "tool.failed recorded; no fabricated completion",
      },
      {
        item: "rapid edit/revert",
        status: "missed-state",
        detail: `intermediate ${INTERMEDIATE_FLAG} unobserved by design`,
      },
      {
        item: "synthetic secret",
        status: "pass",
        detail: "zero raw occurrences outside input dir",
      },
      { item: "binary + ignored .env", status: "pass", detail: "captured:false with reasons" },
      {
        item: "subagent session",
        status: "pass",
        detail: "child lane linked; missing_child gap for child-9",
      },
      { item: "sequence jump", status: "pass", detail: "capture.gap 4→9" },
      { item: "retained marker", status: "pass", detail: "capture.compaction, no gap for 9→14" },
      {
        item: "torn tail",
        status: "missed-state",
        detail: "partial line dropped; truncated_tail diagnostic kept",
      },
      { item: "export reconcile", status: "pass", detail: "added=1 merged=1 conflicts=0" },
    ];
    const echoCommit = (() => {
      try {
        return execSync("git rev-parse HEAD", {
          cwd: join(OUT_DIR, "..", ".."),
          encoding: "utf8",
        }).trim();
      } catch {
        return "unknown";
      }
    })();
    const result = {
      generated_at: new Date().toISOString(),
      echo_commit: echoCommit,
      session_id: SID,
      project_id: projectId,
      sample_size: {
        tape_events: tapeEvents.length,
        snapshots: snapshotRows.length,
        snapshot_files: fileRows.length,
        hook_events_drained: first.drained,
        native_log_lines: parentLines.length,
      },
      coverage,
      capture_gaps: gaps,
      reconciled: (reconciledEvents[0] as { payload: unknown }).payload,
      capture_quality: row.capture_quality,
      quality_matches_finalize: row.capture_quality === direct.quality,
      raw_secret_scan: {
        surfaces: ["tape", "shadow blobs", "spool", "sqlite", "logs", "demo bundle"],
        forbidden_markers: forbidden.length,
        findings: 0,
      },
      caveats: [
        "Synthetic fixture: no real Muse build, hook timings, or compaction behavior.",
        "Single session; concurrency and clock-skew paths are not exercised.",
        "Oversized threshold is the production default (2 MiB); tool.pre 500 ms budget not stressed.",
        "Absence of intermediate states is asserted on captured artifacts, not proven for the filesystem.",
      ],
      not_measured: [
        "citation support — needs hand-labeled answers on real tapes",
        "refusal rate — needs unanswerable questions on real tapes",
        "check pass rate and time to first check — needs the check engine on real tapes",
        "hunk selection and attempt tree — need real diffs",
      ],
    };
    writeFileSync(join(OUT_DIR, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    const passCount = coverage.filter((entry) => entry.status === "pass").length;
    const missed = coverage.filter((entry) => entry.status !== "pass");
    writeFileSync(
      join(OUT_DIR, "report.md"),
      `# Capture integrity (fixture)\n\nSample: 1 synthetic session, ${tapeEvents.length} tape events, ${snapshotRows.length} snapshots, ${fileRows.length} snapshot files.\n\nCoverage: ${passCount}/${coverage.length} pass; missed states: ${missed.map((entry) => entry.item).join(", ")}.\n\nCapture quality \`${row.capture_quality}\` persisted by ingest, identical to a direct finalizeMuseSession call on the same inputs.\n\nRaw-secret scan over tape, shadow blobs, spool, SQLite, logs, and demo bundle: 0 findings (zero tolerance).\n\nCaveats: synthetic fixture, single session, no real Muse build; intermediates asserted absent on artifacts, not proven for the filesystem.\n\nNot measured here (need real tapes, stay manual): citation support, refusal rate, check pass rate, time to first check, hunk selection, attempt tree.\n\nEcho commit: ${echoCommit}\n`,
    );
    db.close();
  }, 60_000);
});
