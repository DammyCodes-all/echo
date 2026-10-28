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
  type ReaderCheckpoint,
  getReaderCheckpoint,
  getSession,
  getSessionEventIds,
  getSessionSummary,
  hasEventKind,
  insertStampedEvents,
  maxTapeSeq,
  pruneReaderCheckpoints,
  upsertProject,
  upsertReaderCheckpoint,
  upsertSession,
} from "@echo/db";
import { findRepositoryRoot } from "@echo/snapshots";
import { TapeWriter } from "@echo/tape";
import {
  ensureBaselineSnapshot,
  type HookTrigger,
  handleHookTriggerSnapshots,
  maybeFinalSnapshot,
} from "./muse-snapshots";

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

// Project identity is shared with the OpenCode adapter via
// projectIdForDirectory: identical inputs join. Note the OpenCode mapper
// hashes the agent's session directory, so a session run in a subdirectory
// joins under a different id there; Muse ingest always resolves to the
// enabled project root first.

function isUnder(directory: string, root: string): boolean {
  const normalizedDirectory = resolve(directory);
  const normalizedRoot = resolve(root);
  return (
    normalizedDirectory === normalizedRoot || normalizedDirectory.startsWith(normalizedRoot + sep)
  );
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
      referenced: Map<string, number>;
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

  // Hook spool drain. Runs before the log scan so a hook-only session gets a
  // minimal row first and the scan's upsert enriches it afterwards — never the
  // reverse. Files are deleted only after a successful insert; a crash between
  // the two replays into the same deterministic event ids and dedupes.
  // Returns the newly ingested hook events so the caller can take trigger
  // snapshots (baseline / tool.pre / tool.post / batch.post) after the drain.
  function drainSpool(result: MuseIngestResult, observedIso: string): HookTrigger[] {
    const drained: HookTrigger[] = [];
    const root = spoolRoot(dataDir);
    let dirs: string[];
    try {
      dirs = readdirSync(root).sort();
    } catch {
      return drained; // no spool yet
    }
    let processed = 0;
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
        if (processed >= MAX_SPOOL_PER_POLL) return drained;
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
        if (
          !sessionId ||
          !projectRoot ||
          !projects.some((candidate) => isUnder(projectRoot, candidate))
        ) {
          result.unattributed += 1;
          continue; // leave on disk; the write-time cap bounds it
        }
        // Budget covers only entries that reach ingestion: files that can
        // never drain must not starve drainable ones behind the cap.
        processed += 1;
        const projectId = projectIdForDirectory(resolve(projectRoot));
        const tapePath = join(dataDir, "projects", projectId, "sessions", sessionId, "tape.jsonl");
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
              root: resolve(projectRoot),
              name: basename(projectRoot),
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
          drained.push({
            sessionId,
            projectId,
            root: resolve(projectRoot),
            kind: event.kind,
            toolName: entry.toolName,
            eventId: event.event_id,
            isNewSession,
          });
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
    return drained;
  }

  // Snapshot triggers for newly drained hook events: baseline once per
  // first-seen session plus tool.pre/post and batch.post per hook event.
  // Hook triggers share one per-poll snapshot budget (baselines and finals
  // are exempt); beyond it, misses are recorded as budget gaps, never thrown.
  async function snapshotDrainedHooks(
    drained: HookTrigger[],
    result: MuseIngestResult,
    observedIso: string,
  ): Promise<void> {
    const batch = await handleHookTriggerSnapshots({ dataDir, db, log }, drained, observedIso);
    result.eventsAdded += batch.eventsAdded;
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
          upsertSession(db, {
            id: sessionId,
            projectId: row.projectId,
            agent: "muse",
            model: null,
            directory: extractWorkspaceRoot(content),
            title: null,
            startedAt: finalized.events[0]?.ts ?? null,
            tapePath,
            captureQuality: finalized.quality,
          });
          result.reconciled += 1;
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
    const drained = drainSpool(result, observedAt);
    await snapshotDrainedHooks(drained, result, observedAt);
    if (!existsSync(sessionsDir)) return result;
    const found = new Set(walkSessionLogs(sessionsDir));
    for (const key of seen.keys()) {
      if (!found.has(key)) seen.delete(key);
    }
    for (const key of stable.keys()) {
      if (!found.has(key)) stable.delete(key);
    }
    for (const sessionFile of found) {
      result.scanned += 1;
      let fingerprint: { size: number; mtimeMs: number };
      try {
        const stat = statSync(sessionFile);
        fingerprint = { size: stat.size, mtimeMs: stat.mtimeMs };
      } catch (error) {
        log.error({ err: String(error), session_file: sessionFile }, "muse log unreadable");
        continue;
      }
      if (fingerprint.size > MAX_LOG_BYTES) {
        result.skipped += 1;
        continue;
      }
      const previous = seen.get(sessionFile);
      if (
        previous !== undefined &&
        previous.size === fingerprint.size &&
        previous.mtimeMs === fingerprint.mtimeMs
      ) {
        stable.set(sessionFile, (stable.get(sessionFile) ?? 0) + 1);
        continue;
      }
      let content: string;
      try {
        content = readFileSync(sessionFile, "utf8");
      } catch (error) {
        log.error({ err: String(error), session_file: sessionFile }, "muse log unreadable");
        continue;
      }
      const workspaceRoot = extractWorkspaceRoot(content);
      if (!workspaceRoot) {
        result.skipped += 1;
        seen.set(sessionFile, fingerprint);
        continue;
      }
      const root = projects.find((candidate) => isUnder(workspaceRoot, candidate));
      if (!root) {
        result.skipped += 1;
        seen.set(sessionFile, fingerprint);
        continue;
      }
      const sessionId = basename(dirname(sessionFile));
      const projectId = projectIdForDirectory(resolve(root));
      let finalized: ReturnType<typeof finalizeMuseSession> | undefined;
      try {
        finalized = finalizeMuseSession({
          sessionId,
          projectId,
          build: null,
          liveContent: content,
          childContents: childContents(sessionFile),
          observedAt: new Date(observedAt),
        });
      } catch (error) {
        log.error({ err: String(error), session_id: sessionId }, "muse finalize failed");
        stable.set(sessionFile, 0);
        continue;
      }
      const quality: CaptureQuality = finalized.quality;
      // Surface finalize diagnostics in daemon logs: per-event diagnostics live
      // on the tape and gaps get their own capture.gap events, but session-level
      // notes would otherwise be invisible. Bounded: finalize runs only when the
      // log changed.
      if (finalized.diagnostics.length > 0) {
        log.info(
          { session_id: sessionId, diagnostics: finalized.diagnostics },
          "muse finalize diagnostics",
        );
      }
      const tapePath = join(dataDir, "projects", projectId, "sessions", sessionId, "tape.jsonl");
      mkdirSync(dirname(tapePath), { recursive: true });
      const isNewSession = !getSession(db, sessionId);
      upsertProject(db, { id: projectId, root: resolve(root), name: basename(root) });
      upsertSession(db, {
        id: sessionId,
        projectId,
        agent: "muse",
        model: null,
        directory: workspaceRoot,
        title: null,
        startedAt: finalized.events[0]?.ts ?? null,
        tapePath,
        captureQuality: quality,
      });
      const existing = getSessionEventIds(db, sessionId);
      const fresh = finalized.events.filter((event: TapeEvent) => !existing.has(event.event_id));
      if (fresh.length > 0) {
        result.eventsAdded += persistFresh(sessionId, tapePath, fresh);
        result.capturedSessions += 1;
      }
      // First-seen session via the native log (the wrapper or SessionStart hook
      // may have missed it): exactly one baseline via latestSnapshot dedupe.
      if (isNewSession) {
        try {
          const snapRoot = findRepositoryRoot(workspaceRoot) ?? resolve(root);
          const baseline = await ensureBaselineSnapshot(
            { dataDir, db, log },
            { sessionId, projectId, root: snapRoot, observedAt },
          );
          result.eventsAdded += baseline.eventsAdded;
        } catch (error) {
          log.error({ err: String(error), session_id: sessionId }, "muse baseline failed");
        }
      }
      seen.set(sessionFile, fingerprint);
      stable.set(sessionFile, 0);
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

  return { runOnce, start, stop };
}
