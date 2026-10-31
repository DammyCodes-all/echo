import { createHash } from "node:crypto";

/**
 * Slice B deterministic chapter skeleton (ADR 0014). Every function here is
 * pure: no model calls, no I/O, no clocks. The model pass (Slice C) narrates
 * later; this file only groups diffs and fills ADR fields with extracted
 * text so regen and validation stay byte-deterministic.
 */

export const MAX_FILES_PER_GROUP = 4;
/**
 * Reader cap: no change carries more than ~10 files. A 52-file change
 * cannot be understood in a minute, so the trivial fold and the session
 * fold split wider sets by area instead of emitting one giant change.
 */
export const MAX_FILES_PER_CHANGE = 10;
export const DIGEST_MIN_TOKENS = 50;
export const DIGEST_MAX_TOKENS = 100;
export const DIGEST_TARGET_TOKENS = 75;

export const HEADS_UP_TYPES = ["not_asked", "watch_out", "unfinished"] as const;
export type HeadsUpType = (typeof HEADS_UP_TYPES)[number];

export interface DiffFile {
  path: string;
  diff: string;
}

export interface GroupDiffInput {
  files: DiffFile[];
  prompts: string[];
  /** Regen provenance forwarded onto every group; absent means snapshot_pair fallback at build time. */
  createdFrom?: CreatedFrom;
}

export type ChangeGroupKind = "change" | "small";

export interface ChangeGroup {
  kind: ChangeGroupKind;
  files: DiffFile[];
  /** Indices into the input prompts that mention one of the group's files. */
  promptRefs: number[];
  /** Provenance the skeleton copies into `createdFrom`; absent means snapshot_pair fallback. */
  createdFrom?: CreatedFrom;
  /**
   * Set by the session fold on its rollup chunks. The server gives each
   * rollup a stable per-session id (instead of a content hash) so regens
   * update rows in place instead of piling up new rollup rows per run.
   */
  rollup?: boolean;
  /** Chunk index within the session fold, set on rollup groups only. */
  rollupIndex?: number;
  /**
   * Snapshot span the group was grouped from, set by the server after the
   * per-pair grouping pass. The session rollup spans its folded members'
   * first-to-last pair; absent means the caller supplies the pair at build.
   */
  span?: SnapshotPair;
}

export interface SnapshotPair {
  prevOid: string;
  nextOid: string;
}

/**
 * Session budget: how many changes the reader shows for one session. Ten or
 * fewer stay whole; beyond that the budget grows with the square root and
 * tops out at twenty-four, so bigger sessions fold harder but never hit a
 * hard wall (24 -> 5, 100 -> 10, 576+ -> 24).
 */
export function sessionBudget(totalGroups: number): number {
  if (totalGroups <= 10) return totalGroups;
  return Math.min(24, Math.max(5, Math.round(Math.sqrt(totalGroups))));
}

function groupLineCount(group: ChangeGroup): number {
  let touched = 0;
  for (const file of group.files) {
    const parsed = parseUnifiedDiff(file.diff);
    touched += parsed.added.length + parsed.removed.length;
  }
  return touched;
}

/** Area of a path for the reader split: its top directory, or root. */
function areaOf(path: string): string {
  const head = path.split("/")[0] ?? "";
  return head === "" || !path.includes("/") ? "(root)" : head;
}

/**
 * Split files into area chunks of at most `maxPer` files. Areas sort by
 * name, paths sort within, and oversized areas chunk sequentially, so the
 * output is deterministic and every chunk stays readable in a minute.
 */
export function splitFilesByArea(
  files: DiffFile[],
  maxPer: number = MAX_FILES_PER_CHANGE,
): DiffFile[][] {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const areas = new Map<string, DiffFile[]>();
  for (const file of sorted) {
    const area = areaOf(file.path);
    const list = areas.get(area) ?? [];
    list.push(file);
    areas.set(area, list);
  }
  const chunks: DiffFile[][] = [];
  for (const area of [...areas.keys()].sort()) {
    const list = areas.get(area) ?? [];
    for (let i = 0; i < list.length; i += maxPer) {
      chunks.push(list.slice(i, i + maxPer));
    }
  }
  return chunks;
}

/**
 * Session-level fold. Per-pair grouping can still emit dozens of changes
 * for a long session; this merges down to the session budget, keeping the
 * most substantive groups and folding the rest into leading "small"
 * rollups, one area chunk each (at most MAX_FILES_PER_CHANGE files, so the
 * reader sees several small changes instead of one giant one).
 * Deterministic: rank is substantive-first, lines desc, path asc; each
 * rollup spans its own folded members' earliest-to-latest snapshot pair.
 * Returns the input untouched when it already fits the budget.
 */
export function mergeSessionGroups(groups: ChangeGroup[]): ChangeGroup[] {
  const budget = sessionBudget(groups.length);
  if (groups.length <= budget) return groups;
  const ranked = groups.map((group, index) => ({
    group,
    index,
    small: group.kind === "small" ? 1 : 0,
    lines: groupLineCount(group),
    head: group.files[0]?.path ?? "",
  }));
  ranked.sort((a, b) => a.small - b.small || b.lines - a.lines || (a.head < b.head ? -1 : 1));
  const kept = ranked.slice(0, Math.max(budget - 1, 1)).map((entry) => entry.group);
  const foldedRanked = ranked.slice(Math.max(budget - 1, 1));
  const folded = foldedRanked.map((entry) => entry.group);
  const seen = new Map<string, DiffFile>();
  for (const group of folded) {
    for (const file of group.files) {
      // Same path, later pair: concatenate, never drop. The rollup must
      // reflect every folded edit or later work silently vanishes from it.
      const prev = seen.get(file.path);
      seen.set(
        file.path,
        prev === undefined ? file : { path: file.path, diff: `${prev.diff}\n${file.diff}` },
      );
    }
  }
  // Chronological member order, for per-chunk spans and prompt refs.
  const ordered = [...foldedRanked].sort((a, b) => a.index - b.index).map((entry) => entry.group);
  const rollups = splitFilesByArea([...seen.values()]).map((chunk, rollupIndex) => {
    const paths = new Set(chunk.map((file) => file.path));
    const members = ordered.filter((group) => group.files.some((file) => paths.has(file.path)));
    const refs = members.flatMap((group) => group.promptRefs);
    const stamped = members
      .map((group) => group.span)
      .filter((span): span is SnapshotPair => span !== undefined);
    const rollup: ChangeGroup = {
      kind: "small",
      rollup: true,
      rollupIndex,
      files: chunk,
      promptRefs: [...new Set(refs)].sort((a, b) => a - b),
      ...(stamped.length > 0 &&
      stamped[0]?.prevOid !== undefined &&
      stamped[stamped.length - 1]?.nextOid !== undefined
        ? {
            span: {
              prevOid: (stamped[0] as SnapshotPair).prevOid,
              nextOid: (stamped[stamped.length - 1] as SnapshotPair).nextOid,
            },
          }
        : {}),
    };
    return rollup;
  });
  return [...rollups, ...kept];
}

export interface HeadsUp {
  type: HeadsUpType;
  text: string;
}

export interface ChangeFile {
  path: string;
  note: string;
}

export type CreatedFrom =
  | { kind: "tape_range"; startSeq: number; endSeq: number }
  | { kind: "snapshot_pair"; prevOid: string; nextOid: string };

export interface SkeletonChange {
  id: string;
  version: number;
  snapshotPair: SnapshotPair;
  title: string;
  summary: string;
  before: string[];
  now: string[];
  howItWorks: string[];
  headsUp: HeadsUp[];
  files: ChangeFile[];
  digest: string;
  createdFrom: CreatedFrom;
}

/** Whitespace token count shared by the builder and the validator. */
export function countTokens(text: string): number {
  return text.split(/\s+/).filter((token) => token.length > 0).length;
}

/**
 * Normalization for change ids. Sections are sorted by path, CRLF becomes
 * LF, trailing spaces/tabs are stripped per line, and the result ends with
 * exactly one newline. The hashed payload is
 * `normalizedDiff + "\n" + prevOid + "\n" + nextOid`.
 */
export function normalizeDiffForId(files: DiffFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const joined = sorted
    .map(({ path, diff }) => {
      const clean = diff
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/, ""))
        .join("\n");
      return `${path}\n${clean}`;
    })
    .join("\n");
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}

/** `c_` + 16 hex chars of sha256 over the normalized diff + snapshot pair. */
export function hashDiffId(normalizedDiff: string, prevOid: string, nextOid: string): string {
  const hex = createHash("sha256")
    .update(`${normalizedDiff}\n${prevOid}\n${nextOid}`)
    .digest("hex");
  return `c_${hex.slice(0, 16)}`;
}

/**
 * Stable rollup ids for a session, one per fold chunk. Content-hashed ids
 * would mint new rollup rows on every fold shift; these let regens update
 * the same rows. Index 0 keeps the original seed so existing rollup rows
 * (and their progress) survive the one-to-many split.
 */
export function rollupIdFor(sessionId: string, index = 0): string {
  const seed =
    index === 0 ? `echo-rollup-v1\n${sessionId}` : `echo-rollup-v1\n${sessionId}\n${index}`;
  const hex = createHash("sha256").update(seed).digest("hex");
  return `c_${hex.slice(0, 16)}`;
}

export interface ParsedDiff {
  added: string[];
  removed: string[];
  hunks: number;
}

/** Split a unified diff into content lines; headers and markers are skipped. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const added: string[] = [];
  const removed: string[] = [];
  let hunks = 0;
  for (const raw of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("@@")) {
      hunks += 1;
      continue;
    }
    if (raw === "\\ No newline at end of file") continue;
    if (raw.startsWith("+")) added.push(raw.slice(1));
    else if (raw.startsWith("-")) removed.push(raw.slice(1));
  }
  return { added, removed, hunks };
}

// Comment markers across the languages Echo captures. Heuristic on purpose:
// the small-changes fold only needs "obviously not logic", not a parser.
const COMMENT_PATTERNS = [
  /^\s*\/\//,
  /^\s*#/,
  /^\s*\/\*/,
  /^\s*\*/,
  /^\s*<!--/,
  /^\s*--/,
  /^\s*;;/,
  /^\s*%/,
];

const IMPORT_PATTERN =
  /^\s*(import\b|export\b|from\b[\s\S]*\bimport\b|require\s*\(|using\b|#include\b|include\b)/;

function multisetEquals(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const item of left) counts.set(item, (counts.get(item) ?? 0) + 1);
  for (const item of right) {
    const remaining = counts.get(item) ?? 0;
    if (remaining === 0) return false;
    counts.set(item, remaining - 1);
  }
  return true;
}

const squeeze = (line: string): string => line.replace(/\s+/g, "");

/**
 * True when a file's diff is typo-class: no content lines, a whitespace-only
 * or pure reorder (same lines modulo whitespace), only blank/comment lines,
 * only import/export lines, or a single-line touch. These fold into one
 * "small changes" group per ADR 0014 decision (b).
 */
export function isTrivialFile(diff: string): boolean {
  const { added, removed } = parseUnifiedDiff(diff);
  if (added.length === 0 && removed.length === 0) return true;
  if (multisetEquals(added.map(squeeze), removed.map(squeeze))) return true;
  const changed = [...added, ...removed];
  if (changed.every((line) => line.trim() === "" || COMMENT_PATTERNS.some((re) => re.test(line)))) {
    return true;
  }
  if (changed.every((line) => line.trim() === "" || IMPORT_PATTERN.test(line))) return true;
  if (added.length <= 1 && removed.length <= 1) return true;
  return false;
}

function promptRefsFor(files: DiffFile[], prompts: string[]): number[] {
  const refs: number[] = [];
  prompts.forEach((prompt, index) => {
    const lower = prompt.toLowerCase();
    const hit = files.some((file) => {
      const path = file.path.toLowerCase();
      const base = file.path.split("/").pop()?.toLowerCase() ?? "";
      return lower.includes(path) || (base.length > 0 && lower.includes(base));
    });
    if (hit) refs.push(index);
  });
  return refs;
}

/**
 * Deterministic skeleton grouping, no model. Files sort by path, trivial
 * files fold into leading "small" groups (one area chunk each, at most
 * MAX_FILES_PER_CHANGE files), and substantive files chunk into balanced
 * groups of at most MAX_FILES_PER_GROUP (5 files -> 3 + 2).
 * An empty file list yields no groups: no diff means no change.
 */
export function groupDiffIntoChanges(input: GroupDiffInput): ChangeGroup[] {
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const trivial = files.filter((file) => isTrivialFile(file.diff));
  const substantive = files.filter((file) => !isTrivialFile(file.diff));
  const groups: ChangeGroup[] = [];
  const provenance = input.createdFrom ? { createdFrom: input.createdFrom } : {};
  // Wide trivial folds split by area too: no change carries more than
  // MAX_FILES_PER_CHANGE files, whatever its kind.
  for (const chunk of splitFilesByArea(trivial)) {
    groups.push({
      kind: "small",
      files: chunk,
      promptRefs: promptRefsFor(chunk, input.prompts),
      ...provenance,
    });
  }
  const groupCount = Math.ceil(substantive.length / MAX_FILES_PER_GROUP);
  if (groupCount === 0) return groups;
  const perGroup = Math.ceil(substantive.length / groupCount);
  for (let i = 0; i < groupCount; i += 1) {
    const slice = substantive.slice(i * perGroup, (i + 1) * perGroup);
    groups.push({
      kind: "change",
      files: slice,
      promptRefs: promptRefsFor(slice, input.prompts),
      ...provenance,
    });
  }
  return groups;
}

function plural(count: number, singular: string, multiple: string): string {
  return count === 1 ? singular : multiple;
}

function titleFor(
  kind: ChangeGroupKind,
  files: DiffFile[],
  added: number,
  removed: number,
): string {
  const verb =
    kind === "small"
      ? "Fix"
      : added > 0 && removed === 0
        ? "Add"
        : removed > 0 && added === 0
          ? "Remove"
          : "Update";
  const first = files[0]?.path ?? "files";
  const base = first.split("/").pop() ?? first;
  const words = base
    .replace(/\.[^.]*$/, "")
    .split(/[-_.]+/)
    .filter((word) => word.length > 0);
  const multi = files.length > 1;
  const kept = words.slice(0, multi ? 5 : 7);
  if (kept.length === 0) kept.push("files");
  return multi ? `${verb} ${kept.join(" ")} and others` : `${verb} ${kept.join(" ")}`;
}

function summaryFor(
  kind: ChangeGroupKind,
  fileCount: number,
  added: number,
  removed: number,
): string {
  const fileWord = plural(fileCount, "file", "files");
  const addWord = plural(added, "addition", "additions");
  const remWord = plural(removed, "removal", "removals");
  const first =
    kind === "small"
      ? `This change fixes small text issues in ${fileCount} ${fileWord} with ${added} ${addWord} and ${removed} ${remWord} across this snapshot pair.`
      : `This change updates ${fileCount} ${fileWord} with ${added} ${addWord} and ${removed} ${remWord} across this snapshot pair.`;
  const second =
    "The affected lines previously held the earlier version of the code, and the updated version now takes their place in the same files.";
  const third =
    "Everything else in these files stays the same, so review can focus on the listed files and their new lines only.";
  return `${first} ${second} ${third}`;
}

/**
 * Fill every contract field from extracted text only. Title is verb +
 * first-file words (never paths, so prose holds no stray periods);
 * before/now render the +/- counts in plain words as single-entry arrays;
 * howItWorks is one step per file plus totals (empty for trivial groups);
 * headsUp stays empty with the UI rendering the "Nothing to flag." line;
 * files list one {path, note} each; digest is the first
 * DIGEST_TARGET_TOKENS whitespace tokens of summary + paths; snapshotPair
 * copies the pair; createdFrom prefers the group's provenance and falls back
 * to the snapshot pair.
 */
export function buildSkeletonChange(group: ChangeGroup, pair: SnapshotPair): SkeletonChange {
  const parsed = group.files.map((file) => parseUnifiedDiff(file.diff));
  const added = parsed.reduce((sum, part) => sum + part.added.length, 0);
  const removed = parsed.reduce((sum, part) => sum + part.removed.length, 0);
  const hunks = parsed.reduce((sum, part) => sum + part.hunks, 0);
  const touched = added + removed;
  const fileCount = group.files.length;
  const paths = group.files.map((file) => file.path).sort();
  const counts = new Map(group.files.map((file, index) => [file.path, parsed[index]] as const));

  const title = titleFor(group.kind, group.files, added, removed);
  const summary = summaryFor(group.kind, fileCount, added, removed);
  const fileWord = plural(fileCount, "file", "files");
  const lineWord = plural(touched, "line", "lines");
  const beforeText = `Before this change, the ${fileCount} ${fileWord} held the earlier form of all ${touched} touched ${lineWord}.`;
  const addWord = plural(added, "addition", "additions");
  const remWord = plural(removed, "removal", "removals");
  const nowText = `Now the same files carry the updated version with ${added} ${addWord} and ${removed} ${remWord} in place.`;

  const howItWorks: string[] =
    group.kind === "small"
      ? []
      : (() => {
          const steps = group.files.map((file, index) => {
            const part = parsed[index] ?? { added: [], removed: [] };
            const fileAdd = plural(part.added.length, "addition", "additions");
            const fileRem = plural(part.removed.length, "removal", "removals");
            return `Change ${file.path}: add ${part.added.length} ${fileAdd}, remove ${part.removed.length} ${fileRem}.`;
          });
          steps.push(
            `Touch ${touched} ${lineWord} in total across ${hunks} ${plural(hunks, "hunk", "hunks")}.`,
          );
          if (group.promptRefs.length > 0) {
            const promptWord = plural(group.promptRefs.length, "prompt", "prompts");
            steps.push(
              `Use the ${group.promptRefs.length} linked ${promptWord} from this moment as context.`,
            );
          }
          while (steps.length < 3)
            steps.push("Keep the surrounding code outside these lines as is.");
          return steps.slice(0, 5);
        })();

  const digest = `${summary} ${paths.join(" ")}`
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .slice(0, DIGEST_TARGET_TOKENS)
    .join(" ");

  const files: ChangeFile[] = paths.map((path) => {
    const part = counts.get(path) ?? { added: [], removed: [] };
    const fileAdd = plural(part.added.length, "addition", "additions");
    const fileRem = plural(part.removed.length, "removal", "removals");
    return {
      path,
      note: `Change ${path}: add ${part.added.length} ${fileAdd}, remove ${part.removed.length} ${fileRem}.`,
    };
  });

  return {
    id: hashDiffId(normalizeDiffForId(group.files), pair.prevOid, pair.nextOid),
    version: 1,
    snapshotPair: { prevOid: pair.prevOid, nextOid: pair.nextOid },
    title,
    summary,
    before: [beforeText],
    now: [nowText],
    howItWorks,
    headsUp: [],
    files,
    digest,
    createdFrom: group.createdFrom ?? {
      kind: "snapshot_pair",
      prevOid: pair.prevOid,
      nextOid: pair.nextOid,
    },
  };
}

const FILE_TOKEN = /^[\w./-]+\.[A-Za-z0-9]+$/;

/**
 * Session summary from digests only: counts come from the digest array and
 * every content word is either a digest token or fixed glue. Two sentences
 * for zero or one change, three once there is something to enumerate. File
 * paths never appear literally: their extensions would read as sentence
 * boundaries under a naive ./!/? split, so the summary cites file counts
 * and digest excerpts instead (digests carry the full paths).
 */
export function buildSessionSummaryFromDigests(digests: string[]): string {
  if (digests.length === 0) {
    return "This session contains no reviewed changes. There is nothing to summarize yet.";
  }
  const fileCount = new Set(
    digests
      .flatMap((digest) => digest.split(/\s+/))
      .map((token) => token.replace(/[,.:;]+$/, ""))
      .filter((token) => FILE_TOKEN.test(token)),
  ).size;
  const count = digests.length;
  const first = `This session contains ${count} reviewed ${plural(count, "change", "changes")}.`;
  const second =
    fileCount > 0
      ? `They span ${fileCount} ${plural(fileCount, "file", "files")} across the changes.`
      : "They span the files recorded in the changes.";
  if (count === 1) return `${first} ${second}`;
  // Cap the enumeration: with twenty changes the full list is a wall, not
  // a summary. The overflow count is derived, never invented.
  const MAX_EXCERPTS = 5;
  const excerpts = digests
    .slice(0, MAX_EXCERPTS)
    .map((digest) =>
      digest
        .split(/\s+/)
        .filter((token) => token.length > 0)
        .slice(0, 8)
        .join(" "),
    )
    .join(" / ");
  const tail = count > MAX_EXCERPTS ? `${excerpts}; and ${count - MAX_EXCERPTS} more` : excerpts;
  return `${first} ${second} In short, ${tail}.`;
}

/**
 * Regen dedupe helper. Version rule: a regen computes a fresh id per
 * snapshot-pair span; any id missing from storage means that span hashed
 * differently, so the pipeline stores a NEW row with
 * version = previous max + 1 and keeps the old row. Progress keys on
 * (id, version) and is never reset by regen. Extra stored ids are kept
 * history, not staleness, so only unknown current ids report stale.
 */
export function isStaleByHash(storedIds: string[], currentIds: string[]): boolean {
  const stored = new Set(storedIds);
  return currentIds.some((id) => !stored.has(id));
}
