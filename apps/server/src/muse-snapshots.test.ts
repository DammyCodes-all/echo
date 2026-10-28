import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildTapeEvent, emptyLinks, runMuseHook } from "@echo/capture-muse";
import { projectIdForDirectory } from "@echo/core";
import {
  getSessionRecordKeys,
  insertStampedEvents,
  latestSnapshot,
  listSnapshots,
  maxTapeSeq,
  openEchoDb,
  upsertProject,
  upsertSession,
} from "@echo/db";
import { readShadowBlob, snapshotWorkingTree } from "@echo/snapshots";
import { TapeWriter } from "@echo/tape";
import { describe, expect, it } from "vitest";
import {
  ensureBaselineSnapshot,
  handleHookTriggerSnapshots,
  isMutatingTool,
  maybeBatchPostSnapshot,
  maybeFinalSnapshot,
  maybeToolPostSnapshot,
  maybeToolPreSnapshot,
  snapshotRecordKey,
} from "./muse-snapshots";

const log = { info: () => {}, error: () => {} };
const OBSERVED = "2026-10-28T10:00:00.000Z";

// Poll-based wait: deterministic outcome (pass/fail by deadline) without
// fixed sleeps for background reconciliation.
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-snap-data-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "echo-snap-proj-"));
  writeFileSync(join(projectRoot, "app.ts"), "export const v = 1;\n");
  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  const projectId = projectIdForDirectory(projectRoot);
  const sessionId = `ses_${Math.random().toString(36).slice(2, 10)}`;
  const tapePath = join(dataDir, "projects", projectId, "sessions", sessionId, "tape.jsonl");
  upsertProject(db, { id: projectId, root: projectRoot, name: "proj" });
  upsertSession(db, {
    id: sessionId,
    projectId,
    agent: "muse",
    model: null,
    directory: projectRoot,
    title: null,
    startedAt: OBSERVED,
    tapePath,
    captureQuality: "degraded",
  });
  return { dataDir, projectRoot, db, projectId, sessionId, tapePath };
}

function tapeKinds(tapePath: string): string[] {
  return readFileSync(tapePath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { kind: string }).kind);
}

// Minimal session.ended marker so maybeFinalSnapshot has something to gate on.
function addSessionEnded(fixture: ReturnType<typeof setup>): void {
  const { event } = buildTapeEvent({
    kind: "session.ended",
    payload: { hook: "SessionEnd" },
    payloadType: "hook",
    recordType: "hook",
    sequence: null,
    ts: OBSERVED,
    recordKey: `muse:${fixture.sessionId}:hook:test-end`,
    links: emptyLinks(),
    diagnostics: [],
    sessionId: fixture.sessionId,
    projectId: fixture.projectId,
    build: null,
    observedAt: OBSERVED,
    tapeSeq: 0,
    schema: "hook/v1",
    origin: "live",
  });
  let seq = maxTapeSeq(fixture.db, fixture.sessionId);
  seq += 1;
  event.tape_seq = seq;
  mkdirSync(dirname(fixture.tapePath), { recursive: true });
  const writer = new TapeWriter(fixture.tapePath);
  try {
    writer.append(event);
    writer.flush();
  } finally {
    writer.close();
  }
  insertStampedEvents(fixture.db, fixture.sessionId, [event]);
}

describe("muse snapshot triggers", () => {
  it("takes the baseline exactly once per session", async () => {
    const f = setup();
    const deps = { dataDir: f.dataDir, db: f.db, log };
    const input = {
      sessionId: f.sessionId,
      projectId: f.projectId,
      root: f.projectRoot,
      observedAt: OBSERVED,
    };
    const first = await ensureBaselineSnapshot(deps, input);
    expect(first.taken).toBe(true);
    expect(first.eventsAdded).toBe(1);
    expect(first.commitOid).toBeTypeOf("string");
    expect(tapeKinds(f.tapePath)).toEqual(["file.snapshot"]);
    const stored = JSON.parse(readFileSync(f.tapePath, "utf8").split("\n")[0] as string) as {
      record_key: string;
      links: { snapshot: { kind: string; snapshot_id: string } };
    };
    expect(stored.record_key).toBe(snapshotRecordKey(f.sessionId, "baseline", "baseline"));
    expect(stored.links.snapshot).toMatchObject({ kind: "shadow" });
    expect(stored.links.snapshot.snapshot_id).toBe(first.commitOid);
    expect(latestSnapshot(f.db, f.sessionId, "baseline")?.commitOid).toBe(first.commitOid);

    const second = await ensureBaselineSnapshot(deps, input);
    expect(second.taken).toBe(false);
    expect(second.eventsAdded).toBe(0);
    expect(tapeKinds(f.tapePath)).toEqual(["file.snapshot"]);
    expect(listSnapshots(f.db, f.sessionId)).toHaveLength(1);
    f.db.close();
  });

  it("fires tool.pre only for mutating tools and marks timeouts stale", async () => {
    const f = setup();
    const deps = { dataDir: f.dataDir, db: f.db, log };
    await ensureBaselineSnapshot(deps, {
      sessionId: f.sessionId,
      projectId: f.projectId,
      root: f.projectRoot,
      observedAt: OBSERVED,
    });
    expect(isMutatingTool("read")).toBe(false);
    expect(isMutatingTool("write")).toBe(true);
    expect(isMutatingTool("Edit")).toBe(true);
    expect(isMutatingTool("apply_patch")).toBe(true);
    expect(isMutatingTool("bash")).toBe(true);
    expect(isMutatingTool(null)).toBe(false);

    const base = {
      sessionId: f.sessionId,
      projectId: f.projectId,
      root: f.projectRoot,
      observedAt: OBSERVED,
    };
    const skipped = await maybeToolPreSnapshot(deps, {
      ...base,
      toolName: "read",
      triggerEventId: "e1",
    });
    expect(skipped.taken).toBe(false);
    expect(tapeKinds(f.tapePath)).toEqual(["file.snapshot"]);

    const fired = await maybeToolPreSnapshot(deps, {
      ...base,
      toolName: "write",
      triggerEventId: "e2",
    });
    expect(fired.taken).toBe(true);
    expect(tapeKinds(f.tapePath)).toEqual(["file.snapshot", "file.snapshot"]);

    const duplicate = await maybeToolPreSnapshot(deps, {
      ...base,
      toolName: "write",
      triggerEventId: "e2",
    });
    expect(duplicate.taken).toBe(false);
    expect(tapeKinds(f.tapePath)).toEqual(["file.snapshot", "file.snapshot"]);

    // Slow snapshotter: the 500ms budget trips, the last snapshot is kept,
    // and the pre-state is marked stale instead of fabricated.
    const slowDeps = {
      ...deps,
      snapshotFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        throw new Error("must not be used after timeout");
      },
    };
    const timedOut = await maybeToolPreSnapshot(slowDeps, {
      ...base,
      toolName: "edit",
      triggerEventId: "e3",
    });
    expect(timedOut.taken).toBe(false);
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.eventsAdded).toBe(1);
    expect(latestSnapshot(f.db, f.sessionId, "tool.pre")?.commitOid).toBe(fired.commitOid);
    const kinds = tapeKinds(f.tapePath);
    expect(kinds[kinds.length - 1]).toBe("capture.gap");
    const gapLine = readFileSync(f.tapePath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .pop() as string;
    expect(JSON.parse(gapLine).diagnostics).toContain("stale_pre_state");
    f.db.close();
  });

  it("fires tool.post on success and failure and observes file changes", async () => {
    const f = setup();
    const deps = { dataDir: f.dataDir, db: f.db, log };
    const base = {
      sessionId: f.sessionId,
      projectId: f.projectId,
      root: f.projectRoot,
      observedAt: OBSERVED,
    };
    const baseline = await ensureBaselineSnapshot(deps, base);
    writeFileSync(join(f.projectRoot, "app.ts"), "export const v = 2;\n");
    const postOk = await maybeToolPostSnapshot(deps, {
      ...base,
      toolName: "write",
      triggerEventId: "ok1",
    });
    expect(postOk.taken).toBe(true);
    expect(postOk.commitOid).not.toBe(baseline.commitOid);
    // A failed tool may still have written: post still fires.
    writeFileSync(join(f.projectRoot, "app.ts"), "export const v = 3;\n");
    const postFailed = await maybeToolPostSnapshot(deps, {
      ...base,
      toolName: "exec",
      triggerEventId: "fail1",
    });
    expect(postFailed.taken).toBe(true);
    expect(postFailed.commitOid).not.toBe(postOk.commitOid);
    expect(listSnapshots(f.db, f.sessionId).map((row) => row.trigger)).toEqual([
      "baseline",
      "tool.post",
      "tool.post",
    ]);
    f.db.close();
  });

  it("takes one snapshot per batch boundary", async () => {
    const f = setup();
    const deps = { dataDir: f.dataDir, db: f.db, log };
    const base = {
      sessionId: f.sessionId,
      projectId: f.projectId,
      root: f.projectRoot,
      observedAt: OBSERVED,
    };
    const first = await maybeBatchPostSnapshot(deps, {
      ...base,
      toolName: null,
      triggerEventId: "b1",
    });
    expect(first.taken).toBe(true);
    const duplicate = await maybeBatchPostSnapshot(deps, {
      ...base,
      toolName: null,
      triggerEventId: "b1",
    });
    expect(duplicate.taken).toBe(false);
    const second = await maybeBatchPostSnapshot(deps, {
      ...base,
      toolName: null,
      triggerEventId: "b2",
    });
    expect(second.taken).toBe(true);
    expect(
      listSnapshots(f.db, f.sessionId).filter((row) => row.trigger === "batch.post"),
    ).toHaveLength(2);
    f.db.close();
  });

  it("takes the final snapshot only after SessionEnd and once", async () => {
    const f = setup();
    const deps = { dataDir: f.dataDir, db: f.db, log };
    const input = {
      sessionId: f.sessionId,
      projectId: f.projectId,
      root: f.projectRoot,
      observedAt: OBSERVED,
    };
    const early = await maybeFinalSnapshot(deps, input);
    expect(early.taken).toBe(false);
    expect(early.reason).toBe("no-session-end");
    addSessionEnded(f);
    const done = await maybeFinalSnapshot(deps, input);
    expect(done.taken).toBe(true);
    const rerun = await maybeFinalSnapshot(deps, input);
    expect(rerun.taken).toBe(false);
    expect(rerun.eventsAdded).toBe(0);
    expect(listSnapshots(f.db, f.sessionId).filter((row) => row.trigger === "final")).toHaveLength(
      1,
    );
    expect(
      getSessionRecordKeys(f.db, f.sessionId).has(snapshotRecordKey(f.sessionId, "final", "final")),
    ).toBe(true);
    f.db.close();
  });

  it("records a gap and no fabricated state when the snapshotter fails", async () => {
    const f = setup();
    const failing = {
      dataDir: f.dataDir,
      db: f.db,
      log,
      snapshotFn: async (): Promise<never> => {
        throw new Error("git exploded");
      },
    };
    const result = await ensureBaselineSnapshot(failing, {
      sessionId: f.sessionId,
      projectId: f.projectId,
      root: f.projectRoot,
      observedAt: OBSERVED,
    });
    expect(result.taken).toBe(false);
    expect(result.eventsAdded).toBe(1);
    expect(listSnapshots(f.db, f.sessionId)).toHaveLength(0);
    expect(tapeKinds(f.tapePath)).toEqual(["capture.gap"]);
    f.db.close();
  });

  it("leaves no raw synthetic secret in tape, snapshot or spool", async () => {
    const secret = "sk-fixture-synthetic-secret-0001";
    const f = setup();
    mkdirSync(join(f.projectRoot, "src"), { recursive: true });
    writeFileSync(join(f.projectRoot, "src", "app.ts"), `export const key = "${secret}";\n`);
    const deps = { dataDir: f.dataDir, db: f.db, log };
    const snapped = await ensureBaselineSnapshot(deps, {
      sessionId: f.sessionId,
      projectId: f.projectId,
      root: f.projectRoot,
      observedAt: OBSERVED,
    });
    expect(snapped.taken).toBe(true);
    expect(readFileSync(f.tapePath, "utf8")).not.toContain(secret);

    const files = listSnapshots(f.db, f.sessionId);
    expect(files.length).toBeGreaterThan(0);
    const shadowDir = join(f.dataDir, "projects", f.projectId, "shadow.git");
    const row = files[0];
    expect(row).toBeDefined();
    if (row) {
      const blobs = (await import("@echo/db"))
        .listSnapshotFiles(f.db, row.id)
        .filter((entry) => entry.captured && entry.blobOid);
      expect(blobs.length).toBeGreaterThan(0);
      for (const blob of blobs) {
        if (!blob.blobOid) continue;
        const bytes = await readShadowBlob(shadowDir, blob.blobOid);
        expect(Buffer.from(bytes).toString("utf8")).not.toContain(secret);
      }
    }

    const spooled = runMuseHook({
      dataDir: f.dataDir,
      event: "PreToolUse",
      rawStdin: JSON.stringify({
        session_id: f.sessionId,
        cwd: f.projectRoot,
        tool_name: "write",
        input: { content: secret },
      }),
      stdinTruncated: false,
      projects: [f.projectRoot],
      receivedAt: OBSERVED,
    });
    expect(readFileSync(spooled.path, "utf8")).not.toContain(secret);
    f.db.close();
  });

  it("reconciles a pre-snapshot that lands after the timeout", async () => {
    const f = setup();
    const deps = {
      dataDir: f.dataDir,
      db: f.db,
      log,
      // Budget trips at 40ms; the real snapshotter lands ~150ms later.
      preTimeoutMs: 40,
      snapshotFn: async (
        options: Parameters<typeof snapshotWorkingTree>[0],
      ): Promise<Awaited<ReturnType<typeof snapshotWorkingTree>>> => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return snapshotWorkingTree(options);
      },
    };
    const result = await maybeToolPreSnapshot(deps, {
      sessionId: f.sessionId,
      projectId: f.projectId,
      root: f.projectRoot,
      observedAt: OBSERVED,
      toolName: "write",
      triggerEventId: "late1",
    });
    expect(result.taken).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(tapeKinds(f.tapePath)).toEqual(["capture.gap"]);
    // The late commit already moved the session ref; the reconciled record
    // must follow so the ref never points at an unrecorded commit.
    const recordKey = snapshotRecordKey(f.sessionId, "tool.pre", "late1");
    await waitFor(() => getSessionRecordKeys(f.db, f.sessionId).has(recordKey));
    expect(latestSnapshot(f.db, f.sessionId, "tool.pre")).not.toBeNull();
    expect(tapeKinds(f.tapePath)).toEqual(["capture.gap", "file.snapshot"]);
    f.db.close();
  });

  it("caps trigger snapshots per batch and marks the rest as budget gaps", async () => {
    const f = setup();
    const deps = { dataDir: f.dataDir, db: f.db, log };
    const hooks = [
      {
        sessionId: f.sessionId,
        projectId: f.projectId,
        root: f.projectRoot,
        kind: "session.started",
        toolName: null,
        eventId: "hook-start",
        isNewSession: true,
      },
      ...["p1", "p2", "p3", "p4"].map((id) => ({
        sessionId: f.sessionId,
        projectId: f.projectId,
        root: f.projectRoot,
        kind: "tool.completed",
        toolName: "write",
        eventId: id,
        isNewSession: false,
      })),
    ];
    // Baseline is exempt from the budget: 1 baseline + 2 posts taken, 2 gaps.
    const batch = await handleHookTriggerSnapshots(deps, hooks, OBSERVED, 2);
    expect(batch.triggerSnapshots).toBe(2);
    expect(batch.budgetSkipped).toBe(2);
    expect(batch.eventsAdded).toBe(5);
    expect(listSnapshots(f.db, f.sessionId)).toHaveLength(3);
    const gaps = tapeKinds(f.tapePath).filter((kind) => kind === "capture.gap");
    expect(gaps).toHaveLength(2);
    const tape = readFileSync(f.tapePath, "utf8");
    expect(tape).toContain("snapshot_budget_exhausted");
    f.db.close();
  });
});
