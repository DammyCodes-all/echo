import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TapeEventKind } from "@echo/contracts";
import { translateMuseHook } from "./hooks";

export interface HookSpoolEntry {
  v: 1;
  receivedAt: string;
  sessionId: string | null;
  projectRoot: string | null;
  kind: TapeEventKind | null;
  toolName: string | null;
  payload: unknown;
  findings: number;
  diagnostics: string[];
  dropped: boolean;
}

export const HOOK_SPOOL_CAP = 500;
const MAX_STDIN_BYTES = 1024 * 1024;

export function spoolDir(dataDir: string, sessionId: string | null): string {
  return join(dataDir, "spool", "muse", sessionId ?? "unattributed");
}

export interface SpoolWriteResult {
  path: string;
  pruned: number;
}

export interface StdinRead {
  raw: string;
  truncated: boolean;
}

// Bounded stdin read: hooks pipe small JSON payloads, but the helper runs on
// every tool call, so an unbounded read is a memory-exhaustion vector.
export function readStdinCapped(fd: number, cap: number = MAX_STDIN_BYTES): StdinRead {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    let n: number;
    try {
      n = readSync(fd, buf, 0, buf.length, null);
    } catch {
      break;
    }
    if (n <= 0) break;
    if (total + n > cap) {
      chunks.push(buf.subarray(0, cap - total));
      total = cap;
      truncated = true;
      break;
    }
    chunks.push(buf.subarray(0, n));
    total += n;
  }
  return { raw: Buffer.concat(chunks).toString("utf8"), truncated };
}

// Total entry point for `echo-cli hook muse <event>`: parse stdin, translate,
// redact (inside the translator), spool the redacted entry, prune. Never
// throws on translation problems — those become dropped entries. Throws only
// on I/O failure, and the CLI still exits 0.
export function runMuseHook(args: {
  dataDir: string;
  event: string;
  rawStdin: string;
  stdinTruncated: boolean;
  projects: string[];
  receivedAt?: string;
}): SpoolWriteResult {
  const receivedAt = args.receivedAt ?? new Date().toISOString();
  let entry: HookSpoolEntry;
  if (args.stdinTruncated) {
    entry = {
      v: 1,
      receivedAt,
      sessionId: null,
      projectRoot: null,
      kind: null,
      toolName: null,
      payload: null,
      findings: 0,
      diagnostics: ["hook_payload_oversized"],
      dropped: true,
    };
  } else if (args.rawStdin === "") {
    entry = {
      v: 1,
      receivedAt,
      sessionId: null,
      projectRoot: null,
      kind: null,
      toolName: null,
      payload: null,
      findings: 0,
      diagnostics: ["hook_empty_stdin"],
      dropped: true,
    };
  } else {
    let payload: unknown = null;
    let invalidJson = false;
    try {
      payload = JSON.parse(args.rawStdin);
    } catch {
      invalidJson = true;
    }
    if (invalidJson) {
      entry = {
        v: 1,
        receivedAt,
        sessionId: null,
        projectRoot: null,
        kind: null,
        toolName: null,
        payload: null,
        findings: 0,
        diagnostics: ["hook_stdin_invalid_json"],
        dropped: true,
      };
    } else {
      const translated = translateMuseHook({ event: args.event, payload, projects: args.projects });
      entry = {
        v: 1,
        receivedAt,
        sessionId: translated.sessionId,
        projectRoot: translated.projectRoot,
        kind: translated.kind,
        toolName: translated.toolName,
        payload: translated.redactedPayload,
        findings: translated.findings,
        diagnostics: translated.diagnostics,
        dropped: translated.dropped,
      };
    }
  }
  const dir = spoolDir(args.dataDir, entry.sessionId);
  mkdirSync(dir, { recursive: true });
  const stamp = receivedAt.replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(path, `${JSON.stringify(entry)}\n`);
  // Bound disk use: newest HOOK_SPOOL_CAP win per session directory.
  let pruned = 0;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const excess = files.length - HOOK_SPOOL_CAP;
  for (let i = 0; i < excess; i++) {
    const name = files[i];
    if (name === undefined) continue;
    rmSync(join(dir, name));
    pruned += 1;
  }
  return { path, pruned };
}

export function spoolEntryKey(entry: {
  sessionId: string | null;
  kind: string | null;
  toolName: string | null;
  payload: unknown;
  diagnostics: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        s: entry.sessionId,
        k: entry.kind,
        t: entry.toolName,
        p: entry.payload,
        d: entry.diagnostics,
      }) ?? "null",
    )
    .digest("hex")
    .slice(0, 16);
}
