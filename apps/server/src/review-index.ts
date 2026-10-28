import { join } from "node:path";
import { type HunkInput, rankHunks } from "@echo/checks";
import {
  type FileAttempt,
  type HunkEvidence,
  type SessionReview,
  SessionReviewSchema,
  type StoredEvent,
} from "@echo/contracts";
import {
  type EchoDb,
  getSession,
  listSnapshotFiles,
  listSnapshots,
  readAllEvents,
  type SnapshotFileRow,
} from "@echo/db";
import { diffShadowCommits, readShadowBlob } from "@echo/snapshots";
import {
  buildFileAttempts,
  buildFinalLineOrigins,
  type FileVersion,
  hunkFromParsed,
  linkHunkEvidence,
  type ParsedDiffHunk,
  parseUnifiedDiffs,
  type RelatedEvent,
  type ReviewHunk as TapeReviewHunk,
} from "@echo/tape";

export interface SessionReviewOptions {
  maxEvents?: number;
}

function textDecoder(): TextDecoder {
  return new TextDecoder("utf-8", { fatal: true });
}

function pathDiagnostic(path: string): string {
  return `review_diff_failed:${path}`;
}

function markPathUncertain(versions: FileVersion[]): void {
  for (const version of versions) {
    if (version.text !== null) {
      version.text = null;
      version.captured = false;
      version.reason = "review_diff_failed";
    }
  }
}

async function readVersionText(
  shadowDir: string,
  cache: Map<string, string | null>,
  file: SnapshotFileRow | undefined,
): Promise<string | null> {
  if (!file?.captured || !file.blobOid) return null;
  const cached = cache.get(file.blobOid);
  if (cached !== undefined) return cached;
  try {
    const text = textDecoder().decode(await readShadowBlob(shadowDir, file.blobOid));
    cache.set(file.blobOid, text);
    return text;
  } catch {
    cache.set(file.blobOid, null);
    return null;
  }
}

function eventText(event: Pick<StoredEvent, "kind" | "payload">): string | null {
  const payload = event.payload;
  if (typeof payload === "string") return payload.slice(0, 1000);
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.text === "string") return record.text.slice(0, 1000);
  if (typeof record.name === "string") {
    const input = record.input;
    const target =
      input !== null &&
      typeof input === "object" &&
      typeof (input as { path?: unknown }).path === "string"
        ? String((input as { path: unknown }).path)
        : "";
    return `${record.name} ${target}`.trim().slice(0, 500);
  }
  if (Array.isArray(record.parts)) {
    const said = record.parts
      .filter((part): part is Record<string, unknown> => part !== null && typeof part === "object")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter((text) => text.length > 0)
      .join("\n");
    if (said.length > 0) return said.slice(0, 1000);
  }
  return JSON.stringify(payload).slice(0, 1000);
}

function toHunkInput(hunk: TapeReviewHunk): HunkInput {
  return {
    path: hunk.path,
    deletionStart: hunk.oldStart,
    deletionLines: hunk.oldLines,
    additionStart: hunk.newStart,
    additionLines: hunk.addedLines,
    addedText: hunk.addedText,
    removedText: hunk.removedText,
  };
}

/**
 * Build the deterministic review model for one session from its snapshots,
 * shadow blobs, tape events and Git diffs. Git remains the line-mapping
 * authority; every uncertain input stays uncertain in the response.
 */
export async function buildSessionReview(
  db: EchoDb,
  dataDir: string,
  sessionId: string,
  options: SessionReviewOptions = {},
): Promise<SessionReview> {
  const session = getSession(db, sessionId);
  if (!session) {
    throw new Error(`unknown session: ${sessionId}`);
  }
  const shadowDir = join(dataDir, "projects", session.projectId, "shadow.git");
  const snapshots = listSnapshots(db, sessionId);
  const diagnostics: string[] = [];
  if (snapshots.length < 2) {
    return SessionReviewSchema.parse({
      sessionId,
      baselineCommit: snapshots[0]?.commitOid ?? null,
      finalCommit: snapshots[0]?.commitOid ?? null,
      hunks: [],
      attempts: [],
      evidenceByHunk: {},
      diagnostics: ["needs_two_snapshots"],
      generatedAt: new Date().toISOString(),
    });
  }

  const baseline = snapshots.find((snapshot) => snapshot.trigger === "baseline") ?? snapshots[0];
  const reversed = [...snapshots].reverse();
  const final =
    reversed.find((snapshot) => snapshot.trigger === "final") ?? snapshots[snapshots.length - 1];
  if (!baseline || !final) {
    throw new Error(`session snapshots are missing: ${sessionId}`);
  }

  const filesBySnapshot = new Map<string, Map<string, SnapshotFileRow>>();
  for (const snapshot of snapshots) {
    filesBySnapshot.set(
      snapshot.id,
      new Map(listSnapshotFiles(db, snapshot.id).map((file) => [file.path, file])),
    );
  }
  const sameFile = (oldFile: SnapshotFileRow | undefined, newFile: SnapshotFileRow | undefined) =>
    oldFile?.blobOid === newFile?.blobOid &&
    oldFile?.sha256 === newFile?.sha256 &&
    oldFile?.captured === newFile?.captured;
  // Union across every consecutive snapshot pair: a file the agent changed
  // and then fully reverted still counts as an attempt even though the
  // baseline-to-final diff is empty.
  const changedPaths = [
    ...new Set(
      snapshots.flatMap((snapshot, index) => {
        if (index === 0) return [];
        const oldFiles = filesBySnapshot.get(snapshots[index - 1]?.id ?? "") ?? new Map();
        const newFiles = filesBySnapshot.get(snapshot.id) ?? new Map();
        return [...new Set([...oldFiles.keys(), ...newFiles.keys()])].filter(
          (path) => !sameFile(oldFiles.get(path), newFiles.get(path)),
        );
      }),
    ),
  ].sort();
  if (changedPaths.length === 0) diagnostics.push("no_file_changes");

  const cache = new Map<string, string | null>();
  const versionsByPath = new Map<string, FileVersion[]>();
  for (const path of changedPaths) {
    const versions: FileVersion[] = [];
    for (const snapshot of snapshots) {
      const file = filesBySnapshot.get(snapshot.id)?.get(path);
      versions.push({
        snapshotId: snapshot.id,
        commitOid: snapshot.commitOid,
        trigger: snapshot.trigger,
        eventId: snapshot.eventId,
        takenAt: snapshot.takenAt,
        text: await readVersionText(shadowDir, cache, file),
        captured: file?.captured ?? false,
        reason: file?.reason ?? (file ? null : "absent"),
      });
    }
    versionsByPath.set(path, versions);
  }

  const diffsByTransition = new Map<string, ParsedDiffHunk[][]>();
  for (const path of changedPaths) {
    const versions = versionsByPath.get(path) ?? [];
    const hunksByTransition: ParsedDiffHunk[][] = [];
    for (let index = 0; index < versions.length - 1; index += 1) {
      const parent = versions[index] as FileVersion;
      const child = versions[index + 1] as FileVersion;
      const parentFile = filesBySnapshot.get(parent.snapshotId)?.get(path);
      const childFile = filesBySnapshot.get(child.snapshotId)?.get(path);
      if (
        parent.commitOid === child.commitOid ||
        (parentFile?.blobOid === childFile?.blobOid &&
          parentFile?.sha256 === childFile?.sha256 &&
          parentFile?.captured === childFile?.captured)
      ) {
        hunksByTransition.push([]);
        continue;
      }
      try {
        const diff = diffShadowCommits(shadowDir, parent.commitOid, child.commitOid, path);
        const parsed = parseUnifiedDiffs(diff);
        hunksByTransition.push(parsed[0]?.hunks ?? []);
      } catch (error) {
        // One unreadable transition must not fail the whole review; the
        // affected path degrades to uncertain downstream.
        diagnostics.push(pathDiagnostic(path));
        void error;
        markPathUncertain(versions);
        hunksByTransition.push([]);
      }
    }
    diffsByTransition.set(path, hunksByTransition);
  }

  const hunks: TapeReviewHunk[] = [];
  for (const path of changedPaths) {
    try {
      const diff = diffShadowCommits(shadowDir, baseline.commitOid, final.commitOid, path);
      const parsed = parseUnifiedDiffs(diff);
      for (const hunk of parsed[0]?.hunks ?? []) {
        hunks.push(hunkFromParsed(path, hunk));
      }
    } catch (error) {
      diagnostics.push(pathDiagnostic(path));
      void error;
      markPathUncertain(versionsByPath.get(path) ?? []);
    }
  }
  const ranked = rankHunks(hunks.map(toHunkInput));
  const riskByKey = new Map(
    ranked.map((entry) => [
      `${entry.hunk.path}:${entry.hunk.deletionStart}:${entry.hunk.deletionLines}:${entry.hunk.additionStart}:${entry.hunk.additionLines}`,
      entry,
    ]),
  );
  const scoredHunks = hunks.map((hunk) => {
    const risk = riskByKey.get(
      `${hunk.path}:${hunk.oldStart}:${hunk.oldLines}:${hunk.newStart}:${hunk.newLines}`,
    );
    return { ...hunk, riskScore: risk?.score ?? 0, riskReasons: risk?.reasons ?? [] };
  });

  const events = readAllEvents(db, sessionId, true, options.maxEvents ?? 25_000);
  const eventById = new Map(events.map((event) => [event.event_id, event]));
  for (const event of events) {
    if (event.kind === "capture.gap") diagnostics.push("capture_gap_on_tape");
  }

  const relatedEvents: RelatedEvent[] = events
    .filter((event) =>
      [
        "prompt.submitted",
        "model.response",
        "tool.requested",
        "tool.completed",
        "tool.failed",
        "approval.requested",
        "approval.decided",
      ].includes(event.kind),
    )
    .map((event) => ({
      eventId: event.event_id,
      kind: event.kind,
      toolCallId: event.tool_call_id,
      turnId: null,
      batchId: null,
      text: eventText(event),
    }));

  const attempts: FileAttempt[] = [];
  const evidenceByHunk: Record<string, HunkEvidence[]> = {};
  for (const path of changedPaths) {
    const versions = versionsByPath.get(path) ?? [];
    const hunksByTransition = diffsByTransition.get(path) ?? [];
    const fileAttempts = buildFileAttempts({
      path,
      versions,
      hunksByTransition,
      linksByTransition: versions.slice(1).map((version) => ({
        eventId: version.eventId,
        toolCallId: eventById.get(version.eventId ?? "")?.tool_call_id ?? null,
        toolOutcome: null,
        turnId: null,
        batchId: null,
      })),
      finalText: versions[versions.length - 1]?.text ?? null,
    });
    attempts.push(...fileAttempts);
    const origins = buildFinalLineOrigins({
      versions,
      hunksByTransition,
      finalText: versions[versions.length - 1]?.text ?? "",
    });
    for (const hunk of scoredHunks.filter((entry) => entry.path === path)) {
      evidenceByHunk[hunk.id] = linkHunkEvidence({
        hunk,
        origins,
        attempts: fileAttempts,
        relatedEvents,
      });
    }
  }

  return SessionReviewSchema.parse({
    sessionId,
    baselineCommit: baseline.commitOid,
    finalCommit: final.commitOid,
    hunks: scoredHunks,
    attempts,
    evidenceByHunk,
    diagnostics: [...new Set(diagnostics)],
    generatedAt: new Date().toISOString(),
  });
}
