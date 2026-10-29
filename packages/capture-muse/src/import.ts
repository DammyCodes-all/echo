import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { TapeEvent } from "@echo/contracts";
import { projectIdForDirectory } from "@echo/core";
import {
  type EchoDb,
  getSessionEventIds,
  getSessionRecordKeys,
  getSnapshotByCommit,
  insertSnapshot,
  insertStampedEvents,
  maxTapeSeq,
  openEchoDb,
  upsertProject,
  upsertSession,
} from "@echo/db";
import { snapshotWorkingTree } from "@echo/snapshots";
import { TapeWriter } from "@echo/tape";
import { finalizeMuseSession } from "./finalize";
import { buildTapeEvent, emptyLinks } from "./map";

export interface MuseImportRequest {
  dataDir: string;
  /** Resolve `<sessionsDir>/YYYY/MM/DD/<sessionId>/session.jsonl`. */
  sessionId?: string;
  /** Direct path to a native session.jsonl. Overrides sessionId resolution. */
  path?: string;
  sessionsDir?: string;
  /** Working-tree root to attribute and snapshot. Extracted from the log when omitted. */
  projectRoot?: string;
  /** Optional already-redacted export file to reconcile (never written raw). */
  exportPath?: string;
  observedAt?: Date;
}

export interface MuseImportResult {
  sessionId: string;
  projectId: string;
  tapePath: string;
  eventsAdded: number;
  snapshotCommit: string;
  quality: "import_only";
  diagnostics: string[];
}

function defaultSessionsDir(): string {
  if (process.env.MUSE_SESSIONS_DIR) return process.env.MUSE_SESSIONS_DIR;
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "muse", "sessions");
}

function findSessionLog(sessionsDir: string, sessionId: string): string | null {
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
      try {
        const stat = statSync(abs);
        if (stat.isDirectory()) stack.push(abs);
        else if (entry === "session.jsonl" && basename(dirname(abs)) === sessionId) found.push(abs);
      } catch {}
    }
  }
  return found.sort()[0] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Attribution without guessing: only explicit workspace markers count. A log
// without one cannot be tied to a project, so the caller refuses instead of
// snapshotting the wrong tree.
//
// Observed marker shapes (Oct 28, 2026 logs): a `route_facts` record carries
// the launch cwd at payload.record.cwd, and session metadata/intake records
// carry payload.<*>.workspace_root at varying depths. Frame envelopes wrap
// real records in children[].record_json. The legacy top-level paths stay
// for fixture/spool compatibility.
function candidateRecords(parsed: unknown): Record<string, unknown>[] {
  if (!isRecord(parsed)) return [];
  const out = [parsed];
  const children = parsed.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (!isRecord(child) || typeof child.record_json !== "string") continue;
      try {
        const inner: unknown = JSON.parse(child.record_json);
        if (isRecord(inner)) out.push(inner);
      } catch {
        // Unparseable children are not evidence.
      }
    }
  }
  return out;
}

// Bounded exact-key search: the key name is fixed, only the depth varies.
function nestedRoots(payload: Record<string, unknown>): string[] {
  const found: string[] = [];
  let visited = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  while (stack.length > 0 && visited < 1000) {
    const current = stack.pop() as { value: unknown; depth: number };
    visited += 1;
    if (!isRecord(current.value) || current.depth > 6) continue;
    for (const [key, value] of Object.entries(current.value)) {
      if (key === "workspace_root" && typeof value === "string" && value.length > 0) {
        found.push(value);
      } else if (isRecord(value)) {
        stack.push({ value, depth: current.depth + 1 });
      } else if (Array.isArray(value)) {
        for (const entry of value) {
          if (isRecord(entry)) stack.push({ value: entry, depth: current.depth + 1 });
        }
      }
    }
  }
  return found;
}

export function extractWorkspaceRoot(content: string): string | null {
  const nested = new Set<string>();
  for (const line of content.split("\n", 200)) {
    if (!line.includes("workspace_root") && !line.includes("route_facts")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const record of candidateRecords(parsed)) {
      const payload = record.payload;
      if (!isRecord(payload)) continue;
      if (payload.kind === "route_facts") {
        const recordFacts = payload.record;
        if (
          isRecord(recordFacts) &&
          typeof recordFacts.cwd === "string" &&
          recordFacts.cwd.length > 0
        ) {
          return recordFacts.cwd;
        }
      }
      const metadata = payload.metadata;
      if (
        isRecord(metadata) &&
        typeof metadata.workspace_root === "string" &&
        metadata.workspace_root.length > 0
      ) {
        return metadata.workspace_root;
      }
      const facts = payload.route_facts;
      if (isRecord(facts) && typeof facts.cwd === "string" && facts.cwd.length > 0)
        return facts.cwd;
      for (const root of nestedRoots(payload)) nested.add(root);
    }
  }
  // One workspace per session: conflicting roots mean ambiguity, not a choice.
  return nested.size === 1 ? ([...nested][0] ?? null) : null;
}

function readChildContents(sessionFile: string): Array<{ id: string; content: string }> {
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
      out.push({ id: child, content: readFileSync(log, "utf8") });
    } catch {
      // Unreadable child logs surface as missing_child gaps during finalize.
    }
  }
  return out;
}

// The prior final-snapshot commit, looked up by record key directly: paging
// the timeline (LIMIT 1000) would miss it on large sessions and stack a
// duplicate snapshot on re-import.
function findPriorSnapshotCommit(
  db: EchoDb,
  sessionId: string,
  snapshotRecordKey: string,
): string | null {
  if (!getSessionRecordKeys(db, sessionId).has(snapshotRecordKey)) return null;
  const found = db
    .prepare(
      "SELECT payload_json FROM events WHERE session_id = ? AND record_key = ? ORDER BY tape_seq DESC LIMIT 1",
    )
    .get(sessionId, snapshotRecordKey) as { payload_json: string } | undefined;
  if (!found) return null;
  try {
    const commit = (JSON.parse(found.payload_json) as { commit_oid?: unknown }).commit_oid;
    return typeof commit === "string" ? commit : null;
  } catch {
    return null;
  }
}

// One-shot import of an existing native session: read the log (+ redacted
// export if provided), take a single final working-tree snapshot, and mark
// the session import_only. There are no intermediate snapshots by
// construction — replay must say so, never imply them.
export async function importMuseSession(request: MuseImportRequest): Promise<MuseImportResult> {
  if (!request.sessionId && !request.path) {
    throw new Error("import needs a session id or a native log path");
  }
  let sessionFile: string | null = request.path ? resolve(request.path) : null;
  if (!sessionFile && request.sessionId) {
    sessionFile = findSessionLog(request.sessionsDir ?? defaultSessionsDir(), request.sessionId);
  }
  if (!sessionFile || !existsSync(sessionFile)) {
    throw new Error(`muse log not found for session ${request.sessionId ?? request.path}`);
  }
  let liveContent: string;
  try {
    liveContent = readFileSync(sessionFile, "utf8");
  } catch {
    throw new Error(`muse log unreadable: ${sessionFile}`);
  }
  const sessionId = request.sessionId ?? basename(dirname(sessionFile));
  const projectRoot = request.projectRoot ?? extractWorkspaceRoot(liveContent);
  if (!projectRoot) {
    throw new Error(
      `cannot attribute ${sessionId} to a project (no workspace marker); pass --project`,
    );
  }

  let exportDoc: unknown;
  let exportUnreadable = false;
  if (request.exportPath) {
    try {
      exportDoc = JSON.parse(readFileSync(resolve(request.exportPath), "utf8"));
    } catch {
      exportUnreadable = true;
    }
  }

  let projectId = projectIdForDirectory(resolve(projectRoot));
  const observedIso = (request.observedAt ?? new Date()).toISOString();

  const db = openEchoDb(join(request.dataDir, "echo.sqlite"));
  // Adopt the canonical row for this root (a live adapter may have already
  // claimed it under a remote-based id) before any tape path is computed.
  projectId = upsertProject(db, {
    id: projectId,
    root: resolve(projectRoot),
    name: basename(projectRoot),
  });
  const shadowDir = join(request.dataDir, "projects", projectId, "shadow.git");
  const tapePath = join(
    request.dataDir,
    "projects",
    projectId,
    "sessions",
    sessionId,
    "tape.jsonl",
  );

  try {
    mkdirSync(dirname(tapePath), { recursive: true });
    // Session row first: snapshots and events both reference it.
    upsertSession(db, {
      id: sessionId,
      projectId,
      agent: "muse",
      model: null,
      directory: resolve(projectRoot),
      title: null,
      startedAt: null,
      tapePath,
      // The spec-mandated constant for the import path, not a recomputation.
      captureQuality: "import_only",
    });

    // One final snapshot per import: a repeated import reuses the prior
    // commit instead of stacking snapshots, so re-imports are a no-op when
    // the log is unchanged.
    const snapshotRecordKey = `muse:${sessionId}:snapshot:final:import`;
    let snapshotCommit: string;
    let report: { status: "ok" | "partial"; diagnostics: string[] };
    let snapshotEvent: TapeEvent | null = null;
    const priorCommit = findPriorSnapshotCommit(db, sessionId, snapshotRecordKey);
    const priorRow = priorCommit === null ? null : getSnapshotByCommit(db, sessionId, priorCommit);
    if (priorRow) {
      snapshotCommit = priorRow.commitOid;
      report = {
        status: priorRow.status === "ok" ? "ok" : "partial",
        diagnostics: priorRow.diagnostics,
      };
    } else {
      // The single final snapshot comes first so its report feeds the same
      // quality decision as live capture.
      const snapshot = await snapshotWorkingTree({
        shadowDir,
        sessionId,
        projectId,
        trigger: "final",
        eventId: snapshotRecordKey,
        takenAt: request.observedAt ?? new Date(),
        root: resolve(projectRoot),
        dataDir: request.dataDir,
      });
      snapshotCommit = snapshot.commitOid;
      report = { status: snapshot.status, diagnostics: snapshot.diagnostics };
      snapshotEvent = buildTapeEvent({
        kind: "file.snapshot",
        payload: {
          trigger: snapshot.trigger,
          commit_oid: snapshot.commitOid,
          parent_oid: snapshot.parentOid,
          file_count: snapshot.fileCount,
          total_bytes: snapshot.totalBytes,
          status: snapshot.status,
          diagnostics: snapshot.diagnostics,
          redaction_findings: snapshot.redactionFindings,
          import_only: true,
        },
        payloadType: "snapshot",
        recordType: "echo_snapshot",
        sequence: null,
        ts: snapshot.takenAt,
        recordKey: snapshotRecordKey,
        links: { ...emptyLinks(), snapshot: { kind: "shadow", snapshot_id: snapshot.commitOid } },
        diagnostics: snapshot.diagnostics.slice(0, 16),
        sessionId,
        projectId,
        build: null,
        observedAt: observedIso,
        tapeSeq: 0,
        schema: null,
        origin: "import",
      }).event;
      insertSnapshot(db, {
        id: snapshot.commitOid,
        sessionId,
        commitOid: snapshot.commitOid,
        parentOid: snapshot.parentOid,
        trigger: snapshot.trigger,
        eventId: snapshotEvent.event_id,
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
    }

    const finalized = finalizeMuseSession({
      sessionId,
      projectId,
      build: null,
      liveContent,
      childContents: readChildContents(sessionFile),
      exportDoc,
      observedAt: new Date(observedIso),
      snapshotReport: report,
    });
    // Refresh the session row now that the tape start is known. Quality stays
    // the import_only constant from the early upsert.
    upsertSession(db, {
      id: sessionId,
      projectId,
      agent: "muse",
      model: null,
      directory: resolve(projectRoot),
      title: null,
      startedAt: finalized.events[0]?.ts ?? null,
      tapePath,
      captureQuality: "import_only",
    });

    const events = snapshotEvent ? [...finalized.events, snapshotEvent] : [...finalized.events];
    const existing = getSessionEventIds(db, sessionId);
    const fresh = events.filter((event) => !existing.has(event.event_id));
    let eventsAdded = 0;
    if (fresh.length > 0) {
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
      eventsAdded = insertStampedEvents(db, sessionId, fresh);
    }
    const diagnostics = [...finalized.diagnostics];
    if (exportUnreadable) diagnostics.push("export_unreadable");
    return {
      sessionId,
      projectId,
      tapePath,
      eventsAdded,
      snapshotCommit,
      quality: "import_only",
      diagnostics,
    };
  } finally {
    db.close();
  }
}
