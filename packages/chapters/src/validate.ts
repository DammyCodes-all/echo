import {
  countTokens,
  DIGEST_MAX_TOKENS,
  DIGEST_MIN_TOKENS,
  type DiffFile,
  HEADS_UP_TYPES,
} from "./changes";

/**
 * Thin validator for skeleton changes (ADR 0014 decision g) against the
 * Slice A contract shape in `packages/contracts/src/changes.ts`: title
 * words, summary sentences, before/now array lengths, step count, heads-up
 * count + type, digest token range, file paths present in the input diff,
 * snapshot pair, and createdFrom provenance. Never throws; malformed input
 * yields errors instead.
 */

export interface SkeletonValidation {
  ok: boolean;
  errors: string[];
}

function sentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function validateSkeletonChange(
  change: unknown,
  input: { files: DiffFile[] },
): SkeletonValidation {
  try {
    const errors: string[] = [];
    if (typeof change !== "object" || change === null) {
      return { ok: false, errors: ["change must be an object"] };
    }
    const record = change as Record<string, unknown>;

    if (typeof record.id !== "string" || !/^c_[0-9a-f]{16}$/.test(record.id)) {
      errors.push("id must look like c_ plus 16 hex chars");
    }
    if (
      typeof record.version !== "number" ||
      !Number.isInteger(record.version) ||
      record.version < 1
    ) {
      errors.push("version must be a positive integer");
    }

    const titleWords =
      typeof record.title === "string"
        ? record.title.split(/\s+/).filter((word) => word.length > 0)
        : [];
    if (titleWords.length < 1 || titleWords.length > 8) {
      errors.push(`title must be 1-8 words, got ${titleWords.length}`);
    }

    const summaryCount = typeof record.summary === "string" ? sentences(record.summary).length : -1;
    if (summaryCount < 2 || summaryCount > 3) {
      errors.push(`summary must be 2-3 sentences, got ${summaryCount}`);
    }

    for (const key of ["before", "now"] as const) {
      const value = record[key];
      if (
        !Array.isArray(value) ||
        value.length < 1 ||
        value.length > 2 ||
        value.some((entry) => !isNonEmptyString(entry))
      ) {
        errors.push(`${key} must be 1-2 non-empty strings`);
      }
    }

    if (
      !Array.isArray(record.howItWorks) ||
      record.howItWorks.length > 5 ||
      record.howItWorks.some((step) => typeof step !== "string" || step.trim() === "")
    ) {
      errors.push("howItWorks must be 0-5 non-empty steps");
    }

    const allowed = new Set<string>(HEADS_UP_TYPES);
    const headsUp = record.headsUp as Array<Record<string, unknown>> | unknown;
    if (
      !Array.isArray(headsUp) ||
      headsUp.length > 3 ||
      headsUp.some(
        (item) =>
          typeof item !== "object" ||
          item === null ||
          !allowed.has(String((item as Record<string, unknown>).type)) ||
          typeof (item as Record<string, unknown>).text !== "string" ||
          ((item as Record<string, unknown>).text as string).trim() === "",
      )
    ) {
      errors.push("headsUp must hold at most 3 typed notes (not_asked, watch_out, unfinished)");
    }

    const digestTokens = typeof record.digest === "string" ? countTokens(record.digest) : -1;
    if (digestTokens < DIGEST_MIN_TOKENS || digestTokens > DIGEST_MAX_TOKENS) {
      errors.push(
        `digest must be ${DIGEST_MIN_TOKENS}-${DIGEST_MAX_TOKENS} tokens, got ${digestTokens}`,
      );
    }

    const listed = Array.isArray(record.files) ? record.files : null;
    const known = Array.isArray((input as { files?: unknown } | null | undefined)?.files)
      ? (input as { files: DiffFile[] }).files
      : [];
    if (
      listed === null ||
      listed.length === 0 ||
      listed.some(
        (file) =>
          typeof file !== "object" ||
          file === null ||
          typeof (file as Record<string, unknown>).path !== "string" ||
          ((file as Record<string, unknown>).path as string).length === 0 ||
          typeof (file as Record<string, unknown>).note !== "string" ||
          ((file as Record<string, unknown>).note as string).length === 0,
      )
    ) {
      errors.push("files must be a non-empty list of {path, note}");
    } else {
      const combined = known.map((file) => file.diff).join("\n");
      for (const file of listed as Array<Record<string, unknown>>) {
        const path = file.path as string;
        if (!known.some((entry) => entry.path === path)) {
          errors.push(`file ${path} is not in the input file list`);
        } else if (!combined.includes(path)) {
          errors.push(`file ${path} is missing from the input diff`);
        }
      }
    }

    const pair = record.snapshotPair as Record<string, unknown> | unknown;
    if (
      typeof pair !== "object" ||
      pair === null ||
      !isNonEmptyString((pair as Record<string, unknown>).prevOid) ||
      !isNonEmptyString((pair as Record<string, unknown>).nextOid)
    ) {
      errors.push("snapshotPair must hold non-empty prevOid and nextOid");
    }

    const createdFrom = record.createdFrom as Record<string, unknown> | unknown;
    if (typeof createdFrom !== "object" || createdFrom === null) {
      errors.push("createdFrom must be a tape_range or snapshot_pair object");
    } else {
      const kind = (createdFrom as Record<string, unknown>).kind;
      if (kind === "tape_range") {
        const start = (createdFrom as Record<string, unknown>).startSeq;
        const end = (createdFrom as Record<string, unknown>).endSeq;
        if (
          typeof start !== "number" ||
          !Number.isInteger(start) ||
          start < 0 ||
          typeof end !== "number" ||
          !Number.isInteger(end) ||
          end < 0
        ) {
          errors.push("createdFrom tape_range needs non-negative integer startSeq and endSeq");
        }
      } else if (kind === "snapshot_pair") {
        if (
          !isNonEmptyString((createdFrom as Record<string, unknown>).prevOid) ||
          !isNonEmptyString((createdFrom as Record<string, unknown>).nextOid)
        ) {
          errors.push("createdFrom snapshot_pair needs non-empty prevOid and nextOid");
        }
      } else {
        errors.push("createdFrom must be a tape_range or snapshot_pair object");
      }
    }

    return { ok: errors.length === 0, errors };
  } catch (error) {
    return { ok: false, errors: [`validator crashed: ${String(error)}`] };
  }
}
