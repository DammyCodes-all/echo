import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactText } from "@echo/redaction";
import {
  normalizeGitMode,
  openShadowRepo,
  pointRefs,
  type RepoHandle,
  readSourceBlob,
  readSourceTree,
  resolveSessionHead,
  writeBlob,
  writeCommit,
  writeTreeFromFiles,
} from "./git";
import { type WalkFile, walkWorkingTree } from "./ignore";
import { loadManifest, type ManifestEntry, saveManifest } from "./manifest";

export type SnapshotTrigger =
  | "baseline"
  | "final"
  | "tool.pre"
  | "tool.post"
  | "batch.post"
  | "fs.change"
  | "reconcile";

export interface SnapshotLimits {
  maxFileBytes: number;
  maxCapturedBytes: number;
  maxFiles: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxFileBytes: 2 * 1024 * 1024,
  maxCapturedBytes: 200 * 1024 * 1024,
  maxFiles: 20_000,
};

export interface SnapshotBaseOptions {
  shadowDir: string;
  sessionId: string;
  projectId: string;
  trigger: SnapshotTrigger;
  eventId: string;
  takenAt?: Date;
  limits?: Partial<SnapshotLimits>;
}

export interface WorkingTreeSnapshotOptions extends SnapshotBaseOptions {
  root: string;
  dataDir?: string;
  extraIgnorePatterns?: string[];
}

export interface GitTreeSnapshotOptions extends SnapshotBaseOptions {
  sourceRoot: string;
  sourceOid: string;
}

export interface SnapshotFile {
  path: string;
  mode: string | null;
  blobOid: string | null;
  size: number;
  sha256: string | null;
  captured: boolean;
  reason: string | null;
}

export interface SnapshotResult {
  commitOid: string;
  parentOid: string | null;
  trigger: SnapshotTrigger;
  takenAt: string;
  status: "ok" | "partial";
  diagnostics: string[];
  redactionFindings: number;
  files: SnapshotFile[];
  fileCount: number;
  totalBytes: number;
}

interface Counters {
  files: number;
  bytes: number;
  findings: number;
  capped: boolean;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function textOf(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

function metadataEntry(
  path: string,
  mode: string | null,
  size: number,
  mtimeNs: string,
  reason: string,
  sha256: string | null = null,
): ManifestEntry {
  return { path, mode, size, mtimeNs, sha256, blobOid: null, captured: false, reason };
}

async function storeText(input: {
  repo: RepoHandle;
  path: string;
  mode: string;
  text: string;
  mtimeNs: string;
  previous: ManifestEntry | undefined;
  limits: SnapshotLimits;
  counters: Counters;
}): Promise<ManifestEntry> {
  const redacted = redactText(input.text);
  input.counters.findings += redacted.findings.length;
  const bytes = Buffer.from(redacted.value, "utf8");
  const sha256 = digest(bytes);

  const base = {
    path: input.path,
    mode: input.mode,
    size: bytes.byteLength,
    mtimeNs: input.mtimeNs,
    sha256,
  };

  if (
    input.previous?.captured &&
    input.previous.sha256 === sha256 &&
    input.previous.blobOid !== null
  ) {
    input.counters.files += 1;
    input.counters.bytes += bytes.byteLength;
    return { ...base, blobOid: input.previous.blobOid, captured: true, reason: null };
  }

  if (
    input.counters.files + 1 > input.limits.maxFiles ||
    input.counters.bytes + bytes.byteLength > input.limits.maxCapturedBytes
  ) {
    input.counters.capped = true;
    return metadataEntry(
      input.path,
      input.mode,
      bytes.byteLength,
      input.mtimeNs,
      "snapshot_cap",
      sha256,
    );
  }

  const blobOid = await writeBlob(input.repo, bytes);
  input.counters.files += 1;
  input.counters.bytes += bytes.byteLength;
  return { ...base, blobOid, captured: true, reason: null };
}

function readStable(file: WalkFile): {
  bytes: Buffer;
  size: number;
  mtimeNs: string;
  stable: boolean;
} {
  const first = readFileSync(file.absPath);
  const afterFirst = lstatSync(file.absPath, { bigint: true });
  if (
    afterFirst.mtimeNs.toString() === file.mtimeNs &&
    Number(afterFirst.size) === file.size &&
    first.length === file.size
  ) {
    return { bytes: first, size: first.length, mtimeNs: file.mtimeNs, stable: true };
  }

  const second = readFileSync(file.absPath);
  const afterSecond = lstatSync(file.absPath, { bigint: true });
  return {
    bytes: second,
    size: Number(afterSecond.size),
    mtimeNs: afterSecond.mtimeNs.toString(),
    stable:
      afterSecond.mtimeNs === afterFirst.mtimeNs &&
      afterSecond.size === afterFirst.size &&
      second.length === Number(afterSecond.size),
  };
}

async function finalize(options: {
  repo: RepoHandle;
  shadowDir: string;
  sessionId: string;
  trigger: SnapshotTrigger;
  eventId: string;
  takenAt: Date;
  entries: ManifestEntry[];
  counters: Counters;
  diagnostics: string[];
}): Promise<SnapshotResult> {
  const entries = [...options.entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const leaves = entries
    .filter(
      (entry): entry is ManifestEntry & { blobOid: string; mode: string } =>
        entry.captured && entry.blobOid !== null && entry.mode !== null,
    )
    .map((entry) => ({
      path: entry.path,
      mode: normalizeGitMode(entry.mode),
      oid: entry.blobOid,
    }));

  const parentOid = await resolveSessionHead(options.repo);
  const tree = await writeTreeFromFiles(options.repo, leaves);
  const takenAt = options.takenAt;
  const commitOid = await writeCommit(options.repo, {
    tree,
    parent: parentOid,
    message: `echo ${options.sessionId} ${options.trigger} ${options.eventId} ${takenAt.toISOString()}`,
    takenAt,
  });
  await pointRefs(options.repo, commitOid);

  saveManifest(options.shadowDir, {
    version: 1,
    sessionId: options.sessionId,
    commitOid,
    takenAt: takenAt.toISOString(),
    files: Object.fromEntries(entries.map((entry) => [entry.path, entry])),
  });

  const diagnostics = [...options.diagnostics];
  if (options.counters.capped && !diagnostics.includes("snapshot_cap_reached")) {
    diagnostics.push("snapshot_cap_reached");
  }

  return {
    commitOid,
    parentOid,
    trigger: options.trigger,
    takenAt: takenAt.toISOString(),
    status: diagnostics.length > 0 ? "partial" : "ok",
    diagnostics,
    redactionFindings: options.counters.findings,
    files: entries.map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      blobOid: entry.blobOid,
      size: entry.size,
      sha256: entry.sha256,
      captured: entry.captured,
      reason: entry.reason,
    })),
    fileCount: leaves.length,
    totalBytes: options.counters.bytes,
  };
}

export function snapshotWorkingTree(options: WorkingTreeSnapshotOptions): Promise<SnapshotResult> {
  return withLock(options.shadowDir, async () => {
    const takenAt = options.takenAt ?? new Date();
    const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...options.limits };
    const repo = await openShadowRepo(options.shadowDir, options.sessionId, options.projectId);
    const previous = loadManifest(options.shadowDir, options.sessionId);
    const walk = walkWorkingTree({
      root: options.root,
      excludeDirs: [dirname(options.shadowDir), options.dataDir].filter(
        (dir): dir is string => typeof dir === "string" && dir.length > 0,
      ),
      extraPatterns: options.extraIgnorePatterns,
    });

    const entries: ManifestEntry[] = walk.metadata.map((item) =>
      metadataEntry(item.path, null, item.size, item.mtimeNs, item.reason),
    );
    const diagnostics: string[] = [];
    const counters: Counters = { files: 0, bytes: 0, findings: 0, capped: false };

    for (const file of walk.files) {
      const prior = previous?.files[file.path];
      if (
        prior &&
        prior.mode === file.mode &&
        prior.size === file.size &&
        prior.mtimeNs === file.mtimeNs
      ) {
        entries.push({ ...prior, path: file.path });
        if (prior.captured) {
          counters.files += 1;
          counters.bytes += prior.size;
        }
        continue;
      }

      if (file.symlink) {
        entries.push(
          await storeText({
            repo,
            path: file.path,
            mode: "120000",
            text: file.linkTarget ?? "",
            mtimeNs: file.mtimeNs,
            previous: prior,
            limits,
            counters,
          }),
        );
        continue;
      }

      if (file.size > limits.maxFileBytes) {
        entries.push(metadataEntry(file.path, file.mode, file.size, file.mtimeNs, "too_large"));
        continue;
      }

      const read = readStable(file);
      if (!read.stable) {
        diagnostics.push("unstable_file");
        entries.push(
          prior?.captured
            ? { ...prior, path: file.path }
            : metadataEntry(file.path, file.mode, read.size, read.mtimeNs, "unstable_file"),
        );
        continue;
      }

      const text = textOf(read.bytes);
      if (text === null) {
        entries.push(
          metadataEntry(
            file.path,
            file.mode,
            read.bytes.length,
            read.mtimeNs,
            "binary",
            digest(read.bytes),
          ),
        );
        continue;
      }

      entries.push(
        await storeText({
          repo,
          path: file.path,
          mode: file.mode,
          text,
          mtimeNs: read.mtimeNs,
          previous: prior,
          limits,
          counters,
        }),
      );
    }

    return finalize({
      repo,
      shadowDir: options.shadowDir,
      sessionId: options.sessionId,
      trigger: options.trigger,
      eventId: options.eventId,
      takenAt,
      entries,
      counters,
      diagnostics,
    });
  });
}

export function snapshotGitTree(options: GitTreeSnapshotOptions): Promise<SnapshotResult> {
  return withLock(options.shadowDir, async () => {
    const takenAt = options.takenAt ?? new Date();
    const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...options.limits };
    const repo = await openShadowRepo(options.shadowDir, options.sessionId, options.projectId);
    const previous = loadManifest(options.shadowDir, options.sessionId);
    const source = await readSourceTree(options.sourceRoot, options.sourceOid);

    const entries: ManifestEntry[] = source.submodules.map((path) =>
      metadataEntry(path, null, 0, "0", "submodule"),
    );
    const diagnostics: string[] = [];
    const counters: Counters = { files: 0, bytes: 0, findings: 0, capped: false };

    for (const blob of source.blobs) {
      const bytes = await readSourceBlob(options.sourceRoot, blob.oid);
      const prior = previous?.files[blob.path];

      if (bytes.byteLength > limits.maxFileBytes) {
        entries.push(metadataEntry(blob.path, blob.mode, bytes.byteLength, "0", "too_large"));
        continue;
      }

      if (blob.mode === "120000") {
        const target = Buffer.from(bytes).toString("utf8");
        entries.push(
          await storeText({
            repo,
            path: blob.path,
            mode: "120000",
            text: target,
            mtimeNs: "0",
            previous: prior,
            limits,
            counters,
          }),
        );
        continue;
      }

      const text = textOf(bytes);
      if (text === null) {
        entries.push(
          metadataEntry(blob.path, blob.mode, bytes.byteLength, "0", "binary", digest(bytes)),
        );
        continue;
      }

      entries.push(
        await storeText({
          repo,
          path: blob.path,
          mode: blob.mode,
          text,
          mtimeNs: "0",
          previous: prior,
          limits,
          counters,
        }),
      );
    }

    return finalize({
      repo,
      shadowDir: options.shadowDir,
      sessionId: options.sessionId,
      trigger: options.trigger,
      eventId: options.eventId,
      takenAt,
      entries,
      counters,
      diagnostics,
    });
  });
}
