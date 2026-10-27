import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExportRecord {
  key: string;
  hash: string;
  raw: unknown;
}

export interface ParsedExport {
  schemaVersion: number | null;
  records: ExportRecord[];
  diagnostics: string[];
}

function hashRecord(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Defensive: the export frame reframes live lines, so keys are minted from
// whatever identity survives ({stream.id, sequence} preferred, ordinal fallback).
export function parseExportDocument(doc: unknown): ParsedExport {
  const diagnostics: string[] = [];
  if (!isRecord(doc)) return { schemaVersion: null, records: [], diagnostics: ["export_invalid"] };
  const schemaVersion =
    typeof doc.export_schema_version === "number" ? doc.export_schema_version : null;
  if (schemaVersion === null) diagnostics.push("export_schema_unknown");
  const rawEvents = Array.isArray(doc.events) ? doc.events : null;
  if (!rawEvents)
    return { schemaVersion, records: [], diagnostics: [...diagnostics, "export_no_events"] };
  const records: ExportRecord[] = [];
  rawEvents.forEach((entry, ordinal) => {
    if (!isRecord(entry)) {
      diagnostics.push("export_skipped_record");
      return;
    }
    const envelope = isRecord(entry.envelope) ? entry.envelope : null;
    const streamId =
      envelope && isRecord(envelope.stream) && typeof envelope.stream.id === "string"
        ? envelope.stream.id
        : null;
    const sequence = envelope && typeof envelope.sequence === "number" ? envelope.sequence : null;
    const key =
      streamId && sequence !== null ? `${streamId}:${sequence}` : `export-ordinal:${ordinal}`;
    records.push({ key, hash: hashRecord(entry), raw: entry });
  });
  return { schemaVersion, records, diagnostics };
}

export interface ReconcileResult {
  addedKeys: string[];
  mergedKeys: string[];
}

// Key-level merge only: a shared key means the live tape already holds the
// record, so the export copy is redundant. Content comparison is deliberately
// absent: live lines and export frames never share a hash domain (native
// envelope UUIDs vs sha256 of reframed entries), so byte equality here would
// always read as conflict.
export function reconcileExport(liveKeys: Set<string>, exported: ExportRecord[]): ReconcileResult {
  const addedKeys: string[] = [];
  const mergedKeys: string[] = [];
  for (const record of exported) {
    if (liveKeys.has(record.key)) mergedKeys.push(record.key);
    else addedKeys.push(record.key);
  }
  return { addedKeys, mergedKeys };
}

export type ExportRunResult =
  | { ok: true; docPath: string; cleanup: () => void }
  | { ok: false; diagnostic: "export_unavailable" | "export_failed" };

// Thin wrapper, never throws: a missing binary or failed export is a
// diagnostic, and live capture remains the tape.
export function runRedactedExport(sessionId: string, museBin = "muse"): ExportRunResult {
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "echo-export-"));
  } catch {
    return { ok: false, diagnostic: "export_failed" };
  }
  try {
    const out = join(dir, "trajectory.json");
    const result = spawnSync(
      museBin,
      ["export", "--session", sessionId, "--redacted", "--out", out],
      {
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    if (result.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      return { ok: false, diagnostic: result.error ? "export_unavailable" : "export_failed" };
    }
    return {
      ok: true,
      docPath: out,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, diagnostic: "export_failed" };
  }
}
