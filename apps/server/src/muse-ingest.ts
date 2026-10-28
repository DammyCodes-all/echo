import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  ADAPTER_VERSION,
  buildTapeEvent,
  emptyLinks,
  finalizeMuseSession,
  freshLaneCursor,
  getMuseVersion,
  isoFromUs,
  parseSpoolFile,
  runRedactedExport,
  spoolEntryKey,
  spoolRoot,
  tailChunk,
} from "@echo/capture-muse";
import type { CaptureQuality, TapeEvent } from "@echo/contracts";
import { projectIdForDirectory } from "@echo/core";
import {
  type EchoDb,
  getReaderCheckpoint,
  getSession,
  getSessionBuildPin,
  getSessionEventIds,
  getSessionSummary,
  hasEventKind,
  insertSnapshot,
  insertStampedEvents,
  latestSnapshot,
  maxTapeSeq,
  pruneReaderCheckpoints,
  type ReaderCheckpoint,
  upsertProject,
  upsertReaderCheckpoint,
  upsertSession,
  upsertSessionBuildPin,
} from "@echo/db";
import {
  findRepositoryRoot,
  type RepositoryIdentity,
  resolveRepositoryIdentity,
  type SnapshotResult,
  snapshotWorkingTree,
} from "@echo/snapshots";
import { TapeWriter } from "@echo/tape";
import { maybeFinalSnapshot } from "./muse-snapshots";
import { makeSnapshotEvent, makeSnapshotEventId } from "./tape-events";

export interface MuseIngestLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export interface MuseIngestOptions {
  dataDir: string;
  db: EchoDb;
  log: MuseIngestLogger;
  sessionsDir?: string;
  projects: string[];
  museBin?: string;
  /**
   * Fire-and-forget hook when a session export reconciles (finalized).
   * Must never throw or block: the caller owns async errors.
   */
  onSessionQuiescent?: (sessionId: string) => void;
}

export interface MuseIngestResult {
  scanned: number;
  capturedSessions: number;
  eventsAdded: number;
  skipped: number;
  drained: number;
  unattributed: number;
  reconciled: number;
}

const MAX_LOG_BYTES = 128 * 1024 * 1024;
const MAX_SPOOL_PER_POLL = 200;
// Idle polls before a session counts as quiescent: with the default 3s poll
// interval this is ~6s of log silence, past the 1.5s finalization window.
export const QUIESCENT_POLLS = 2;

export interface ExportCandidate {
  stablePolls: number;
  hasEvents: boolean;
  reconciled: boolean;
}

export function shouldExportSession(candidate: ExportCandidate): boolean {
  return candidate.stablePolls >= QUIESCENT_POLLS && candidate.hasEvents && !candidate.reconciled;
}

export function resolveMuseSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MUSE_SESSIONS_DIR) return env.MUSE_SESSIONS_DIR;
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "muse", "sessions");
}

// Project identity is shared with the OpenCode adapter through canonical
// repository roots and normalized remotes: sessions run in different
// subdirectories of one repository join the same project.

function isUnder(directory: string, root: string): boolean {
  const normalizedDirectory = resolve(directory);
  const normalizedRoot = resolve(root);
  return (
    normalizedDirectory === normalizedRoot || normalizedDirectory.startsWith(normalizedRoot + sep)
  );
}

async function resolveEnabledIdentity(
  startDir: string,
  projects: string[],
): Promise<RepositoryIdentity | null> {
  const identity = await resolveRepositoryIdentity(startDir);
  // The allowlist is about where the agent ran, not the repository it
  // belongs to: enabling `/repo/docs` must not capture `/repo/other`.
  const enabled = projects.some((candidate) => isUnder(startDir, candidate));
  return enabled ? identity : null;
}

function walkSessionLogs(sessionsDir: string): string[] {
  const found: string[] = [];
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "subagent") continue;
      const abs = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry === "session.jsonl") continue;
        stack.push(abs);
      } else if (entry === "session.jsonl") {
        found.push(abs);
      }
    }
  }
  return found;
}

function childContents(sessionFile: string): Array<{ id: string; content: string }> {
  const out: Array<{ id: string; content: string }> = [];
  const dir = join(dirname(sessionFile), "subagent");
  let children: string[];
  try {
    children = readdirSync(dir);
  } catch {
    return out;
  }
  for (const child of children) {
    const log = join(dir, child, "session.jsonl");
    try {
      if (statSync(log).size <= MAX_LOG_BYTES)
        out.push({ id: child, content: readFileSync(log, "utf8") });
    } catch {
      // Unreadable child logs are skipped; a referenced-but-absent child
      // surfaces as a capture.gap during finalization instead.
    }
  }
  return out;
}

function extractWorkspaceRoot(content: string): string | null {
  // Attribution without guessing: only explicit workspace markers count.
  for (const line of content.split("\n", 200)) {
    if (!line.includes("workspace_root") && !line.includes("route_facts")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const payload = (parsed as Record<string, unknown>).payload;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
      const record = payload as Record<string, unknown>;
      const metadata = record.metadata;
      if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
        const root = (metadata as Record<string, unknown>).workspace_root;
        if (typeof root === "string" && root.length > 0) return root;
      }
      const facts = record.route_facts;
      if (facts !== null && typeof facts === "object" && !Array.isArray(facts)) {
        const cwd = (facts as Record<string, unknown>).cwd;
        if (typeof cwd === "string" && cwd.length > 0) return cwd;
      }
    } catch {
      // Unparseable lines are not evidence; the reader counts them.
    }
  }
  return null;
}

// Positional read of new bytes only: the daemon tails large logs instead of
// re-reading them. Races with a concurrent writer are safe: growth between
// stat and read surfaces next poll, shrinkage yields a short buffer.
function readSince(path: string, position: number, end: number): Buffer {
  if (end <= position) return Buffer.alloc(0);
  const fd = openSync(path, "r");
  try {
    const out = Buffer.alloc(end - position);
    let read = 0;
    while (read < out.length) {
      const n = readSync(fd, out, read, out.length - read, position + read);
      if (n === 0) break;
      read += n;
    }
    return out.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function laneCursorFrom(checkpoint: ReaderCheckpoint | null): ReturnType<typeof freshLaneCursor> {
  if (!checkpoint) return freshLaneCursor();
  return {
    lastSequence: checkpoint.lastSequence,
    lastEventTs: checkpoint.lastEventTs,
    trailingMarkerAfter: checkpoint.lastMarkerAfter,
    markerCount: checkpoint.markerCount,
    sessionStarted: checkpoint.sessionStarted,
  };
}

type LanePollResult =
  | { status: "skipped" }
  | { status: "failed" }
  | {
      status: "ok";
      events: TapeEvent[];
      diagnostics: string[];
      quality: CaptureQuality;
      referenced: Map<string, number | null>;
      grew: boolean;
    };

// Tail one log file (parent lane '' or one child lane) from its DB checkpoint.
// Pure parsing lives in tailChunk; this owns stat/read/checkpoint/reset. Gaps
// for rotation, truncation and in-place rewrites are emitted here with stable
// recordKeys so retries dedupe. Returns "skipped" for missing/oversized logs
// and "failed" when the checkpoint must not advance (retry next poll).
function tailLaneFile(args: {
  db: EchoDb;
  log: MuseIngestLogger;
  sessionId: string;
  projectId: string;
  lane: string;
  file: string;
  startedFallback: boolean;
  observedAt: Date;
  observedIso: string;
}): LanePollResult {
  let size: number;
  let ino: number;
  try {
    const stat = statSync(args.file);
    size = stat.size;
    ino = stat.ino;
  } catch {
    return { status: "skipped" };
  }
  if (size > MAX_LOG_BYTES) return { status: "skipped" };
  const previous = getReaderCheckpoint(args.db, args.sessionId, args.lane);
  let resetReason: "source_replaced" | "source_truncated" | null = null;
  if (previous && previous.inode !== null && previous.inode !== ino) {
    resetReason = "source_replaced";
  } else if (previous && size < previous.offset) {
    resetReason = "source_truncated";
  }
  const baseOffset = resetReason ? 0 : (previous?.offset ?? 0);
  let chunk: Buffer;
  try {
    chunk = readSince(args.file, baseOffset, size);
  } catch (error) {
    args.log.error({ err: String(error), session_file: args.file }, "muse log unreadable");
    return { status: "failed" };
  }
  const cursor = laneCursorFrom(resetReason ? null : previous);
  cursor.sessionStarted = cursor.sessionStarted || args.startedFallback;
  if (chunk.length === 0 && !resetReason) {
    return {
      status: "ok",
      events: [],
      diagnostics: [],
      quality: "full",
      referenced: new Map(),
      grew: false,
    };
  }
  const run = (bytes: Buffer, base: number, fresh: boolean): ReturnType<typeof tailChunk> =>
    tailChunk({
      sessionId: args.sessionId,
      projectId: args.projectId,
      build: null,
      lane: args.lane,
      chunk: bytes.toString("utf8"),
      baseOffset: base,
      observedAt: args.observedAt,
      cursor: fresh ? { ...laneCursorFrom(null), sessionStarted: cursor.sessionStarted } : cursor,
    });
  let tailed: ReturnType<typeof tailChunk>;
  try {
    tailed = run(chunk, baseOffset, resetReason !== null);
  } catch (error) {
    args.log.error({ err: String(error), session_id: args.sessionId }, "muse tail failed");
    return { status: "failed" };
  }
  let sequenceReset = false;
  let newOffset = baseOffset + 0;
  if (tailed.nonMonotonic && !resetReason && previous) {
    // Same inode, size not shrunk, yet sequences went backwards: the file was
    // rewritten in place. Re-read from the beginning with a fresh cursor and
    // dedupe by event id; only the reset gap is new.
    try {
      const fullSize = statSync(args.file).size;
      if (fullSize > MAX_LOG_BYTES) return { status: "skipped" };
      tailed = run(readSince(args.file, 0, fullSize), 0, true);
      sequenceReset = true;
      newOffset = tailed.consumedBytes;
    } catch (error) {
      args.log.error({ err: String(error), session_id: args.sessionId }, "muse reset failed");
      return { status: "failed" };
    }
  } else {
    newOffset = baseOffset + tailed.consumedBytes;
  }
  const events = [...tailed.events];
  const diagnostics = [...tailed.diagnostics];
  const gapKinds: string[] = [];
  if (resetReason) gapKinds.push(resetReason);
  if (sequenceReset) gapKinds.push("sequence_reset");
  for (const code of gapKinds) {
    const { event } = buildTapeEvent({
      kind: "capture.gap",
      payload: { code, lane: args.lane === "" ? null : args.lane },
      payloadType: null,
      recordType: "gap",
      sequence: null,
      ts: args.observedIso,
      recordKey: `muse:${args.sessionId}:gap:${code}`,
      links: emptyLinks(),
      diagnostics: [code],
      sessionId: args.sessionId,
      projectId: args.projectId,
      build: null,
      observedAt: args.observedIso,
      tapeSeq: events.length,
      schema: null,
      origin: "live",
    });
    events.unshift(event);
    diagnostics.push(code);
  }
  upsertReaderCheckpoint(args.db, {
    sessionId: args.sessionId,
    lane: args.lane,
    sourcePath: args.file,
    inode: ino,
    offset: newOffset,
    lastSequence: tailed.next.lastSequence,
    lastEventTs: tailed.next.lastEventTs,
    lastMarkerAfter: tailed.next.trailingMarkerAfter,
    markerCount: tailed.next.markerCount,
    sessionStarted: tailed.next.sessionStarted,
    schemaVersion: tailed.schemaVersion ?? previous?.schemaVersion ?? null,
    adapterVersion: ADAPTER_VERSION,
    build: null,
    status: "active",
    error: null,
    lastReadAt: args.observedIso,
  });
  return {
    status: "ok",
    events,
    diagnostics,
    quality:
      gapKinds.length > 0 || tailed.quality !== "full" ? ("partial" as const) : ("full" as const),
    referenced: tailed.referencedChildIds,
    grew: chunk.length > 0 || resetReason !== null || sequenceReset,
  };
}

export function createMuseIngest(options: MuseIngestOptions) {
  const { dataDir, db, log, projects } = options;
  const sessionsDir = options.sessionsDir ?? resolveMuseSessionsDir();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let lastUnattributed = 0;
  // Set once per boot when the muse binary is missing: export_unavailable is
  // environmental, not per-session, so retrying every poll only spams the log.
  let exportBroken = false;
  // Installed Muse version, fetched once per boot and pinned per ingested
  // session. A mid-boot upgrade surfaces on restart, which also re-reads
  // checkpoints — no per-poll spawn cost, no stale pins.
  let cachedMuseVersion: string | null | undefined;
  function currentMuseVersion(): string | null {
    if (cachedMuseVersion === undefined) {
      cachedMuseVersion = getMuseVersion(options.museBin ?? "muse");
    }
    return cachedMuseVersion;
  }
  // Consecutive unchanged polls per log. Reaching QUIESCENT_POLLS means the
  // session went quiet; reset to 0 whenever new parent bytes are processed or
  // processing fails so only stably-quiet sessions reconcile. In-memory only:
  // restarts re-establish quiescence within two polls.
  const stable = new Map<string, number>();

  function emptyResult(): MuseIngestResult {
    return {
      scanned: 0,
      capturedSessions: 0,
      eventsAdded: 0,
      skipped: 0,
      drained: 0,
      unattributed: 0,
      reconciled: 0,
    };
  }

  // Shared append path for scanned log events and drained spool events:
  // sequence from the current max, one fsync per batch, insert count back.
  function persistFresh(sessionId: string, tapePath: string, fresh: TapeEvent[]): number {
    if (fresh.length === 0) return 0;
    let seq = maxTapeSeq(db, sessionId);
    for (const event of fresh) {
      seq += 1;
      event.tape_seq = seq;
    }
    const writer = new TapeWriter(tapePath);
    try {
      for (const event of fresh) writer.append(event);
      writer.flush();
    } finally {
      writer.close();
    }
    return insertStampedEvents(db, sessionId, fresh);
  }

  // Live shadow snapshots for Muse sessions. Baseline and final bracket the
  // session; tool.post captures post-action file state when a poll observes a
  // completed or failed tool. Snapshots are best-effort and idempotent: the
  // deterministic snapshot event id dedupes retries across polls.
  async function takeLiveSnapshot(input: {
    sessionId: string;
    projectId: string;
    tapePath: string;
    root: string;
    trigger: "baseline" | "tool.post" | "final";
    key: string;
    observedAt: string;
  }): Promise<{ added: number; failed: boolean }> {
    const eventId = makeSnapshotEventId(input.sessionId, input.trigger, input.key);
    if (getSessionEventIds(db, input.sessionId).has(eventId)) return { added: 0, failed: false };
    const shadowDir = join(dataDir, "projects", input.projectId, "shadow.git");
    try {
      const snapshot: SnapshotResult = await snapshotWorkingTree({
        shadowDir,
        root: input.root,
        sessionId: input.sessionId,
        projectId: input.projectId,
        trigger: input.trigger,
        eventId,
        takenAt: new Date(),
      });
      insertSnapshot(db, {
        id: snapshot.commitOid,
        sessionId: input.sessionId,
        commitOid: snapshot.commitOid,
        parentOid: snapshot.parentOid,
        trigger: snapshot.trigger,
        eventId,
        takenAt: snapshot.takenAt,
        fileCount: snapshot.fileCount,
        totalBytes: snapshot.totalBytes,
        status: snapshot.status,
        diagnostics: snapshot.diagnostics,
        files: snapshot.files.map((file) => ({
          path: file.path,
          mode: file.mode,
          blobOid: file.blobOid,
          size: file.size,
          sha256: file.sha256,
          captured: file.captured,
          reason: file.reason,
        })),
      });
      const added = persistFresh(input.sessionId, input.tapePath, [
        makeSnapshotEvent({
          agent: "muse",
          sessionId: input.sessionId,
          projectId: input.projectId,
          eventId,
          observedAt: input.observedAt,
          result: snapshot,
        }),
      ]);
      return { added, failed: snapshot.status !== "ok" };
    } catch (error) {
      log.error(
        { err: String(error), session_id: input.sessionId, trigger: input.trigger },
        "muse snapshot failed",
      );
      return { added: 0, failed: true };
    }
  }

  // Hook spool drain. Runs before the log scan so a hook-only session gets a
  // minimal row first and the scan's upsert enriches it afterwards — never the
  // reverse. Files are deleted only after a successful insert; a crash between
  // the two replays into the same deterministic event ids and dedupes.
  // Baseline and post-action snapshots for drained hook activity land inline;
  // the deterministic snapshot event ids dedupe retries across polls.
  async function drainSpool(result: MuseIngestResult, observedIso: string): Promise<void> {
    const root = spoolRoot(dataDir);
    let dirs: string[];
    try {
      dirs = readdirSync(root).sort();
    } catch {
      return; // no spool yet
    }
    let processed = 0;
    // One post-action snapshot per session per poll: a burst of spooled tool
    // events records only its latest event id here; snapshots run below.
    const toolActivity = new Map<
      string,
      { projectId: string; tapePath: string; root: string; eventId: string }
    >();
    for (const dirName of dirs) {
      const dir = join(root, dirName);
      let files: string[];
      try {
        files = readdirSync(dir)
          .filter((name) => name.endsWith(".json"))
          .sort();
      } catch {
        continue;
      }
      for (const file of files) {
        if (processed >= MAX_SPOOL_PER_POLL) return;
        const abs = join(dir, file);
        const entry = parseSpoolFile(abs);
        if (!entry) {
          log.error({ spool_file: abs }, "muse spool entry unparseable, dropping");
          try {
            rmSync(abs);
          } catch {
            // Leave it; the cap bounds the damage and the next poll retries.
          }
          continue;
        }
        const sessionId = entry.sessionId;
        const projectRoot = entry.projectRoot;
        if (!sessionId || !projectRoot) {
          result.unattributed += 1;
          continue; // leave on disk; the write-time cap bounds it
        }
        const identity = await resolveEnabledIdentity(projectRoot, projects);
        if (!identity) {
          result.unattributed += 1;
          continue; // leave on disk; the write-time cap bounds it
        }
        // Budget covers only entries that reach ingestion: files that can
        // never drain must not starve drainable ones behind the cap.
        processed += 1;
        const projectId = identity.projectId;
        const tapePath = join(dataDir, "projects", projectId, "sessions", sessionId, "tape.jsonl");
        const snapshotRoot = findRepositoryRoot(projectRoot) ?? identity.canonicalRoot;
        try {
          const { event } = buildTapeEvent({
            kind: entry.kind ?? "capture.gap",
            payload: entry.payload ?? { hook_dropped: true },
            payloadType: "hook",
            recordType: "hook",
            sequence: null,
            ts: entry.receivedAt,
            recordKey: `muse:${sessionId}:hook:${spoolEntryKey(entry)}`,
            links: emptyLinks(),
            diagnostics: [...entry.diagnostics, "hook_spool"],
            sessionId,
            projectId,
            build: null,
            observedAt: observedIso,
            tapeSeq: 0,
            schema: "hook/v1",
            origin: "live",
          });
          const isNewSession = !getSession(db, sessionId);
          if (isNewSession) {
            mkdirSync(dirname(tapePath), { recursive: true });
            upsertProject(db, {
              id: projectId,
              root: identity.canonicalRoot,
              remoteUrl: identity.remoteUrl,
              name: basename(identity.canonicalRoot),
            });
            // Hook-only bootstrap quality comes from the same function as
            // every other quality value: no native log was seen, so the
            // hookOnly floor (degraded) applies. Ingest persists, never decides.
            const bootstrap = finalizeMuseSession({
              sessionId,
              projectId,
              build: null,
              liveContent: "",
              hookOnly: true,
              observedAt: new Date(observedIso),
            });
            upsertSession(db, {
              id: sessionId,
              projectId,
              agent: "muse",
              model: null,
              directory: projectRoot,
              title: null,
              startedAt: entry.receivedAt,
              tapePath,
              captureQuality: bootstrap.quality,
            });
          }
          if (latestSnapshot(db, sessionId, "baseline") === null) {
            const snap = await takeLiveSnapshot({
              sessionId,
              projectId,
              tapePath,
              root: snapshotRoot,
              trigger: "baseline",
              key: "initial",
              observedAt: observedIso,
            });
            result.eventsAdded += snap.added;
          }
          if (getSessionEventIds(db, sessionId).has(event.event_id)) {
            try {
              rmSync(abs);
            } catch {
              // Already ingested; a delete retry happens next poll.
            }
            continue;
          }
          result.eventsAdded += persistFresh(sessionId, tapePath, [event]);
          result.drained += 1;
          if (event.kind === "tool.completed" || event.kind === "tool.failed") {
            toolActivity.set(sessionId, {
              projectId,
              tapePath,
              root: snapshotRoot,
              eventId: event.event_id,
            });
          }
          try {
            rmSync(abs);
          } catch (error) {
            log.error({ err: String(error), spool_file: abs }, "muse spool delete failed");
          }
        } catch (error) {
          // Transient (DB/IO): leave the file; the next poll retries.
          log.error({ err: String(error), session_id: sessionId }, "muse spool entry failed");
        }
      }
    }
    for (const [sessionId, activity] of toolActivity) {
      const snap = await takeLiveSnapshot({
        sessionId,
        projectId: activity.projectId,
        tapePath: activity.tapePath,
        root: activity.root,
        trigger: "tool.post",
        key: activity.eventId,
        observedAt: observedIso,
      });
      result.eventsAdded += snap.added;
    }
  }

  // Export reconciliation for one quiescent session per poll, at most.
  // Runs after the scan so the live tape is current. Before exporting, a
  // quiescent session carrying session.ended gets its final snapshot; the
  // export follows. Skips sessions that were never ingested (no project
  // attribution), have no events, or already carry a capture.reconciled
  // marker. Failures keep the live tape and retry later, except a missing
  // binary which is flagged once per boot.
  async function exportOnce(
    result: MuseIngestResult,
    observedIso: string,
    found: Set<string>,
  ): Promise<void> {
    if (exportBroken) return;
    const museBin = options.museBin ?? "muse";
    for (const sessionFile of [...found].sort()) {
      const sessionId = basename(dirname(sessionFile));
      if (
        !shouldExportSession({
          stablePolls: stable.get(sessionFile) ?? 0,
          hasEvents: getSessionEventIds(db, sessionId).size > 0,
          reconciled: hasEventKind(db, sessionId, "capture.reconciled"),
        })
      ) {
        continue;
      }
      let content: string;
      try {
        const stat = statSync(sessionFile);
        if (stat.size > MAX_LOG_BYTES) continue;
        content = readFileSync(sessionFile, "utf8");
      } catch (error) {
        log.error({ err: String(error), session_file: sessionFile }, "muse log unreadable");
        continue;
      }
      // Final snapshot after SessionEnd + quiescence, before the export flow.
      // maybeFinalSnapshot is a no-op without session.ended or with an
      // existing final snapshot, so re-polls stay idempotent.
      try {
        const row = getSession(db, sessionId);
        if (row && hasEventKind(db, sessionId, "session.ended")) {
          const matched = projects.find(
            (candidate) => projectIdForDirectory(resolve(candidate)) === row.projectId,
          );
          const workspaceRoot = extractWorkspaceRoot(content);
          const snapRoot =
            (workspaceRoot ? findRepositoryRoot(workspaceRoot) : null) ??
            (matched ? resolve(matched) : null);
          if (snapRoot) {
            const final = await maybeFinalSnapshot(
              { dataDir, db, log },
              { sessionId, projectId: row.projectId, root: snapRoot, observedAt: observedIso },
            );
            result.eventsAdded += final.eventsAdded;
          }
        }
      } catch (error) {
        log.error({ err: String(error), session_id: sessionId }, "muse final snapshot failed");
      }
      const run = runRedactedExport(sessionId, museBin);
      if (!run.ok) {
        if (run.diagnostic === "export_unavailable") {
          exportBroken = true;
          log.error({ session_id: sessionId }, "muse export unavailable, skipping");
        } else {
          log.error({ session_id: sessionId }, "muse export failed");
        }
        return;
      }
      try {
        // NOTE: pass the raw document here. finalizeMuseSession parses it
        // itself; parsing it twice (e.g. via parseExportFile first) yields an
        // empty reconcile because the parsed shape has no export envelope.
        let exportDoc: unknown;
        try {
          exportDoc = JSON.parse(readFileSync(run.docPath, "utf8"));
        } catch {
          log.error({ session_id: sessionId }, "muse export unparseable");
          return;
        }
        const row = getSession(db, sessionId);
        if (!row) {
          // Session row vanished mid-poll; the next scan re-creates it.
          return;
        }
        const finalized = finalizeMuseSession({
          sessionId,
          projectId: row.projectId,
          build: null,
          liveContent: content,
          childContents: childContents(sessionFile),
          exportDoc,
          observedAt: new Date(observedIso),
        });
        const tapePath = join(
          dataDir,
          "projects",
          row.projectId,
          "sessions",
          sessionId,
          "tape.jsonl",
        );
        const existing = getSessionEventIds(db, sessionId);
        const fresh = finalized.events.filter((event) => !existing.has(event.event_id));
        const { event: reconciledEvent } = buildTapeEvent({
          kind: "capture.reconciled",
          payload: {
            added: finalized.reconciled?.added ?? 0,
            merged: finalized.reconciled?.merged ?? 0,
            conflicts: finalized.reconciled?.conflicts ?? 0,
            export_schema_version: finalized.reconciled?.schemaVersion ?? null,
          },
          payloadType: "export",
          recordType: "reconcile",
          sequence: null,
          ts: observedIso,
          recordKey: `muse:${sessionId}:export:reconciled`,
          links: emptyLinks(),
          diagnostics: finalized.diagnostics
            .filter((entry) => entry.startsWith("export_"))
            .slice(0, 16),
          sessionId,
          projectId: row.projectId,
          build: null,
          observedAt: observedIso,
          tapeSeq: 0,
          schema: null,
          origin: "live",
        });
        const all = [...fresh];
        if (!existing.has(reconciledEvent.event_id)) all.push(reconciledEvent);
        result.eventsAdded += persistFresh(sessionId, tapePath, all);
        if (finalized.reconciled) {
          const workspaceRoot = extractWorkspaceRoot(content);
          upsertSession(db, {
            id: sessionId,
            projectId: row.projectId,
            agent: "muse",
            model: null,
            directory: workspaceRoot,
            title: null,
            startedAt: finalized.events[0]?.ts ?? null,
            tapePath,
            captureQuality: finalized.quality,
          });
          upsertSessionBuildPin(db, {
            sessionId,
            museVersion: currentMuseVersion(),
            adapterVersion: ADAPTER_VERSION,
            exportSchemaVersion: finalized.reconciled.schemaVersion,
            observedAt: observedIso,
          });
          if (workspaceRoot && latestSnapshot(db, sessionId, "final") === null) {
            const snap = await takeLiveSnapshot({
              sessionId,
              projectId: row.projectId,
              tapePath,
              root: findRepositoryRoot(workspaceRoot) ?? workspaceRoot,
              trigger: "final",
              key: "final",
              observedAt: observedIso,
            });
            result.eventsAdded += snap.added;
            if (snap.failed) {
              upsertSession(db, {
                id: sessionId,
                projectId: row.projectId,
                agent: "muse",
                model: null,
                directory: workspaceRoot,
                title: null,
                startedAt: finalized.events[0]?.ts ?? null,
                tapePath,
                captureQuality: "partial",
              });
            }
          }
          result.reconciled += 1;
          if (options.onSessionQuiescent) {
            try {
              options.onSessionQuiescent(sessionId);
            } catch (error) {
              log.error({ err: String(error), session_id: sessionId }, "story hook failed");
            }
          }
        }
      } catch (error) {
        log.error({ err: String(error), session_id: sessionId }, "muse export reconcile failed");
      } finally {
        run.cleanup();
      }
      return;
    }
  }

  async function scan(): Promise<MuseIngestResult> {
    const result = emptyResult();
    if (projects.length === 0) return result;
    const observedAt = new Date().toISOString();
    await drainSpool(result, observedAt);
    if (!existsSync(sessionsDir)) return result;
    const found = new Set(walkSessionLogs(sessionsDir));
    for (const key of stable.keys()) {
      if (!found.has(key)) stable.delete(key);
    }
    for (const sessionFile of found) {
      result.scanned += 1;
      let fingerprint: { size: number; ino: number };
      try {
        const stat = statSync(sessionFile);
        fingerprint = { size: stat.size, ino: stat.ino };
      } catch (error) {
        log.error({ err: String(error), session_file: sessionFile }, "muse log unreadable");
        continue;
      }
      if (fingerprint.size > MAX_LOG_BYTES) {
        result.skipped += 1;
        continue;
      }
      const sessionId = basename(dirname(sessionFile));
      const childDir = join(dirname(sessionFile), "subagent");
      const lanes: Array<{ lane: string; file: string }> = [{ lane: "", file: sessionFile }];
      try {
        for (const child of readdirSync(childDir).sort()) {
          lanes.push({ lane: child, file: join(childDir, child, "session.jsonl") });
        }
      } catch {
        // No child logs yet.
      }
      const sessionRow = getSession(db, sessionId);
      const summary = sessionRow ? getSessionSummary(db, sessionId) : null;
      const isNewSession = !sessionRow;
      // Fast path: every lane already at EOF with a matching inode. Steady
      // state is one stat plus one checkpoint select per lane per poll.
      if (!isNewSession) {
        let quiet = true;
        for (const { lane, file } of lanes) {
          let current: { size: number; ino: number } | null = null;
          try {
            const stat = statSync(file);
            current = { size: stat.size, ino: stat.ino };
          } catch {
            current = null;
          }
          const checkpoint = getReaderCheckpoint(db, sessionId, lane);
          if (
            current === null ||
            checkpoint === null ||
            checkpoint.inode !== current.ino ||
            current.size !== checkpoint.offset ||
            current.size > MAX_LOG_BYTES
          ) {
            quiet = false;
            break;
          }
        }
        if (quiet) {
          stable.set(sessionFile, (stable.get(sessionFile) ?? 0) + 1);
          continue;
        }
      }
      // Attribution without guessing: first-sight sessions probe the parent
      // log once and resolve the repository identity (canonical root, remote);
      // known sessions reuse their stored directory and re-resolve so moves
      // and remote changes are picked up. Unattributed logs advance nothing,
      // so a later project-enablement still ingests full history from offset
      // zero.
      let workspaceRoot: string | null = summary?.directory ?? null;
      let identity: RepositoryIdentity | null = null;
      let projectId: string | null = sessionRow?.projectId ?? null;
      if (isNewSession) {
        let probe: string;
        try {
          probe = readFileSync(sessionFile, "utf8");
        } catch (error) {
          log.error({ err: String(error), session_file: sessionFile }, "muse log unreadable");
          continue;
        }
        const foundWorkspace = extractWorkspaceRoot(probe);
        if (!foundWorkspace) {
          result.skipped += 1;
          continue;
        }
        identity = await resolveEnabledIdentity(foundWorkspace, projects);
        if (!identity) {
          result.skipped += 1;
          continue;
        }
        workspaceRoot = foundWorkspace;
        projectId = identity.projectId;
      } else {
        if (!workspaceRoot) {
          result.skipped += 1;
          continue;
        }
        identity = await resolveEnabledIdentity(workspaceRoot, projects);
        if (!identity) {
          // Project disabled since: hold every checkpoint, resume on re-enable.
          result.skipped += 1;
          continue;
        }
        projectId = sessionRow?.projectId ?? identity.projectId;
      }
      const startedFallback = hasEventKind(db, sessionId, "session.started");
      const observedDate = new Date(observedAt);
      const combined: TapeEvent[] = [];
      const combinedDiagnostics: string[] = [];
      let combinedPartial = false;
      const referenced = new Map<string, number | null>();
      const presentChildIds: string[] = [];
      let parentGrew = false;
      let laneFailed = false;
      for (const { lane, file } of lanes) {
        const outcome = tailLaneFile({
          db,
          log,
          sessionId,
          projectId,
          lane,
          file,
          startedFallback:
            startedFallback || combined.some((event) => event.kind === "session.started"),
          observedAt: observedDate,
          observedIso: observedAt,
        });
        if (outcome.status === "skipped") continue;
        if (outcome.status === "failed") {
          laneFailed = true;
          continue;
        }
        if (lane === "") parentGrew = outcome.grew;
        else presentChildIds.push(lane);
        if (outcome.quality !== "full") combinedPartial = true;
        combined.push(...outcome.events);
        combinedDiagnostics.push(...outcome.diagnostics);
        for (const [childId, recordedAtUs] of outcome.referenced) {
          if (!referenced.has(childId)) referenced.set(childId, recordedAtUs);
        }
      }
      // Referenced-but-absent child logs are gaps with subagent linkage,
      // never invented actions. Same recordKeys as a full finalize.
      for (const [childId, recordedAtUs] of referenced) {
        if (presentChildIds.includes(childId)) continue;
        if (getReaderCheckpoint(db, sessionId, childId)) continue;
        combinedDiagnostics.push(`missing_child:${childId}`);
        const { event } = buildTapeEvent({
          kind: "capture.gap",
          payload: { code: "missing_child", subagent_id: childId },
          payloadType: null,
          recordType: "gap",
          sequence: null,
          ts: isoFromUs(recordedAtUs),
          recordKey: `muse:${sessionId}:gap:missing-child:${childId}`,
          links: { ...emptyLinks(), subagent_id: childId, parent_session_id: sessionId },
          diagnostics: ["missing_child"],
          sessionId,
          projectId,
          build: null,
          observedAt,
          tapeSeq: combined.length,
          schema: null,
          origin: "live",
        });
        combined.push(event);
      }
      pruneReaderCheckpoints(db, sessionId, presentChildIds);
      if (combined.length === 0 && !isNewSession) {
        stable.set(sessionFile, laneFailed ? 0 : (stable.get(sessionFile) ?? 0) + 1);
        continue;
      }
      // Quality is sticky: a partial tape never heals, but a degraded
      // hook-only session adopts native capture once the log arrives.
      let quality: CaptureQuality = combinedPartial ? "partial" : "full";
      if (summary?.captureQuality === "partial") quality = "partial";
      // Surface tail diagnostics in daemon logs: per-event diagnostics live
      // on the tape and gaps get their own capture.gap events, but
      // session-level notes would otherwise be invisible. Bounded: only logs
      // when new bytes were ingested.
      if (combinedDiagnostics.length > 0) {
        log.info(
          { session_id: sessionId, diagnostics: combinedDiagnostics },
          "muse finalize diagnostics",
        );
      }
      const tapePath = join(dataDir, "projects", projectId, "sessions", sessionId, "tape.jsonl");
      mkdirSync(dirname(tapePath), { recursive: true });
      upsertProject(db, {
        id: projectId,
        root: identity.canonicalRoot,
        remoteUrl: identity.remoteUrl,
        name: basename(identity.canonicalRoot),
      });
      const snapshotRoot = findRepositoryRoot(workspaceRoot) ?? identity.canonicalRoot;
      const preexisting = getSessionEventIds(db, sessionId);
      let snapshotDegraded = false;
      upsertSession(db, {
        id: sessionId,
        projectId,
        agent: "muse",
        model: null,
        directory: workspaceRoot,
        title: null,
        startedAt: isNewSession
          ? (combined[0]?.ts ?? null)
          : (summary?.startedAt ?? combined[0]?.ts ?? null),
        tapePath,
        captureQuality: quality,
      });
      // Pin what produced this tape. The export schema version is filled in
      // by the reconcile path; live polls preserve whatever is already there.
      upsertSessionBuildPin(db, {
        sessionId,
        museVersion: currentMuseVersion(),
        adapterVersion: ADAPTER_VERSION,
        exportSchemaVersion: getSessionBuildPin(db, sessionId)?.exportSchemaVersion ?? null,
        observedAt,
      });
      if (latestSnapshot(db, sessionId, "baseline") === null) {
        const snap = await takeLiveSnapshot({
          sessionId,
          projectId,
          tapePath,
          root: snapshotRoot,
          trigger: "baseline",
          key: "initial",
          observedAt,
        });
        result.eventsAdded += snap.added;
        // A baseline taken after events already exist cannot recover the true
        // pre-session state, so the session stays partial.
        if (snap.failed || preexisting.size > 0) snapshotDegraded = true;
      }
      const existing = getSessionEventIds(db, sessionId);
      const fresh = combined.filter((event: TapeEvent) => !existing.has(event.event_id));
      if (fresh.length > 0) {
        result.eventsAdded += persistFresh(sessionId, tapePath, fresh);
        result.capturedSessions += 1;
      }
      const latestTool = [...fresh]
        .reverse()
        .find((event) => event.kind === "tool.completed" || event.kind === "tool.failed");
      if (latestTool) {
        const snap = await takeLiveSnapshot({
          sessionId,
          projectId,
          tapePath,
          root: snapshotRoot,
          trigger: "tool.post",
          key: latestTool.event_id,
          observedAt,
        });
        result.eventsAdded += snap.added;
        if (snap.failed) snapshotDegraded = true;
      }
      const sessionQuality: CaptureQuality =
        quality === "full" && !snapshotDegraded ? "full" : "partial";
      if (sessionQuality !== quality) {
        upsertSession(db, {
          id: sessionId,
          projectId,
          agent: "muse",
          model: null,
          directory: workspaceRoot,
          title: null,
          startedAt: combined[0]?.ts ?? null,
          tapePath,
          captureQuality: sessionQuality,
        });
      }
      stable.set(sessionFile, laneFailed || parentGrew ? 0 : (stable.get(sessionFile) ?? 0) + 1);
    }
    await exportOnce(result, observedAt, found);
    return result;
  }

  async function runOnce(): Promise<MuseIngestResult> {
    if (running) return emptyResult();
    running = true;
    try {
      return await scan();
    } finally {
      running = false;
    }
  }

  function start(pollMs: number): void {
    if (timer) return;
    timer = setInterval(() => {
      void runOnce()
        .then((result) => {
          if (result.eventsAdded > 0) {
            log.info({ ...result }, "ingested muse sessions");
          } else if (result.unattributed !== lastUnattributed) {
            // Unattributed spool only grows through misconfiguration; report
            // the new total once instead of spamming every poll.
            lastUnattributed = result.unattributed;
            if (result.unattributed > 0) {
              log.info(
                { unattributed: result.unattributed },
                "muse spool entries need attribution",
              );
            }
          }
        })
        .catch((error) => {
          log.error({ err: String(error) }, "muse ingest failed");
        });
    }, pollMs);
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, sessionsDir };
}
