import { createHash } from "node:crypto";
import { stableJson } from "@echo/core";

export type AttemptStatus =
  | "landed"
  | "partially_landed"
  | "reverted"
  | "replaced"
  | "failed"
  | "failed_with_side_effect"
  | "uncertain"
  | "baseline";

export type AttemptConfidence = "exact" | "likely" | "uncertain";

export type HunkEvidenceRelation =
  | "introduced_by"
  | "touched_by"
  | "reverted_attempt"
  | "related_event"
  | "baseline";

export type HunkEvidenceConfidence = "exact" | "likely" | "uncertain";

export interface ParsedDiffLine {
  kind: "context" | "deletion" | "addition";
  text: string;
}

export interface ParsedDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ParsedDiffLine[];
}

export interface ParsedFileDiff {
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  hunks: ParsedDiffHunk[];
}

export interface ReviewHunk {
  id: string;
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  patch: string;
  addedText: string;
  removedText: string;
  addedLines: number;
  removedLines: number;
}

export interface FileVersion {
  snapshotId: string;
  commitOid: string;
  trigger: string;
  eventId: string | null;
  takenAt: string;
  text: string | null;
  captured: boolean;
  reason: string | null;
}

export interface AttemptLink {
  eventId: string | null;
  toolCallId: string | null;
  toolOutcome: "completed" | "failed" | "requested" | null;
  turnId: string | null;
  batchId: string | null;
}

export interface FileAttempt {
  id: string;
  path: string;
  snapshotId: string;
  commitOid: string;
  trigger: string;
  eventId: string | null;
  takenAt: string;
  status: AttemptStatus;
  confidence: AttemptConfidence;
  introducedLines: number;
  survivingLines: number;
  introducedText: string[];
  replacementText: string[];
  /** 1-based final-file range the attempt occupied; null when not applicable. */
  finalStart: number | null;
  /** Inclusive end; empty removals use finalStart - 1. */
  finalEnd: number | null;
  detail: string;
  link: AttemptLink;
}

export interface FinalLineOrigin {
  line: number;
  text: string;
  snapshotId: string | null;
  eventId: string | null;
  baseline: boolean;
  uncertain: boolean;
}

export interface RelatedEvent {
  eventId: string;
  kind: string;
  toolCallId: string | null;
  turnId: string | null;
  batchId: string | null;
  text: string | null;
}

export interface HunkEvidence {
  relation: HunkEvidenceRelation;
  confidence: HunkEvidenceConfidence;
  snapshotId: string | null;
  eventId: string | null;
  toolCallId: string | null;
  detail: string;
}

function parseHunkHeader(line: string): Omit<ParsedDiffHunk, "lines"> {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match?.[1] || !match[3]) throw new Error(`invalid unified hunk header: ${line}`);
  return {
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? "1"),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? "1"),
  };
}

function unquotePath(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return value;
}

function diffPath(value: string): string | null {
  if (value === "/dev/null") return null;
  const unquoted = unquotePath(value);
  return unquoted.replace(/^[ab]\//, "");
}

function finishFile(files: ParsedFileDiff[], file: ParsedFileDiff | null): void {
  if (file) files.push(file);
}

/**
 * Parse Git unified diffs without shelling out. The caller supplies diff text
 * produced from shadow commits; malformed hunk structure is an error because
 * silent misalignment would invent file history.
 */
export function parseUnifiedDiffs(diffText: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  let file: ParsedFileDiff | null = null;
  const parserState: { hunk: ParsedDiffHunk | null } = { hunk: null };
  let pendingNoNewline = false;

  const startHunk = (header: string): void => {
    if (!file) throw new Error("unified hunk outside a file diff");
    if (file.binary) throw new Error("unified hunk in a binary diff");
    parserState.hunk = { ...parseHunkHeader(header), lines: [] };
    file.hunks.push(parserState.hunk);
  };

  for (const rawLine of diffText.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("diff --git ")) {
      finishFile(files, file);
      file = { oldPath: null, newPath: null, binary: false, hunks: [] };
      parserState.hunk = null;
      continue;
    }
    if (!file) {
      if (line.trim().length === 0) continue;
      throw new Error(`unified diff line outside a file diff: ${line}`);
    }
    if (line.startsWith("Binary files ")) {
      file.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      file.oldPath = diffPath(line.slice(4).split("\t")[0] ?? "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      file.newPath = diffPath(line.slice(4).split("\t")[0] ?? "");
      continue;
    }
    if (line.startsWith("@@ ")) {
      startHunk(line);
      continue;
    }
    if (line.startsWith("\\ ")) {
      pendingNoNewline = true;
      continue;
    }
    if (
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("new file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename ") ||
      line.startsWith("index ")
    ) {
      continue;
    }
    const activeHunk = parserState.hunk;
    if (!activeHunk) continue;
    if (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+")) {
      activeHunk.lines.push({
        kind: line.startsWith(" ") ? "context" : line.startsWith("-") ? "deletion" : "addition",
        text: line.slice(1),
      });
      void pendingNoNewline;
      pendingNoNewline = false;
      continue;
    }
    if (line.trim().length === 0) continue;
    throw new Error(`invalid unified diff body line: ${line}`);
  }
  finishFile(files, file);

  for (const entry of files) {
    for (const entryHunk of entry.hunks) {
      let oldCount = 0;
      let newCount = 0;
      for (const entryLine of entryHunk.lines) {
        if (entryLine.kind !== "addition") oldCount += 1;
        if (entryLine.kind !== "deletion") newCount += 1;
      }
      if (oldCount !== entryHunk.oldLines || newCount !== entryHunk.newLines) {
        throw new Error(
          `unified hunk body has ${oldCount}/${newCount} lines, header says ${entryHunk.oldLines}/${entryHunk.newLines}`,
        );
      }
    }
  }
  return files;
}

function normalizePatchLine(line: ParsedDiffLine): string {
  const prefix = line.kind === "context" ? " " : line.kind === "deletion" ? "-" : "+";
  return `${prefix}${line.text.replace(/\s+$/, "")}`;
}

export function normalizePatch(hunk: ParsedDiffHunk): string {
  return hunk.lines.map(normalizePatchLine).join("\n");
}

/**
 * Stable hunk identity from ARCHITECTURE §12: path plus positions plus a
 * whitespace-normalized patch. The same logical hunk re-indexes to the same
 * id; unrelated movement still changes the id.
 */
export function hunkIdFor(path: string, hunk: ParsedDiffHunk): string {
  return `h_${createHash("sha256")
    .update(
      stableJson({
        path,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        patch: normalizePatch(hunk),
      }),
    )
    .digest("hex")
    .slice(0, 16)}`;
}

function mapOldToNew(hunk: ParsedDiffHunk, line: number): number | null {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const entry of hunk.lines) {
    if (entry.kind === "context") {
      if (line === oldLine) return newLine;
      oldLine += 1;
      newLine += 1;
    } else if (entry.kind === "deletion") {
      if (line === oldLine) return null;
      oldLine += 1;
    } else {
      newLine += 1;
    }
  }
  return line;
}

function mapNewToOld(hunk: ParsedDiffHunk, line: number): number | null {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const entry of hunk.lines) {
    if (entry.kind === "context") {
      if (line === newLine) return oldLine;
      oldLine += 1;
      newLine += 1;
    } else if (entry.kind === "deletion") {
      oldLine += 1;
    } else {
      if (line === newLine) return null;
      newLine += 1;
    }
  }
  return line;
}

export function mapLineForward(hunks: ParsedDiffHunk[], line: number | null): number | null {
  let current = line;
  for (const hunk of hunks) {
    if (current === null) return null;
    current = mapOldToNew(hunk, current);
  }
  return current;
}

export function mapLineBackward(hunks: ParsedDiffHunk[], line: number | null): number | null {
  let current = line;
  for (let index = hunks.length - 1; index >= 0; index -= 1) {
    if (current === null) return null;
    const hunk = hunks[index];
    if (!hunk) return null;
    current = mapNewToOld(hunk, current);
  }
  return current;
}

function effectiveVersionText(version: FileVersion): string | null {
  if (version.text !== null) return version.text;
  // A file absent from a snapshot manifest did not exist there; ignored and
  // binary entries stay null so they remain uncertain rather than empty.
  return version.reason === "absent" ? "" : null;
}

function splitText(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  // A trailing newline terminates the final line; it is not another line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface AddedRun {
  texts: string[];
  newStart: number;
  parentBefore: number | null;
  parentAfter: number | null;
  parentAfterIsEof: boolean;
}

function addedRuns(hunk: ParsedDiffHunk): AddedRun[] {
  const runs: AddedRun[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let current: AddedRun | null = null;

  const close = (): void => {
    if (current) {
      const hasSuccessor = oldLine <= hunk.oldStart + hunk.oldLines - 1;
      current.parentAfter = hasSuccessor ? oldLine : null;
      current.parentAfterIsEof = !hasSuccessor;
      runs.push(current);
      current = null;
    }
  };

  for (const entry of hunk.lines) {
    if (entry.kind === "addition") {
      if (!current) {
        current = {
          texts: [],
          newStart: newLine,
          parentBefore: oldLine - 1 >= hunk.oldStart ? oldLine - 1 : null,
          parentAfter: null,
          parentAfterIsEof: false,
        };
      }
      current.texts.push(entry.text);
      newLine += 1;
    } else {
      close();
      if (entry.kind === "context") {
        oldLine += 1;
        newLine += 1;
      } else {
        oldLine += 1;
      }
    }
  }
  close();
  return runs;
}

function attemptId(input: {
  path: string;
  snapshotId: string;
  eventId: string | null;
  ranges: string;
}): string {
  return `att_${createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 16)}`;
}

function transitionChanged(parent: FileVersion, child: FileVersion): boolean {
  return effectiveVersionText(parent) !== effectiveVersionText(child);
}

/**
 * Classify one file's snapshot transitions. Line survival is positional
 * through parsed diffs, not textual search: a repeated line elsewhere in the
 * file cannot rescue a deleted attempt. Missing or uncaptured versions yield
 * uncertain rather than a fabricated dead end.
 */
export function buildFileAttempts(input: {
  path: string;
  versions: FileVersion[];
  hunksByTransition: ParsedDiffHunk[][];
  linksByTransition: AttemptLink[];
  finalText: string | null;
}): FileAttempt[] {
  const { path, versions, hunksByTransition, linksByTransition, finalText } = input;
  if (versions.length === 0) return [];
  if (hunksByTransition.length !== Math.max(0, versions.length - 1)) {
    throw new Error("attempt classification needs one diff per snapshot transition");
  }
  if (linksByTransition.length !== hunksByTransition.length) {
    throw new Error("attempt classification needs one link per snapshot transition");
  }

  const attempts: FileAttempt[] = [];
  const first = versions[0];
  if (first) {
    attempts.push({
      id: attemptId({
        path,
        snapshotId: first.snapshotId,
        eventId: first.eventId,
        ranges: "baseline",
      }),
      path,
      snapshotId: first.snapshotId,
      commitOid: first.commitOid,
      trigger: first.trigger,
      eventId: first.eventId,
      takenAt: first.takenAt,
      status: "baseline",
      confidence: "exact",
      introducedLines: 0,
      survivingLines: 0,
      introducedText: [],
      replacementText: [],
      finalStart: null,
      finalEnd: null,
      detail: "lines present before the session",
      link: { eventId: null, toolCallId: null, toolOutcome: null, turnId: null, batchId: null },
    });
  }

  const lastVersion = versions[versions.length - 1];
  const effectiveFinalText = finalText ?? (lastVersion ? effectiveVersionText(lastVersion) : null);
  const finalLines = effectiveFinalText === null ? null : splitText(effectiveFinalText);
  for (let transition = 0; transition < hunksByTransition.length; transition += 1) {
    const parent = versions[transition];
    const child = versions[transition + 1];
    const hunks = hunksByTransition[transition] ?? [];
    const link = linksByTransition[transition];
    if (!parent || !child || !link) continue;
    const parentText = effectiveVersionText(parent);
    const childText = effectiveVersionText(child);
    if (parentText === null || childText === null) {
      attempts.push({
        id: attemptId({
          path,
          snapshotId: child.snapshotId,
          eventId: child.eventId,
          ranges: "uncaptured",
        }),
        path,
        snapshotId: child.snapshotId,
        commitOid: child.commitOid,
        trigger: child.trigger,
        eventId: child.eventId,
        takenAt: child.takenAt,
        status: "uncertain",
        confidence: "uncertain",
        introducedLines: 0,
        survivingLines: 0,
        introducedText: [],
        replacementText: [],
        finalStart: null,
        finalEnd: null,
        detail: "an uncaptured version prevents attempt classification",
        link,
      });
      continue;
    }

    const runs = hunks.flatMap(addedRuns);
    const introduced = runs.reduce((total, run) => total + run.texts.length, 0);
    if (introduced === 0) continue;
    const laterHunks = hunksByTransition.slice(transition + 1).flat();
    let surviving = 0;
    for (const run of runs) {
      for (let offset = 0; offset < run.texts.length; offset += 1) {
        const mapped = mapLineForward(laterHunks, run.newStart + offset);
        if (mapped !== null) surviving += 1;
      }
    }

    if (link.toolOutcome === "failed") {
      const changed = transitionChanged(parent, child);
      attempts.push({
        id: attemptId({
          path,
          snapshotId: child.snapshotId,
          eventId: child.eventId,
          ranges: `failed:${introduced}`,
        }),
        path,
        snapshotId: child.snapshotId,
        commitOid: child.commitOid,
        trigger: child.trigger,
        eventId: child.eventId,
        takenAt: child.takenAt,
        status: changed ? "failed_with_side_effect" : "failed",
        confidence: "exact",
        introducedLines: introduced,
        survivingLines: surviving,
        introducedText: runs.flatMap((run) => run.texts),
        replacementText: [],
        finalStart: null,
        finalEnd: null,
        detail: changed
          ? "the linked tool failed but the file changed"
          : "the linked tool failed and the file did not change",
        link,
      });
      continue;
    }

    if (finalLines === null) {
      attempts.push({
        id: attemptId({
          path,
          snapshotId: child.snapshotId,
          eventId: child.eventId,
          ranges: "unmapped-final",
        }),
        path,
        snapshotId: child.snapshotId,
        commitOid: child.commitOid,
        trigger: child.trigger,
        eventId: child.eventId,
        takenAt: child.takenAt,
        status: "uncertain",
        confidence: "uncertain",
        introducedLines: introduced,
        survivingLines: 0,
        introducedText: runs.flatMap((run) => run.texts),
        replacementText: [],
        finalStart: null,
        finalEnd: null,
        detail: "the final file state is uncaptured",
        link,
      });
      continue;
    }

    if (surviving === introduced) {
      attempts.push({
        id: attemptId({
          path,
          snapshotId: child.snapshotId,
          eventId: child.eventId,
          ranges: `landed:${introduced}`,
        }),
        path,
        snapshotId: child.snapshotId,
        commitOid: child.commitOid,
        trigger: child.trigger,
        eventId: child.eventId,
        takenAt: child.takenAt,
        status: "landed",
        confidence: "exact",
        introducedLines: introduced,
        survivingLines: surviving,
        introducedText: runs.flatMap((run) => run.texts),
        replacementText: [],
        finalStart: null,
        finalEnd: null,
        detail: "all introduced lines survive in the final file",
        link,
      });
      continue;
    }
    if (surviving > 0) {
      attempts.push({
        id: attemptId({
          path,
          snapshotId: child.snapshotId,
          eventId: child.eventId,
          ranges: `partial:${surviving}/${introduced}`,
        }),
        path,
        snapshotId: child.snapshotId,
        commitOid: child.commitOid,
        trigger: child.trigger,
        eventId: child.eventId,
        takenAt: child.takenAt,
        status: "partially_landed",
        confidence: "exact",
        introducedLines: introduced,
        survivingLines: surviving,
        introducedText: runs.flatMap((run) => run.texts),
        replacementText: [],
        finalStart: null,
        finalEnd: null,
        detail: "some introduced lines survive in the final file",
        link,
      });
      continue;
    }

    // The whole file is gone in the final snapshot: every introduced line
    // was deleted with it. Anchors cannot survive, so this case is exact
    // by construction rather than by line mapping.
    if (effectiveFinalText === "" && lastVersion?.reason === "absent") {
      attempts.push({
        id: attemptId({
          path,
          snapshotId: child.snapshotId,
          eventId: child.eventId,
          ranges: "file-deleted",
        }),
        path,
        snapshotId: child.snapshotId,
        commitOid: child.commitOid,
        trigger: child.trigger,
        eventId: child.eventId,
        takenAt: child.takenAt,
        status: "reverted",
        confidence: "exact",
        introducedLines: introduced,
        survivingLines: 0,
        introducedText: runs.flatMap((run) => run.texts),
        replacementText: [],
        finalStart: null,
        finalEnd: null,
        detail: "the file was deleted, removing the introduced lines",
        link,
      });
      continue;
    }

    let removedRuns = 0;
    let replacedRuns = 0;
    const replacementText: string[] = [];
    const gapRanges: Array<{ start: number; end: number }> = [];
    let uncertainRun = false;
    for (const run of runs) {
      const before =
        run.parentBefore === null
          ? 0
          : mapLineForward(hunksByTransition.slice(transition).flat(), run.parentBefore);
      const after = run.parentAfterIsEof
        ? finalLines.length + 1
        : run.parentAfter === null
          ? null
          : mapLineForward(hunksByTransition.slice(transition).flat(), run.parentAfter);
      if (before === null || after === null || after < before) {
        uncertainRun = true;
        break;
      }
      const gap = finalLines.slice(before, after - 1);
      gapRanges.push({ start: before + 1, end: after - 1 });
      if (gap.length === 0) removedRuns += 1;
      else {
        replacedRuns += 1;
        replacementText.push(...gap);
      }
    }

    if (uncertainRun || (removedRuns > 0 && replacedRuns > 0)) {
      attempts.push({
        id: attemptId({
          path,
          snapshotId: child.snapshotId,
          eventId: child.eventId,
          ranges: "ambiguous-removal",
        }),
        path,
        snapshotId: child.snapshotId,
        commitOid: child.commitOid,
        trigger: child.trigger,
        eventId: child.eventId,
        takenAt: child.takenAt,
        status: "uncertain",
        confidence: "uncertain",
        introducedLines: introduced,
        survivingLines: 0,
        introducedText: runs.flatMap((run) => run.texts),
        replacementText,
        finalStart: null,
        finalEnd: null,
        detail: "the introduced lines are gone but replacement cannot be isolated",
        link,
      });
      continue;
    }
    const finalStart = gapRanges.length > 0 ? Math.min(...gapRanges.map((gap) => gap.start)) : null;
    const finalEnd = gapRanges.length > 0 ? Math.max(...gapRanges.map((gap) => gap.end)) : null;
    attempts.push({
      id: attemptId({
        path,
        snapshotId: child.snapshotId,
        eventId: child.eventId,
        ranges: replacedRuns > 0 ? "replaced" : "reverted",
      }),
      path,
      snapshotId: child.snapshotId,
      commitOid: child.commitOid,
      trigger: child.trigger,
      eventId: child.eventId,
      takenAt: child.takenAt,
      status: replacedRuns > 0 ? "replaced" : "reverted",
      confidence: "exact",
      introducedLines: introduced,
      survivingLines: 0,
      introducedText: runs.flatMap((run) => run.texts),
      replacementText,
      finalStart,
      finalEnd,
      detail:
        replacedRuns > 0
          ? "different lines occupy the anchored location in the final file"
          : "the introduced lines were deleted without replacement",
      link,
    });
  }
  return attempts;
}

/**
 * Trace every final line back to the snapshot that introduced it. Walking
 * backward through parsed diffs keeps duplicated lines distinct: only the
 * line at the mapped position can claim the origin.
 */
export function buildFinalLineOrigins(input: {
  versions: FileVersion[];
  hunksByTransition: ParsedDiffHunk[][];
  finalText: string;
}): FinalLineOrigin[] {
  const { versions, hunksByTransition, finalText } = input;
  if (versions.length === 0) return [];
  if (hunksByTransition.length !== Math.max(0, versions.length - 1)) {
    throw new Error("line origins need one diff per snapshot transition");
  }
  if (versions.some((version) => effectiveVersionText(version) === null)) {
    return splitText(finalText).map((text, index) => ({
      line: index + 1,
      text,
      snapshotId: null,
      eventId: null,
      baseline: false,
      uncertain: true,
    }));
  }

  return splitText(finalText).map((text, index) => {
    let current: number | null = index + 1;
    let origin = 0;
    for (let transition = hunksByTransition.length - 1; transition >= 0; transition -= 1) {
      const hunks = hunksByTransition[transition] ?? [];
      const mapped = mapLineBackward(hunks, current);
      if (mapped === null) {
        origin = transition + 1;
        break;
      }
      current = mapped;
    }
    const version = versions[origin];
    return {
      line: index + 1,
      text,
      snapshotId: version?.snapshotId ?? null,
      eventId: version?.eventId ?? null,
      baseline: origin === 0,
      uncertain: false,
    };
  });
}

function pathMentions(text: string | null, path: string): boolean {
  if (!text) return false;
  return text.includes(path) || text.includes(path.split("/").slice(-1)[0] ?? "");
}

function attemptOverlapsHunk(attempt: FileAttempt, hunk: ReviewHunk): boolean {
  if (attempt.finalStart === null || attempt.finalEnd === null) return false;
  const hunkStart = hunk.newStart;
  const hunkEnd = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
  if (attempt.finalEnd >= attempt.finalStart) {
    return attempt.finalStart <= hunkEnd && attempt.finalEnd >= hunkStart;
  }
  // Empty removals sit between final lines; match a hunk covering either side.
  return attempt.finalStart >= hunkStart && attempt.finalStart <= hunkEnd + 1;
}

export function hunkFromParsed(path: string, hunk: ParsedDiffHunk): ReviewHunk {
  const added = hunk.lines.filter((line) => line.kind === "addition").map((line) => line.text);
  const removed = hunk.lines.filter((line) => line.kind === "deletion").map((line) => line.text);
  return {
    id: hunkIdFor(path, hunk),
    path,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    patch: normalizePatch(hunk),
    addedText: added.join("\n"),
    removedText: removed.join("\n"),
    addedLines: added.length,
    removedLines: removed.length,
  };
}

/**
 * Link a final-diff hunk to evidence without inventing intent. Introduced and
 * baseline relations come from positional line origins; reverted attempts come
 * from anchored removals; everything else is a related event at best.
 */
export function linkHunkEvidence(input: {
  hunk: ReviewHunk;
  origins: FinalLineOrigin[];
  attempts: FileAttempt[];
  relatedEvents: RelatedEvent[];
}): HunkEvidence[] {
  const { hunk, origins, attempts, relatedEvents } = input;
  const evidence: HunkEvidence[] = [];
  const inHunk = origins.filter(
    (origin) => origin.line >= hunk.newStart && origin.line < hunk.newStart + hunk.newLines,
  );

  const uncertainLine = inHunk.some((origin) => origin.uncertain);
  const baselineLines = inHunk.filter((origin) => origin.baseline && !origin.uncertain);
  if (baselineLines.length > 0) {
    evidence.push({
      relation: "baseline",
      confidence: "exact",
      snapshotId: null,
      eventId: null,
      toolCallId: null,
      detail: `${baselineLines.length} hunk line(s) predate the session`,
    });
  }

  const introduced = new Map<string, { count: number; eventId: string | null }>();
  for (const origin of inHunk) {
    if (origin.baseline || origin.uncertain || !origin.snapshotId) continue;
    const entry = introduced.get(origin.snapshotId) ?? { count: 0, eventId: origin.eventId };
    entry.count += 1;
    introduced.set(origin.snapshotId, entry);
  }
  for (const [snapshotId, entry] of introduced) {
    evidence.push({
      relation: "introduced_by",
      confidence: "exact",
      snapshotId,
      eventId: entry.eventId,
      toolCallId: null,
      detail: `${entry.count} hunk line(s) introduced by this snapshot`,
    });
  }

  for (const attempt of attempts) {
    if (attempt.path !== hunk.path) continue;
    if (attempt.status !== "reverted" && attempt.status !== "replaced") continue;
    const hasRange = attempt.finalStart !== null && attempt.finalEnd !== null;
    if (hasRange) {
      if (!attemptOverlapsHunk(attempt, hunk)) continue;
    } else if (hunk.removedLines === 0) {
      // No surviving final position (e.g. the file was deleted): only a
      // hunk that itself removes lines can plausibly explain the attempt.
      continue;
    }
    evidence.push({
      relation: "reverted_attempt",
      confidence: hasRange ? attempt.confidence : "likely",
      snapshotId: attempt.snapshotId,
      eventId: attempt.eventId,
      toolCallId: attempt.link.toolCallId,
      detail:
        attempt.status === "replaced"
          ? "an earlier attempt in this region was replaced"
          : hasRange
            ? "an earlier attempt in this region was reverted"
            : "an earlier attempt in this file was reverted",
    });
  }

  for (const event of relatedEvents) {
    if (!pathMentions(event.text, hunk.path)) continue;
    evidence.push({
      relation: "related_event",
      confidence: "likely",
      snapshotId: null,
      eventId: event.eventId,
      toolCallId: event.toolCallId,
      detail: `${event.kind} mentions this path`,
    });
  }

  if (uncertainLine || inHunk.length === 0) {
    evidence.push({
      relation: "related_event",
      confidence: "uncertain",
      snapshotId: null,
      eventId: null,
      toolCallId: null,
      detail: "line provenance is incomplete for this hunk",
    });
  }
  return evidence;
}
