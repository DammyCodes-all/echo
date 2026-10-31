import { type ChangeGroup, HEADS_UP_TYPES, type HeadsUpType, type SnapshotPair } from "./changes";

/**
 * Model narration prompt for Changes (ADR 0014 §c). Pure rendering: one
 * change group plus its moment prompts/reasoning plus earlier digests in,
 * messages out. The server re-redacts the rendered prompt before sending,
 * stamps server-owned id/version/provenance onto the draft, and validates
 * with validateSkeletonChange (one retry with error text, then skeleton).
 */

export const CHANGE_NARRATION_PROMPT_VERSION = "changes-v2";

/** Artifact generator when at least one fresh change came from the model. */
export const CHANGE_MODEL_GENERATOR = "model-changes-v1";

/** Per-field render caps. Truncation is marked so silence never poses as
 *  absence; the validator still checks the draft against the full diff, so
 *  a capped field can only fail validation, never pass it. */
export const MAX_DIFF_CHARS_PER_FILE = 6000;
export const MAX_PROMPT_CHARS_PER_ITEM = 2000;
export const MAX_DIGEST_CHARS_PER_ITEM = 1200;

/** Per-group item caps. Kept heads survive; the marker names the count. */
export const MAX_MOMENT_PROMPTS = 10;
export const MAX_EARLIER_DIGESTS = 5;

/** Whole-prompt cap. Past it, digest blocks go first, then prompt blocks,
 *  always from the tail; diffs are never dropped, only hard-cut with a
 *  marker when they alone exceed the cap. */
export const MAX_CHANGE_PROMPT_CHARS = 30_000;

export interface ChangeNarrationInput {
  group: ChangeGroup;
  /** Moment prompts/reasoning texts for this group, in tape order. */
  prompts: string[];
  /** Earlier digests only, oldest first. Never the current group's digest. */
  digests: string[];
  pair: SnapshotPair;
}

export interface NarrationMessages {
  system: string;
  user: string;
  /** True when any per-field or whole-prompt cap dropped content. */
  truncated: boolean;
}

function cap(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  return { text: `${text.slice(0, limit)}…(+${text.length - limit} chars)`, cut: true };
}

const SYSTEM_PROMPT = [
  "You narrate one Echo code change as plain-English reader copy. Reply with JSON only, no prose.",
  "Use ONLY the diff, the moment prompts/reasoning, and the earlier digests below.",
  "Never invent file names, paths, numbers, or behavior: every path you mention",
  "must appear in the Files list exactly as written.",
  "Write for someone who has never seen this codebase: plain words, no",
  "internal names unless you explain them in the same sentence. Steps",
  "describe behavior and outcomes, never function or hook swaps.",
  "Caps (the server rejects anything outside them, then retries once):",
  "- title: 1-8 words.",
  "- summary: 2-3 sentences.",
  "- before: 1-2 non-empty strings.",
  "- now: 1-2 non-empty strings.",
  "- howItWorks: 3-5 non-empty steps, or [] when the group is marked trivial.",
  "- headsUp: 0-3 items, each {type, text} with type one of",
  "  not_asked | watch_out | unfinished; [] when nothing needs flagging.",
  "- files: one {path, note} per input file, every file exactly once,",
  "  path copied exactly, note one plain line.",
  "- digest: 50-100 whitespace-separated tokens.",
  'Shape: {"title", "summary", "before", "now", "howItWorks", "headsUp", "files", "digest"}.',
  "Do not include id, version, snapshotPair, or createdFrom: the server stamps them.",
].join("\n");

function renderUser(
  head: string,
  diffSections: string[],
  promptBlocks: string[],
  digestBlocks: string[],
  promptCapNote: string,
  digestCapNote: string,
): string {
  const prompts =
    promptBlocks.length > 0 ? promptBlocks.join("\n") : "(no linked prompts this moment)";
  const digests = digestBlocks.length > 0 ? digestBlocks.join("\n") : "(no earlier digests yet)";
  return [
    head,
    "",
    "Diffs:",
    ...diffSections,
    "",
    "Moment prompts and reasoning:",
    prompts,
    promptCapNote,
    "",
    "Earlier digests (context only, do not copy text):",
    digests,
    digestCapNote,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildChangeNarrationMessages(input: ChangeNarrationInput): NarrationMessages {
  const files = [...input.group.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const fileList = files.map((file) => `- ${file.path}`).join("\n");
  // Per-field cuts mark the truncated flag: capped content never poses as whole.
  let fieldTruncated = false;
  const cut = (text: string, limit: number): string => {
    const capped = cap(text, limit);
    fieldTruncated = fieldTruncated || capped.cut;
    return capped.text;
  };
  const diffSections = files.map(
    (file) => `=== ${file.path} ===\n${cut(file.diff, MAX_DIFF_CHARS_PER_FILE)}`,
  );
  const head = [
    `prompt_version: ${CHANGE_NARRATION_PROMPT_VERSION}`,
    `snapshot: ${input.pair.prevOid}..${input.pair.nextOid}`,
    `group: ${input.group.kind} (${files.length} ${files.length === 1 ? "file" : "files"})`,
    input.group.kind === "small"
      ? "This group is trivial-class (typo, rename, or comment-only): set howItWorks to []."
      : "This group is substantive: set howItWorks to 3-5 steps.",
    "",
    "Files (use exactly these paths, one entry each — never invent file names):",
    fileList,
  ].join("\n");

  const promptOverflow = input.prompts.length - MAX_MOMENT_PROMPTS;
  const keptPrompts = input.prompts.slice(0, MAX_MOMENT_PROMPTS);
  const promptCapNote =
    promptOverflow > 0 ? `…(${promptOverflow} more prompts omitted over the per-group cap)` : "";
  const digestOverflow = input.digests.length - MAX_EARLIER_DIGESTS;
  const keptDigests = input.digests.slice(0, MAX_EARLIER_DIGESTS);
  const digestCapNote =
    digestOverflow > 0 ? `…(${digestOverflow} more digests omitted over the per-group cap)` : "";
  let promptBlocks = keptPrompts.map(
    (prompt, index) => `[${index + 1}] ${cut(prompt, MAX_PROMPT_CHARS_PER_ITEM)}`,
  );
  let digestBlocks = keptDigests.map(
    (digest, index) => `[${index + 1}] ${cut(digest, MAX_DIGEST_CHARS_PER_ITEM)}`,
  );

  let omittedPrompts = 0;
  let omittedDigests = 0;
  let user = renderUser(
    head,
    diffSections,
    promptBlocks,
    digestBlocks,
    promptCapNote,
    digestCapNote,
  );
  while (user.length > MAX_CHANGE_PROMPT_CHARS && digestBlocks.length > 0) {
    digestBlocks = digestBlocks.slice(0, -1);
    omittedDigests += 1;
    user = renderUser(head, diffSections, promptBlocks, digestBlocks, promptCapNote, digestCapNote);
  }
  while (user.length > MAX_CHANGE_PROMPT_CHARS && promptBlocks.length > 0) {
    promptBlocks = promptBlocks.slice(0, -1);
    omittedPrompts += 1;
    user = renderUser(head, diffSections, promptBlocks, digestBlocks, promptCapNote, digestCapNote);
  }
  let truncated =
    fieldTruncated ||
    promptCapNote !== "" ||
    digestCapNote !== "" ||
    omittedPrompts > 0 ||
    omittedDigests > 0;
  if (user.length > MAX_CHANGE_PROMPT_CHARS) {
    user = `${user.slice(0, MAX_CHANGE_PROMPT_CHARS)}…(prompt cut over the whole-prompt cap)`;
    truncated = true;
  }
  if (omittedPrompts > 0 || omittedDigests > 0) {
    user += `\n\n…(${omittedPrompts} prompts and ${omittedDigests} digests omitted over the prompt cap)`;
  }
  return { system: SYSTEM_PROMPT, user, truncated };
}

export interface ChangeDraftFile {
  path: string;
  note: string;
}

export interface ChangeDraftHeadsUp {
  type: HeadsUpType;
  text: string;
}

/**
 * Model draft: content fields only. Id, version, snapshotPair and
 * createdFrom are server-owned and stamped after validation, so a narrated
 * change dedupes and versions exactly like its skeleton fallback.
 */
export interface ChangeDraft {
  title: string;
  summary: string;
  before: string[];
  now: string[];
  howItWorks: string[];
  headsUp: ChangeDraftHeadsUp[];
  files: ChangeDraftFile[];
  digest: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Structural parse of a model draft. Field caps stay with
 * validateSkeletonChange: a structurally sound but over-cap draft parses
 * here and fails there, which drives the one retry with the violated caps
 * quoted. Never throws; malformed input yields errors instead.
 */
export function parseChangeDraft(
  value: unknown,
): { ok: true; draft: ChangeDraft } | { ok: false; errors: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["draft must be a JSON object"] };
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  if (!nonEmptyString(record.title)) errors.push("title must be a non-empty string");
  if (!nonEmptyString(record.summary)) errors.push("summary must be a non-empty string");
  if (!nonEmptyString(record.digest)) errors.push("digest must be a non-empty string");

  const stringList = (key: string, allowEmpty: boolean): string[] | null => {
    const entries = record[key];
    if (
      !Array.isArray(entries) ||
      (!allowEmpty && entries.length === 0) ||
      entries.some((entry) => !nonEmptyString(entry))
    ) {
      errors.push(`${key} must be ${allowEmpty ? "a" : "a non-empty"} list of non-empty strings`);
      return null;
    }
    return entries as string[];
  };
  const before = stringList("before", false);
  const now = stringList("now", false);
  // Trivial groups narrate no steps: an empty list is structurally fine.
  const howItWorks = stringList("howItWorks", true);

  let headsUp: ChangeDraftHeadsUp[] | null = null;
  const rawHeadsUp = record.headsUp;
  if (!Array.isArray(rawHeadsUp)) {
    errors.push("headsUp must be a list");
  } else {
    const allowed = new Set<string>(HEADS_UP_TYPES);
    const items: ChangeDraftHeadsUp[] = [];
    rawHeadsUp.forEach((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        errors.push(`headsUp[${index}] must be an object`);
        return;
      }
      const entry = item as Record<string, unknown>;
      if (!allowed.has(String(entry.type)) || !nonEmptyString(entry.text)) {
        errors.push(
          `headsUp[${index}] must hold a typed note (not_asked, watch_out, unfinished) with non-empty text`,
        );
        return;
      }
      items.push({ type: entry.type as HeadsUpType, text: entry.text as string });
    });
    headsUp = items;
  }

  let files: ChangeDraftFile[] | null = null;
  const rawFiles = record.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    errors.push("files must be a non-empty list of {path, note}");
  } else {
    const items: ChangeDraftFile[] = [];
    rawFiles.forEach((file, index) => {
      if (typeof file !== "object" || file === null || Array.isArray(file)) {
        errors.push(`files[${index}] must be an object`);
        return;
      }
      const entry = file as Record<string, unknown>;
      if (!nonEmptyString(entry.path) || !nonEmptyString(entry.note)) {
        errors.push(`files[${index}] must hold a non-empty path and note`);
        return;
      }
      items.push({ path: entry.path as string, note: entry.note as string });
    });
    files = items;
  }

  if (
    errors.length > 0 ||
    before === null ||
    now === null ||
    howItWorks === null ||
    headsUp === null ||
    files === null
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    draft: {
      title: record.title as string,
      summary: record.summary as string,
      before,
      now,
      howItWorks,
      headsUp,
      files,
      digest: record.digest as string,
    },
  };
}
