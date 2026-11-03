import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  openEchoDb,
  recordChangeRef,
  recordProgress,
  upsertProject,
  upsertSession,
} from "@echo/db";
import { describe, expect, it } from "vitest";
import { buildDemoBundle, DemoBuildError } from "./build";

const PROJECT_ID = "prj_demo_build";
const SESSION_A = "ses_demo_build_a";
const SESSION_B = "ses_demo_build_b";
const CHANGE_A = "c_0123456789abcdef";

function changesFor(sessionId: string, changeCount = 1): Record<string, unknown> {
  return {
    sessionId,
    generatedAt: "2026-10-31T00:00:00.000Z",
    generator: "model-changes-v1",
    summary: "This session contains 1 reviewed change.",
    diagnostics: ["changes_evidence_gated_v2"],
    changes: Array.from({ length: changeCount }, (_, i) => ({
      id: i === 0 ? CHANGE_A : `c_0123456789abcde${i}`,
      version: 1,
      snapshotPair: { prevOid: "aaa", nextOid: "bbb" },
      title: "Retry failed billing writes once",
      summary: "The agent added a retry around billing writes. It fires once after a short delay.",
      before: ["Billing writes failed without a retry."],
      now: ["Billing writes retry once after a short delay."],
      howItWorks: ["The wrapper catches the write error."],
      headsUp: [{ type: "watch_out", text: "Retries can double-charge on timeouts." }],
      files: [{ path: "src/billing/retry.ts", note: "Adds the one-shot retry wrapper." }],
      digest: Array.from({ length: 60 }, (_, w) => `token${w}`).join(" "),
      createdFrom: { kind: "snapshot_pair", prevOid: "aaa", nextOid: "bbb" },
    })),
    snapshotWatermark: { snapshotCount: 2, lastOid: "bbb" },
  };
}

function checksFor(sessionId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionId,
    status: "in_progress",
    generatedAt: "2026-10-31T00:00:00.000Z",
    tapeWatermark: { eventCount: 1, sha256: "abc" },
    questions: [
      {
        id: "chk2_test00000001",
        cardId: "h_0123456789abcdef",
        kind: "teach_back",
        question: "Teach back the change.",
        evidenceFactIds: [],
        evidencePaths: ["src/app.ts"],
        format: "free_text",
        rubric: ["names the file"],
        explanation: "The change touched src/app.ts.",
      },
    ],
    attempts: [],
    picture: [],
    currentQuestionId: null,
    origin: "offer",
  };
}

interface Fixture {
  dataDir: string;
  webDir: string;
  outDir: string;
}

function seedSource(sessions: string[]): Fixture {
  const root = mkdtempSync(join(tmpdir(), "echo-demo-build-"));
  const dataDir = join(root, "data");
  const webDir = join(root, "web");
  const outDir = join(root, "out");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<html></html>");

  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  try {
    upsertProject(db, { id: PROJECT_ID, root: "/repo/demo", name: "demo" });
    for (const sessionId of sessions) {
      upsertSession(db, {
        id: sessionId,
        projectId: PROJECT_ID,
        agent: "muse",
        model: null,
        directory: "/repo/demo",
        title: "demo",
        startedAt: "2026-10-31T00:00:00.000Z",
        tapePath: join(dataDir, "projects", PROJECT_ID, "sessions", sessionId, "tape.jsonl"),
        captureQuality: "full",
      });
      // Builder-side reading state: must never ship in the bundle.
      recordChangeRef(db, {
        sessionId,
        changeId: CHANGE_A,
        version: 1,
        prevOid: "aaa",
        nextOid: "bbb",
      });
      recordProgress(db, {
        sessionId,
        changeId: CHANGE_A,
        version: 1,
        state: "understood",
      });
      db.prepare(
        `INSERT INTO events (id, session_id, tape_seq, source_sequence, kind, ts, observed_at, tool_call_id, payload_json, redaction_json, created_at, record_key)
         VALUES (?, ?, 0, 0, 'prompt.submitted', '2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z', NULL, '{}', '[]', '2026-10-31T00:00:00.000Z', NULL)`,
      ).run(`evt_${sessionId}`, sessionId);
    }
  } finally {
    db.close();
  }

  for (const sessionId of sessions) {
    const dir = join(dataDir, "projects", PROJECT_ID, "sessions", sessionId);
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    writeFileSync(join(dir, "tape.jsonl"), '{"v":1}\n');
    writeFileSync(join(dir, "changes.json"), JSON.stringify(changesFor(sessionId)));
    writeFileSync(join(dir, "artifacts", "checks_v2.json"), JSON.stringify(checksFor(sessionId)));
  }

  // Minimal shadow repo with one commit and one ref per session.
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const git = (args: string[], cwd?: string) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet", "--initial-branch=main"], work);
  writeFileSync(join(work, "app.ts"), "export const x = 1;\n");
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "app.ts"], work);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "one"], work);
  const shadowGit = join(dataDir, "projects", PROJECT_ID, "shadow.git");
  git(["clone", "--quiet", "--bare", work, shadowGit]);
  for (const sessionId of sessions) {
    git(["--git-dir", shadowGit, "update-ref", `refs/echo/sessions/${sessionId}`, "HEAD"]);
  }
  return { dataDir, webDir, outDir };
}

function dbRows(dataDir: string, table: string): number {
  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe("demo build", () => {
  it("builds a bundle with allowlisted rows, scrubbed paths, and meta", () => {
    const { dataDir, webDir, outDir } = seedSource([SESSION_A, SESSION_B]);
    const steps: string[] = [];
    const { meta } = buildDemoBundle({
      dataDir,
      sessionIds: [SESSION_A],
      outDir,
      webDir,
      report: (step) => steps.push(step),
      now: () => new Date("2026-10-31T00:00:00.000Z"),
    });
    expect(steps.length).toBeGreaterThan(3);
    expect(meta).toMatchObject({
      version: 2,
      builtAt: "2026-10-31T00:00:00.000Z",
      projectId: PROJECT_ID,
      projectName: "demo",
      sessions: [SESSION_A],
    });
    expect(meta.tapeSha256[SESSION_A]).toMatch(/^[0-9a-f]{64}$/);

    const bakedData = join(outDir, "data");
    expect(dbRows(bakedData, "sessions")).toBe(1);
    expect(dbRows(bakedData, "events")).toBe(1);
    expect(dbRows(bakedData, "projects")).toBe(1);
    expect(dbRows(bakedData, "reader_checkpoints")).toBe(0);
    expect(dbRows(bakedData, "change_refs")).toBe(0);
    expect(dbRows(bakedData, "change_progress")).toBe(0);
    const db = openEchoDb(join(bakedData, "echo.sqlite"));
    try {
      const root = db.prepare("SELECT canonical_root FROM projects").get() as {
        canonical_root: string;
      };
      expect(root.canonical_root).toBe("/demo/demo");
      const dir = db.prepare("SELECT directory FROM sessions").get() as { directory: string };
      expect(dir.directory).toBe("/demo/demo");
    } finally {
      db.close();
    }

    expect(
      existsSync(join(bakedData, "projects", PROJECT_ID, "sessions", SESSION_A, "tape.jsonl")),
    ).toBe(true);
    expect(
      existsSync(join(bakedData, "projects", PROJECT_ID, "sessions", SESSION_B, "tape.jsonl")),
    ).toBe(false);
    expect(existsSync(join(outDir, "web", "index.html"))).toBe(true);
    expect(existsSync(join(outDir, "shadow.bundle"))).toBe(true);
    expect(existsSync(join(bakedData, "projects", PROJECT_ID, "shadow.git", "HEAD"))).toBe(true);
    const refs = execFileSync(
      "git",
      [
        "--git-dir",
        join(bakedData, "projects", PROJECT_ID, "shadow.git"),
        "for-each-ref",
        "--format=%(refname)",
      ],
      { encoding: "utf8" },
    );
    expect(refs).toContain(`refs/echo/sessions/${SESSION_A}`);
  });

  it("trims session-FK tables without violating constraints", () => {
    const { dataDir, webDir, outDir } = seedSource([SESSION_A, SESSION_B]);
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    try {
      for (const sid of [SESSION_A, SESSION_B]) {
        db.prepare(
          "INSERT INTO engagement_events (id, session_id, card_id, kind, occurred_at, created_at) VALUES (?, ?, NULL, 'card_seen', '2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z')",
        ).run(`eng_${sid}`, sid);
        db.prepare(
          "INSERT INTO change_refs (session_id, change_id, version, prev_oid, next_oid, created_at) VALUES (?, 'ch1', 1, 'a', 'b', '2026-10-31T00:00:00.000Z')",
        ).run(sid);
        db.prepare(
          "INSERT INTO change_progress (session_id, change_id, version, state, updated_at) VALUES (?, 'ch1', 1, 'new', '2026-10-31T00:00:00.000Z')",
        ).run(sid);
      }
      // A second project with index rows: deleting it must not trip the
      // project-child FKs (code_files, project_artifacts, ...).
      upsertProject(db, { id: "prj_demo_other", root: "/repo/other", name: "other" });
      db.prepare(
        "INSERT INTO code_files (project_id, path, language, size, sha256, parsed, indexed_at) VALUES ('prj_demo_other', 'a.ts', 'ts', 1, 'x', 0, '2026-10-31T00:00:00.000Z')",
      ).run();
      db.prepare(
        "INSERT INTO project_artifacts (project_id, kind, path, watermark, generator, generated_at) VALUES ('prj_demo_other', 'k', 'p', 'w', 'g', '2026-10-31T00:00:00.000Z')",
      ).run();
    } finally {
      db.close();
    }
    // Pre-fix this threw FOREIGN KEY constraint failed: change_refs,
    // change_progress, and engagement_events all reference sessions, and the
    // full-wipe tables reference projects. Adopted behavior is full-wipe
    // (builder-side reading state never ships), so all narrow to zero.
    buildDemoBundle({ dataDir, sessionIds: [SESSION_A], outDir, webDir });
    const bakedData = join(outDir, "data");
    expect(dbRows(bakedData, "engagement_events")).toBe(0);
    expect(dbRows(bakedData, "change_refs")).toBe(0);
    expect(dbRows(bakedData, "change_progress")).toBe(0);
    expect(dbRows(bakedData, "projects")).toBe(1);
    expect(dbRows(bakedData, "code_files")).toBe(0);
    expect(dbRows(bakedData, "project_artifacts")).toBe(0);
  });

  it("fails closed on a raw secret in the tape", () => {
    const { dataDir, webDir, outDir } = seedSource([SESSION_A]);
    const tape = join(dataDir, "projects", PROJECT_ID, "sessions", SESSION_A, "tape.jsonl");
    writeFileSync(tape, '{"v":1,"leak":"Bearer abcdefghijklmnopqr"}\n');
    expect(() =>
      buildDemoBundle({ dataDir, sessionIds: [SESSION_A], outDir, webDir }),
    ).toThrowError(/bundle scan failed.*bearer-token/);
  });

  it("rejects sessions with no reviewed changes to show", () => {
    const { dataDir, webDir, outDir } = seedSource([SESSION_A]);
    const changesPath = join(
      dataDir,
      "projects",
      PROJECT_ID,
      "sessions",
      SESSION_A,
      "changes.json",
    );
    writeFileSync(changesPath, JSON.stringify(changesFor(SESSION_A, 0)));
    expect(() =>
      buildDemoBundle({ dataDir, sessionIds: [SESSION_A], outDir, webDir }),
    ).toThrowError(/no reviewed changes/);
  });

  it("rejects bad allowlists and missing bakes", () => {
    const { dataDir, webDir, outDir } = seedSource([SESSION_A]);
    expect(() => buildDemoBundle({ dataDir, sessionIds: [], outDir, webDir })).toThrowError(
      DemoBuildError,
    );
    expect(() =>
      buildDemoBundle({ dataDir, sessionIds: [SESSION_A, SESSION_B, "ses_x"], outDir, webDir }),
    ).toThrowError(/one or two sessions/);
    expect(() =>
      buildDemoBundle({ dataDir, sessionIds: ["ses_nope"], outDir, webDir }),
    ).toThrowError(/unknown sessions/);
    expect(() =>
      buildDemoBundle({
        dataDir,
        sessionIds: [SESSION_A],
        outDir,
        webDir: join(webDir, "missing"),
      }),
    ).toThrowError(/web assets/);
  });

  it("refuses to build into home", () => {
    const { dataDir, webDir } = seedSource([SESSION_A]);
    expect(() =>
      buildDemoBundle({ dataDir, sessionIds: [SESSION_A], outDir: homedir(), webDir }),
    ).toThrowError(/refusing to build/);
  });
});
