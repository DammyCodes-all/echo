import { z } from "zod";

// ADR 0014 session review reader: one coherent piece of work per change.
// Change id is `c_` + 16 lowercase hex of sha256(normalized diff +
// snapshot pair). The product name for "change" may rename later; ids do not.
export const ChangeIdSchema = z.string().regex(/^c_[0-9a-f]{16}$/);
export type ChangeId = z.infer<typeof ChangeIdSchema>;

function wordCount(value: string): number {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return value.trim() === "" ? 0 : words.length;
}

function sentenceCount(value: string): number {
  return value
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

function tokenCount(value: string): number {
  return wordCount(value);
}

export const SnapshotPairSchema = z.object({
  prevOid: z.string().min(1),
  nextOid: z.string().min(1),
});
export type SnapshotPair = z.infer<typeof SnapshotPairSchema>;

export const HeadsUpTypeSchema = z.enum(["not_asked", "watch_out", "unfinished"]);
export type HeadsUpType = z.infer<typeof HeadsUpTypeSchema>;

export const HeadsUpItemSchema = z.object({
  type: HeadsUpTypeSchema,
  text: z.string().min(1),
});
export type HeadsUpItem = z.infer<typeof HeadsUpItemSchema>;

export const ChangeFileSchema = z.object({
  path: z.string().min(1),
  note: z.string().min(1),
});
export type ChangeFile = z.infer<typeof ChangeFileSchema>;

// Regen provenance: either the tape range the change was grouped from or the
// snapshot pair whose diff produced it.
export const CreatedFromSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tape_range"),
    startSeq: z.number().int().nonnegative(),
    endSeq: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("snapshot_pair"),
    prevOid: z.string().min(1),
    nextOid: z.string().min(1),
  }),
]);
export type CreatedFrom = z.infer<typeof CreatedFromSchema>;

export const ChangeSchema = z.object({
  id: ChangeIdSchema,
  version: z.number().int().min(1),
  snapshotPair: SnapshotPairSchema,
  title: z
    .string()
    .min(1)
    .refine((value) => wordCount(value) >= 1 && wordCount(value) <= 8, {
      message: "title must be 1-8 words",
    }),
  summary: z
    .string()
    .min(1)
    .refine((value) => sentenceCount(value) >= 2 && sentenceCount(value) <= 3, {
      message: "summary must be 2-3 sentences",
    }),
  before: z.array(z.string().min(1)).min(1).max(2),
  now: z.array(z.string().min(1)).min(1).max(2),
  howItWorks: z.array(z.string().min(1)).max(5),
  headsUp: z.array(HeadsUpItemSchema).max(3),
  files: z.array(ChangeFileSchema).min(1),
  digest: z
    .string()
    .min(1)
    .refine((value) => tokenCount(value) >= 50 && tokenCount(value) <= 100, {
      message: "digest must be 50-100 whitespace-separated tokens",
    }),
  createdFrom: CreatedFromSchema,
  /**
   * Who wrote the prose. Missing means skeleton (all pre-origin rows).
   * The fill-in pass narrates skeleton rows in place, same id/version,
   * so progress never resets when the writing improves.
   */
  origin: z.enum(["skeleton", "model"]).optional(),
});
export type Change = z.infer<typeof ChangeSchema>;

export const ProgressStateSchema = z.enum(["viewed", "understood", "skipped"]);
export type ProgressState = z.infer<typeof ProgressStateSchema>;

// Progress keys on (id, version) and is never reset by regen: a regen stores
// a new version and keeps the old rows.
export const ProgressSchema = z.object({
  changeId: ChangeIdSchema,
  version: z.number().int().min(1),
  state: ProgressStateSchema,
  updatedAt: z.string().min(1),
});
export type Progress = z.infer<typeof ProgressSchema>;

type ProgressEntry = ProgressState | { state: ProgressState };

// Resume is the first not-understood change in display order. Missing progress
// and `viewed`/`skipped` all count as not-understood: only `understood` clears.
export function firstNotUnderstood(
  orderedIds: readonly ChangeId[],
  progress: ReadonlyMap<string, ProgressEntry> | Record<string, ProgressEntry | undefined>,
): ChangeId | null {
  const lookup = (id: string): ProgressState | undefined => {
    const entry: ProgressEntry | undefined =
      progress instanceof Map
        ? (progress as ReadonlyMap<string, ProgressEntry>).get(id)
        : (progress as Record<string, ProgressEntry | undefined>)[id];
    if (entry === undefined) return undefined;
    const state: ProgressState = typeof entry === "string" ? entry : entry.state;
    return state;
  };
  for (const id of orderedIds) {
    if (lookup(id) !== "understood") return id;
  }
  return null;
}

// Per-session artifact files under the session dir. Content + progress only;
// no story/checks/engagement writes live here.
export const CHANGES_FILE_NAME = "changes.json" as const;
export const PROGRESS_FILE_NAME = "progress.json" as const;

export const REVIEW_READER_ARTIFACT_FILE_NAMES = {
  changes: CHANGES_FILE_NAME,
  progress: PROGRESS_FILE_NAME,
} as const;
