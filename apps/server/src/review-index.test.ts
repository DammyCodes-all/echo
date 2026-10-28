import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TapeEnvelopeSchema } from "@echo/contracts";
import { appendEvents, insertSnapshot, openEchoDb, upsertProject, upsertSession } from "@echo/db";
import type { SnapshotResult } from "@echo/snapshots";
import { snapshotWorkingTree } from "@echo/snapshots";
import { describe, expect, it } from "vitest";
import { buildSessionReview } from "./review-index";
import { makeSnapshotEvent } from "./tape-events";

const TAKEN_AT = new Date("2026-10-28T10:00:00.000Z");

async function takeSnapshot(input: {
  dataDir: string;
  root: string;
  sessionId: string;
  projectId: string;
  trigger: "baseline" | "final" | "tool.post";
  eventId: string;
}): Promise<SnapshotResult> {
  return snapshotWorkingTree({
    shadowDir: join(input.dataDir, "projects", input.projectId, "shadow.git"),
    root: input.root,
    dataDir: input.dataDir,
    sessionId: input.sessionId,
    projectId: input.projectId,
    trigger: input.trigger,
    eventId: input.eventId,
    takenAt: TAKEN_AT,
  });
}

function toolEvent(sessionId: string, projectId: string, eventId: string) {
  return TapeEnvelopeSchema.parse({
    v: 1,
    tape_seq: 0,
    event_id: eventId,
    record_key: `test:${eventId}`,
    session_id: sessionId,
    project_id: projectId,
    kind: "tool.completed",
    ts: TAKEN_AT.toISOString(),
    observed_at: TAKEN_AT.toISOString(),
    source: {
      agent: "opencode",
      adapter: "test",
      adapter_version: "0.1.0",
      build: null,
      schema: null,
      record_type: "test",
      payload_type: null,
      sequence: 1,
      durability: null,
      origin: "import",
    },
    links: {
      turn_id: null,
      tool_call_id: "prt_notes",
      batch_id: null,
      parent_session_id: null,
      subagent_id: null,
      snapshot: null,
    },
    payload: { name: "write", input: { path: "notes.txt" }, status: "completed" },
    redaction: { version: "r1", findings: 0 },
    diagnostics: [],
  });
}

describe("buildSessionReview", () => {
  it("links final hunks to introducing snapshots and reverted attempts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-review-data-"));
    const root = mkdtempSync(join(tmpdir(), "echo-review-root-"));
    const projectId = "prj_review";
    const sessionId = "ses_review";
    writeFileSync(join(root, "notes.txt"), "a\n");

    const baseline = await takeSnapshot({
      dataDir,
      root,
      sessionId,
      projectId,
      trigger: "baseline",
      eventId: "evt_base",
    });
    writeFileSync(join(root, "notes.txt"), "a\nb\n");
    const middle = await takeSnapshot({
      dataDir,
      root,
      sessionId,
      projectId,
      trigger: "tool.post",
      eventId: "evt_mid",
    });
    writeFileSync(join(root, "notes.txt"), "a\nc\n");
    const final = await takeSnapshot({
      dataDir,
      root,
      sessionId,
      projectId,
      trigger: "final",
      eventId: "evt_final",
    });

    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    try {
      upsertProject(db, { id: projectId, root, name: "review" });
      upsertSession(db, {
        id: sessionId,
        projectId,
        agent: "opencode",
        model: null,
        directory: root,
        title: "review",
        startedAt: TAKEN_AT.toISOString(),
        tapePath: join(dataDir, "tape.jsonl"),
        captureQuality: "partial",
      });
      for (const snapshot of [baseline, middle, final]) {
        insertSnapshot(db, {
          id: snapshot.commitOid,
          sessionId,
          commitOid: snapshot.commitOid,
          parentOid: snapshot.parentOid,
          trigger: snapshot.trigger,
          eventId:
            snapshot.trigger === "baseline"
              ? "evt_base"
              : snapshot.trigger === "final"
                ? "evt_final"
                : "evt_mid",
          takenAt: snapshot.takenAt,
          fileCount: snapshot.fileCount,
          totalBytes: snapshot.totalBytes,
          status: snapshot.status,
          diagnostics: snapshot.diagnostics,
          files: snapshot.files.map((file) => ({
            path: file.path,
            mode: file.mode,
            blobOid: file.blobOid,
            size: file.size,
            sha256: file.sha256,
            captured: file.captured,
            reason: file.reason,
          })),
        });
      }
      appendEvents(db, sessionId, [
        makeSnapshotEvent({
          agent: "opencode",
          sessionId,
          projectId,
          eventId: "evt_base",
          observedAt: TAKEN_AT.toISOString(),
          result: baseline,
        }),
        makeSnapshotEvent({
          agent: "opencode",
          sessionId,
          projectId,
          eventId: "evt_mid",
          observedAt: TAKEN_AT.toISOString(),
          result: middle,
        }),
        makeSnapshotEvent({
          agent: "opencode",
          sessionId,
          projectId,
          eventId: "evt_final",
          observedAt: TAKEN_AT.toISOString(),
          result: final,
        }),
        toolEvent(sessionId, projectId, "evt_tool"),
      ]);

      const review = await buildSessionReview(db, dataDir, sessionId);
      expect(review.baselineCommit).toBe(baseline.commitOid);
      expect(review.finalCommit).toBe(final.commitOid);
      expect(review.hunks).toHaveLength(1);
      expect(review.attempts.map((attempt) => attempt.status)).toEqual([
        "baseline",
        "replaced",
        "landed",
      ]);
      const hunkId = review.hunks[0]?.id;
      if (!hunkId) throw new Error("review hunk missing");
      const evidence = review.evidenceByHunk[hunkId] ?? [];
      expect(
        evidence.some(
          (entry) => entry.relation === "introduced_by" && entry.snapshotId === final.commitOid,
        ),
      ).toBe(true);
      expect(evidence.some((entry) => entry.relation === "reverted_attempt")).toBe(true);
      expect(
        evidence.some(
          (entry) => entry.relation === "related_event" && entry.eventId === "evt_tool",
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});
