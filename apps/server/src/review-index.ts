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
  getReviewTransition,
  getSession,
  listSnapshotFiles,
  listSnapshots,
  putReviewTransition,
  REVIEW_CACHE_VERSION,
  readAllEvents,
  type SnapshotFileRow,
} from "@echo/db";
import { redactJson } from "@echo/redaction";
import { diffShadowCommits, diffShadowTrees, readShadowBlob } from "@echo/snapshots";
import {
  buildFileAttempts,
  buildFinalLineOrigins,
  type FileVersion,
  type FinalLineOrigin,
  hunkFromParsed,
  linkHunkEvidence,
  type ParsedDiffHunk,
  type ParsedFileDiff,
  parseUnifiedDiffs,
  pathMentions,
  type RelatedEvent,
  type ReviewHunk as TapeReviewHunk,
} from "@echo/tape";

export interface SessionReviewOptions {
  maxEvents?: number;
  /** Wall-clock budget for the git-bound loops below. Pathological
   *  sessions (hundreds of snapshots × hundreds of files) otherwise spawn
   *  tens of thousands of git reads and never answer a page load. When the
   *  budget trips, remaining paths degrade to uncertain with a
   *  `review_budget_exceeded` diagnostic instead of hanging. */
  budgetMs?: number;
}

const REVIEW_BUDGET_MS_DEFAULT = 20_000;

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

/**
 * Split one parsed whole-tree diff into per-path hunk lists by file entry.
 * Renames stay disabled, so a moved file arrives as delete+add entries: the
 * old path owns the deletion hunks and the new path the addition hunks,
 * exactly like per-path diffs.
 */
function distributeHunks(files: ParsedFileDiff[]): Map<string, ParsedDiffHunk[]> {
  const byPath = new Map<string, ParsedDiffHunk[]>();
  for (const file of files) {
    const key = file.newPath ?? file.oldPath;
    if (key === null) continue;
    const existing = byPath.get(key);
    if (existing) existing.push(...file.hunks);
    else byPath.set(key, [...file.hunks]);
  }
  return byPath;
}

/**
 * Read one cached transition: exact commit pair plus matching code version,
 * structurally sane. Anything else is a miss — the pair recomputes and
 * overwrites, so a corrupt row self-heals without ever failing the review.
 */
function readCachedTransition(
  db: EchoDb,
  sessionId: string,
  parentCommit: string,
  childCommit: string,
): Map<string, ParsedDiffHunk[]> | null {
  const row = getReviewTransition(db, sessionId, parentCommit, childCommit);
  if (!row || row.codeVersion !== REVIEW_CACHE_VERSION) return null;
  try {
    const parsed = JSON.parse(row.hunksJson) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const grouped = new Map<string, ParsedDiffHunk[]>();
    for (const [path, hunks] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(hunks)) return null;
      grouped.set(path, hunks as ParsedDiffHunk[]);
    }
    return grouped;
  } catch {
    return null;
  }
}

/**
 * Persist one computed transition for future regens. Best effort by design:
 * a redaction failure or write error skips caching while the in-memory
 * review proceeds untouched — the cache is pure acceleration, never load
 * bearing, so there is nothing to surface downstream.
 */
function storeCachedTransition(
  db: EchoDb,
  sessionId: string,
  parentCommit: string,
  childCommit: string,
  grouped: Map<string, ParsedDiffHunk[]>,
): void {
  try {
    const redacted = redactJson(Object.fromEntries(grouped)).value;
    putReviewTransition(db, {
      sessionId,
      parentCommit,
      childCommit,
      hunksJson: JSON.stringify(redacted),
      codeVersion: REVIEW_CACHE_VERSION,
    });
  } catch {
    // Cache miss next time; the review itself is unaffected.
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

  // One pass per path: every path that finishes the pass owns complete
  // versions, one diff per transition, its baseline-to-final hunks, and its
  // attempt/origin attribution, so downstream code never sees a half-built
  // path. A path that never starts (or is abandoned mid-pass) contributes
  // nothing, exactly like an unreadable one. Budget checks ride along the
  // pass, so a pathological session (hundreds of snapshots × hundreds of
  // files, tens of thousands of git reads) degrades to a partial review
  // with a diagnostic instead of hanging a page load.
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

  const cache = new Map<string, string | null>();
  const attemptsByPath = new Map<string, FileAttempt[]>();
  const originsByPath = new Map<string, FinalLineOrigin[]>();
  const hunks: TapeReviewHunk[] = [];
  const deadline = Date.now() + (options.budgetMs ?? REVIEW_BUDGET_MS_DEFAULT);
  let budgetExceeded = false;
  // One whole-tree diff per consecutive snapshot pair, parsed once and
  // distributed by file entry; a path the diff omits is unchanged. A pair
  // whose diff fails falls back to per-path diffs in the loop below.
  // Transitions already computed on a previous run come from the
  // review_transition_cache (one row per commit pair, keyed immutable), so
  // steady-state regens only pay for new snapshots.
  const transitionHunksByPath: Array<Map<string, ParsedDiffHunk[]>> = [];
  const failedTransitions = new Set<number>();
  for (let index = 0; index < snapshots.length - 1; index += 1) {
    if (Date.now() > deadline) {
      budgetExceeded = true;
      break;
    }
    const parent = snapshots[index];
    const child = snapshots[index + 1];
    if (!parent || !child || parent.commitOid === child.commitOid) {
      transitionHunksByPath.push(new Map());
      continue;
    }
    const cached = readCachedTransition(db, sessionId, parent.commitOid, child.commitOid);
    if (cached) {
      transitionHunksByPath.push(cached);
      continue;
    }
    try {
      const diff = diffShadowTrees(shadowDir, parent.commitOid, child.commitOid);
      const grouped = distributeHunks(parseUnifiedDiffs(diff));
      transitionHunksByPath.push(grouped);
      storeCachedTransition(db, sessionId, parent.commitOid, child.commitOid, grouped);
    } catch (error) {
      void error;
      failedTransitions.add(index);
      transitionHunksByPath.push(new Map());
    }
  }
  // Baseline-to-final hunks come from a single whole-tree diff distributed
  // the same way; a failed diff falls back to per-path diffs below.
  let finalHunksByPath = new Map<string, ParsedDiffHunk[]>();
  let finalDiffFailed = false;
  if (!budgetExceeded && baseline.commitOid !== final.commitOid) {
    try {
      const diff = diffShadowTrees(shadowDir, baseline.commitOid, final.commitOid);
      finalHunksByPath = distributeHunks(parseUnifiedDiffs(diff));
    } catch (error) {
      void error;
      finalDiffFailed = true;
    }
  }
  for (const path of changedPaths) {
    if (Date.now() > deadline) {
      budgetExceeded = true;
      break;
    }
    const versions: FileVersion[] = [];
    let abandoned = false;
    // Blob reads are spawn-free but latency-bound; 32 in flight saturates
    // local disk without exhausting file descriptors. Promise.all preserves
    // input order, so attribution sees the same snapshot sequence as the
    // old sequential reads. Overshoot past the deadline is one batch.
    const READ_CONCURRENCY = 32;
    for (let start = 0; start < snapshots.length; start += READ_CONCURRENCY) {
      // Mid-path check: one file with hundreds of versions must not spend
      // minutes past the deadline; an abandoned path contributes nothing,
      // exactly like a path that never started.
      if (Date.now() > deadline) {
        abandoned = true;
        break;
      }
      const batch = snapshots
        .slice(start, start + READ_CONCURRENCY)
        .map((snapshot) => ({ snapshot, file: filesBySnapshot.get(snapshot.id)?.get(path) }));
      const texts = await Promise.all(
        batch.map(({ file }) => readVersionText(shadowDir, cache, file)),
      );
      batch.forEach(({ snapshot, file }, offset) => {
        versions.push({
          snapshotId: snapshot.id,
          commitOid: snapshot.commitOid,
          trigger: snapshot.trigger,
          eventId: snapshot.eventId,
          takenAt: snapshot.takenAt,
          text: texts[offset] ?? null,
          captured: file?.captured ?? false,
          reason: file?.reason ?? (file ? null : "absent"),
        });
      });
    }
    if (abandoned) {
      budgetExceeded = true;
      break;
    }
    const hunksByTransition: ParsedDiffHunk[][] = [];
    for (let index = 0; index < versions.length - 1; index += 1) {
      if (Date.now() > deadline) {
        abandoned = true;
        break;
      }
      const transitionHunks = transitionHunksByPath[index];
      if (transitionHunks && !failedTransitions.has(index)) {
        hunksByTransition.push(transitionHunks.get(path) ?? []);
        continue;
      }
      // This pair's whole-tree diff failed, so recover the path alone when
      // budget remains; otherwise the path degrades to uncertain.
      if (Date.now() > deadline) {
        diagnostics.push(pathDiagnostic(path));
        markPathUncertain(versions);
        hunksByTransition.push([]);
        continue;
      }
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
    if (abandoned) {
      budgetExceeded = true;
      break;
    }
    if (!finalDiffFailed) {
      for (const hunk of finalHunksByPath.get(path) ?? []) {
        hunks.push(hunkFromParsed(path, hunk));
      }
    } else if (Date.now() > deadline) {
      diagnostics.push(pathDiagnostic(path));
      markPathUncertain(versions);
    } else {
      try {
        const diff = diffShadowCommits(shadowDir, baseline.commitOid, final.commitOid, path);
        const parsed = parseUnifiedDiffs(diff);
        for (const hunk of parsed[0]?.hunks ?? []) {
          hunks.push(hunkFromParsed(path, hunk));
        }
      } catch (error) {
        diagnostics.push(pathDiagnostic(path));
        void error;
        markPathUncertain(versions);
      }
    }
    // Attempt/origin tracing is pure CPU over this path's own complete data.
    // A path this heavy already spent its git allowance above; if the clock
    // ran out, keep the hunks and skip only the tracing for this path.
    if (Date.now() > deadline) {
      budgetExceeded = true;
      continue;
    }
    const linksByTransition = versions.slice(1).map((version) => ({
      eventId: version.eventId,
      toolCallId: eventById.get(version.eventId ?? "")?.tool_call_id ?? null,
      toolOutcome: null,
      turnId: null,
      batchId: null,
    }));
    attemptsByPath.set(
      path,
      buildFileAttempts({
        path,
        versions,
        hunksByTransition,
        linksByTransition,
        finalText: versions[versions.length - 1]?.text ?? null,
      }),
    );
    originsByPath.set(
      path,
      buildFinalLineOrigins({
        versions,
        hunksByTransition,
        finalText: versions[versions.length - 1]?.text ?? "",
      }),
    );
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

  const attempts: FileAttempt[] = [];
  const evidenceByHunk: Record<string, HunkEvidence[]> = {};
  for (const path of changedPaths) {
    // Linking is pure CPU over one path's finished attribution; stop when
    // the budget is gone. Unlinked hunks keep no evidence entry, which
    // downstream reads as no evidence (uncertain), never as proof.
    if (Date.now() > deadline) {
      budgetExceeded = true;
      break;
    }
    const fileAttempts = attemptsByPath.get(path) ?? [];
    const origins = originsByPath.get(path) ?? [];
    // Related events mention paths by substring; matching once per path
    // instead of once per hunk is output-identical (linkHunkEvidence skips
    // non-mentioning events) and turns H×E string scans into P×E.
    const pathEvents = relatedEvents.filter((event) => pathMentions(event.text, path));
    attempts.push(...fileAttempts);
    for (const hunk of scoredHunks.filter((entry) => entry.path === path)) {
      evidenceByHunk[hunk.id] = linkHunkEvidence({
        hunk,
        origins,
        attempts: fileAttempts,
        relatedEvents: pathEvents,
      });
    }
  }

  if (budgetExceeded) diagnostics.push("review_budget_exceeded");

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
