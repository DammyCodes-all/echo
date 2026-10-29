import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  importOpenCodeSession,
  listOpenCodeSessions,
  type OpenCodeSessionSummary,
  readOpenCodeSession,
  sessionModelLabel,
} from "@echo/capture-opencode";
import { loadEchoConfig } from "@echo/config";
import type { CaptureQuality, TapeEvent } from "@echo/contracts";
import {
  deleteEchoSession,
  type EchoDb,
  ensureIngestProject,
  getSession,
  getSessionEventIds,
  getSessionRecordKeys,
  insertSnapshot,
  insertStampedEvents,
  latestSnapshot,
  maxSourceSequence,
  maxTapeSeq,
  type SnapshotInsert,
  sessionHasUserData,
  upsertSession,
} from "@echo/db";
import {
  findRepositoryRoot,
  resolveRepositoryIdentity,
  type SnapshotResult,
  snapshotGitTree,
  snapshotWorkingTree,
} from "@echo/snapshots";
import { TapeWriter } from "@echo/tape";
import { ensureEnabledProjects } from "./enabled-projects";
import { makeGapEvent, makeSnapshotEvent, makeSnapshotEventId } from "./tape-events";

export interface IngestLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export interface IngestOptions {
  dataDir: string;
  db: EchoDb;
  log: IngestLogger;
  /**
   * Fire-and-forget hook when a session's final snapshot is persisted.
   * Must never throw or block: the caller owns async errors.
   */
  onSessionQuiescent?: (sessionId: string) => void;
}

export interface IngestRunResult {
  scanned: number;
  capturedSessions: number;
  eventsAdded: number;
  snapshotsTaken: number;
}

function isUnder(directory: string, root: string): boolean {
  const normalizedDirectory = resolve(directory);
  const normalizedRoot = resolve(root);
  return (
    normalizedDirectory === normalizedRoot || normalizedDirectory.startsWith(normalizedRoot + sep)
  );
}

function projectEnabled(startDir: string, projects: string[]): boolean {
  // The allowlist is about where the agent ran: enabling `/repo/docs` must
  // not capture `/repo/other`, even though both resolve to one project.
  return projects.some((candidate) => isUnder(startDir, candidate));
}

function emptyResult(): IngestRunResult {
  return { scanned: 0, capturedSessions: 0, eventsAdded: 0, snapshotsTaken: 0 };
}

export function createIngest({ dataDir, db, log, onSessionQuiescent }: IngestOptions) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;
  let inflight: Promise<IngestRunResult> | null = null;

  async function scan(): Promise<IngestRunResult> {
    const result = emptyResult();
    const config = loadEchoConfig();
    if (config.projects.length === 0) return result;
    // Enabled but sessionless repos still get their folder (empty state).
    await ensureEnabledProjects(db, config.projects, log);
    if (!config.opencode_db || !existsSync(config.opencode_db)) return result;

    const store = new DatabaseSync(config.opencode_db, { readOnly: true });

    // Fold one Task-spawned child into its parent's tape. No session row,
    // no snapshots: the parent's triggers cover the shared tree, and the
    // lane keys dedupe against the parent tape across polls.
    function ingestSubagentLane(child: OpenCodeSessionSummary): void {
      if (!child.directory || !child.parentId) return;
      if (!projectEnabled(child.directory, config.projects)) return;
      const parentId = child.parentId;
      const parentRow = getSession(db, parentId);
      if (!parentRow) {
        // Parent filtered out (disabled project) or not yet ingested: never
        // invent a session for the child. It retries once the parent lands.
        log.info(
          { session_id: child.id, parent_session_id: parentId },
          "opencode subagent without ingested parent, skipping",
        );
        return;
      }
      // Pre-lane orphans: rows minted for children before lane ingest
      // existed. The import below restores their history on the parent
      // lane; remove the row only when the user never touched it. Touched
      // orphans stay as their own cards and skip the lane to avoid showing
      // the same evidence twice.
      if (getSession(db, child.id)) {
        if (sessionHasUserData(db, child.id)) {
          log.info(
            { session_id: child.id },
            "opencode subagent row has user data, keeping card and skipping lane",
          );
          return;
        }
        deleteEchoSession(db, child.id);
        try {
          rmSync(join(dataDir, "projects", parentRow.projectId, "sessions", child.id), {
            recursive: true,
            force: true,
          });
        } catch (error) {
          log.error(
            { err: String(error), session_id: child.id },
            "orphan subagent dir not removed",
          );
        }
      }
      const imported = importOpenCodeSession(store, child, new Date(), {
        projectId: parentRow.projectId,
        lane: { parentSessionId: parentId, subagentId: child.id },
      });
      const tapePath = join(
        dataDir,
        "projects",
        parentRow.projectId,
        "sessions",
        parentId,
        "tape.jsonl",
      );
      mkdirSync(dirname(tapePath), { recursive: true });
      // No sequence-reset/vanished checks here: child message seqs restart
      // at 1 and lane keys are namespaced, so parent-domain comparisons
      // would false-positive on every poll.
      const existing = getSessionEventIds(db, parentId);
      const fresh = imported.events.filter((event) => !existing.has(event.event_id));
      if (fresh.length > 0) {
        let seq = maxTapeSeq(db, parentId);
        const writer = new TapeWriter(tapePath);
        try {
          for (const event of fresh) {
            seq += 1;
            event.tape_seq = seq;
            writer.append(event);
          }
          writer.flush();
        } finally {
          writer.close();
        }
        result.eventsAdded += insertStampedEvents(db, parentId, fresh);
        if (onSessionQuiescent) {
          try {
            onSessionQuiescent(parentId);
          } catch (error) {
            log.error({ err: String(error), session_id: parentId }, "story hook failed");
          }
        }
      }
    }

    try {
      const listed = listOpenCodeSessions(store);
      result.scanned = listed.length;
      // Subagent sessions (Task-spawned children) are folded into their
      // parent's tape as a subagent lane, never as their own cards. Parents
      // may sort after their children (time_created DESC), so ingest roots
      // first, then children oldest-first so nested lanes resolve bottom-up.
      const roots = listed.filter((summary) => !summary.parentId);
      const lanes = listed
        .filter((summary) => summary.parentId)
        .sort((a, b) => (a.timeCreated ?? 0) - (b.timeCreated ?? 0));
      for (const summary of [...roots, ...lanes]) {
        try {
          if (!summary.directory) continue;
          if (summary.parentId) {
            ingestSubagentLane(summary);
            continue;
          }
          const directory = summary.directory;
          const identity = await resolveRepositoryIdentity(directory);
          if (!projectEnabled(directory, config.projects)) continue;
          const session = readOpenCodeSession(store, summary.id);
          if (!session?.directory) continue;

          // Same repo keeps its historic id across remote adds/removes and
          // folder moves (one row per repository); the returned id is what
          // sessions, tapes and snapshots must use.
          const projectId = ensureIngestProject(db, {
            id: identity.projectId,
            root: identity.canonicalRoot,
            remoteUrl: identity.remoteUrl,
            name: basename(identity.canonicalRoot),
          });

          const imported = importOpenCodeSession(store, session, new Date(), {
            projectId,
          });
          const observedAt = new Date().toISOString();
          const tapePath = join(
            dataDir,
            "projects",
            projectId,
            "sessions",
            session.id,
            "tape.jsonl",
          );
          mkdirSync(dirname(tapePath), { recursive: true });

          const synthetic: TapeEvent[] = [];
          const previousMax = maxSourceSequence(db, session.id);
          const currentMax = imported.events.reduce<number | null>((max, event) => {
            if (event.source.sequence === null) return max;
            return max === null ? event.source.sequence : Math.max(max, event.source.sequence);
          }, null);
          if (previousMax !== null && currentMax !== null && currentMax < previousMax) {
            synthetic.push(
              makeGapEvent({
                agent: "opencode",
                sessionId: session.id,
                projectId: projectId,
                observedAt,
                key: `sequence-reset:${previousMax}:${currentMax}`,
                code: "sequence_reset",
                detail: { previous_max: previousMax, current_max: currentMax },
              }),
            );
          }
          const previousKeys = getSessionRecordKeys(db, session.id);
          const currentKeys = new Set(
            imported.events
              .map((event) => event.record_key)
              .filter((key): key is string => key !== null),
          );
          const vanished = [...previousKeys].filter((key) => !currentKeys.has(key)).sort();
          if (vanished.length > 0) {
            synthetic.push(
              makeGapEvent({
                agent: "opencode",
                sessionId: session.id,
                projectId: projectId,
                observedAt,
                key: `vanished:${vanished.join(",")}`,
                code: "source_replaced",
                detail: {
                  vanished_count: vanished.length,
                  names: vanished.slice(0, 10),
                },
              }),
            );
          }

          const snapshotEvents: TapeEvent[] = [];
          const snapshotRows: SnapshotInsert[] = [];
          let snapshotsTaken = 0;
          let snapshotFailed = false;
          const shadowDir = join(dataDir, "projects", projectId, "shadow.git");
          const snapshotRoot = findRepositoryRoot(session.directory) ?? identity.canonicalRoot;
          const existingIds = getSessionEventIds(db, session.id);

          const takeSnapshot = async (input: {
            trigger: "baseline" | "final";
            key: string;
            sourceOid?: string;
          }): Promise<void> => {
            const eventId = makeSnapshotEventId(session.id, input.trigger, input.key);
            if (existingIds.has(eventId)) return;
            const common = {
              shadowDir,
              sessionId: session.id,
              projectId: projectId,
              trigger: input.trigger,
              eventId,
              takenAt: new Date(),
            };
            const snapshot: SnapshotResult = input.sourceOid
              ? await snapshotGitTree({
                  ...common,
                  sourceRoot: snapshotRoot,
                  sourceOid: input.sourceOid,
                })
              : await snapshotWorkingTree({ ...common, root: snapshotRoot, dataDir });
            snapshotEvents.push(
              makeSnapshotEvent({
                agent: "opencode",
                sessionId: session.id,
                projectId: projectId,
                eventId,
                observedAt,
                result: snapshot,
              }),
            );
            snapshotRows.push({
              id: snapshot.commitOid,
              sessionId: session.id,
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
            existingIds.add(eventId);
            snapshotsTaken += 1;
          };

          if (
            imported.baselineOid !== null &&
            latestSnapshot(db, session.id, "baseline") === null
          ) {
            try {
              await takeSnapshot({
                trigger: "baseline",
                key: imported.baselineOid,
                sourceOid: imported.baselineOid,
              });
            } catch (error) {
              snapshotFailed = true;
              log.error(
                { err: String(error), session_id: session.id, trigger: "baseline" },
                "shadow snapshot failed",
              );
            }
          }

          const boundaryTs = imported.events.reduce<string | null>((max, event) => {
            if (event.kind !== "turn.ended" && event.kind !== "turn.failed") return max;
            return max === null || event.ts > max ? event.ts : max;
          }, null);
          const lastFinal = latestSnapshot(db, session.id, "final");
          if (boundaryTs !== null && (lastFinal === null || boundaryTs > lastFinal.takenAt)) {
            try {
              await takeSnapshot({ trigger: "final", key: boundaryTs });
            } catch (error) {
              snapshotFailed = true;
              log.error(
                { err: String(error), session_id: session.id, trigger: "final" },
                "shadow snapshot failed",
              );
            }
          }

          let quality: CaptureQuality = imported.quality;
          const snapshotPartial = snapshotEvents.some(
            (event) => (event.payload as { status?: string }).status === "partial",
          );
          if (synthetic.length > 0 || snapshotFailed || snapshotPartial) quality = "partial";

          upsertSession(db, {
            id: session.id,
            projectId,
            agent: "opencode",
            model: sessionModelLabel(session.model),
            directory: session.directory,
            title: session.title,
            startedAt:
              session.timeCreated === null ? null : new Date(session.timeCreated).toISOString(),
            tapePath,
            captureQuality: quality,
          });

          const started = imported.events[0];
          const rest = imported.events.slice(1);
          const baselineEvents = snapshotEvents.filter(
            (event) => (event.payload as { trigger?: string }).trigger === "baseline",
          );
          const finalEvents = snapshotEvents.filter(
            (event) => (event.payload as { trigger?: string }).trigger !== "baseline",
          );
          const all = [
            ...(started ? [started] : []),
            ...baselineEvents,
            ...rest,
            ...synthetic,
            ...finalEvents,
          ];

          const existing = getSessionEventIds(db, session.id);
          const fresh = all.filter((event) => !existing.has(event.event_id));
          if (fresh.length > 0) {
            let seq = maxTapeSeq(db, session.id);
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
            result.eventsAdded += insertStampedEvents(db, session.id, fresh);
            result.capturedSessions += 1;
          }
          for (const row of snapshotRows) insertSnapshot(db, row);
          result.snapshotsTaken += snapshotsTaken;
          if (onSessionQuiescent) {
            try {
              onSessionQuiescent(session.id);
            } catch (error) {
              log.error({ err: String(error), session_id: session.id }, "story hook failed");
            }
          }
        } catch (error) {
          // One poison session must not starve the rest of the poll: the throw
          // above (identity migration, snapshot, tape write) used to abort the
          // whole scan, hiding every session behind it.
          log.error(
            { err: String(error), session_id: summary.id },
            "opencode session ingest failed, skipping",
          );
        }
      }
    } finally {
      store.close();
    }
    return result;
  }

  async function runOnce(): Promise<IngestRunResult> {
    if (running || stopped) return emptyResult();
    running = true;
    const current = scan();
    inflight = current;
    try {
      return await current;
    } finally {
      running = false;
      if (inflight === current) inflight = null;
    }
  }

  function start(): void {
    if (timer) return;
    const interval = loadEchoConfig().poll_interval_ms;
    timer = setInterval(() => {
      void runOnce()
        .then((result) => {
          if (result.eventsAdded > 0 || result.snapshotsTaken > 0) {
            log.info({ ...result }, "ingested opencode sessions");
          }
        })
        .catch((error) => {
          log.error({ err: String(error) }, "ingest failed");
        });
    }, interval);
  }

  async function stop(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = null;
    stopped = true;
    // Drain the in-flight poll before the caller closes the db: scan touches
    // it throughout (latestSnapshot, inserts), so closing underneath it logs
    // "database is not open". Poll errors stay owned by the poll caller.
    const current = inflight;
    if (current) {
      try {
        await current;
      } catch {
        // Ignored here; the runOnce caller already observes the failure.
      }
    }
  }

  return { runOnce, start, stop };
}
