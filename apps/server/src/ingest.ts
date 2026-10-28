import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  importOpenCodeSession,
  listOpenCodeSessions,
  readOpenCodeSession,
  sessionModelLabel,
} from "@echo/capture-opencode";
import { loadEchoConfig } from "@echo/config";
import type { CaptureQuality, TapeEvent } from "@echo/contracts";
import {
  type EchoDb,
  getSessionEventIds,
  getSessionRecordKeys,
  insertSnapshot,
  insertStampedEvents,
  latestSnapshot,
  maxSourceSequence,
  maxTapeSeq,
  type SnapshotInsert,
  upsertProject,
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

  async function scan(): Promise<IngestRunResult> {
    const result = emptyResult();
    const config = loadEchoConfig();
    if (config.projects.length === 0) return result;
    if (!config.opencode_db || !existsSync(config.opencode_db)) return result;

    const store = new DatabaseSync(config.opencode_db, { readOnly: true });
    try {
      const listed = listOpenCodeSessions(store);
      result.scanned = listed.length;
      for (const summary of listed) {
        if (!summary.directory) continue;
        const directory = summary.directory;
        const identity = await resolveRepositoryIdentity(directory);
        if (!projectEnabled(directory, config.projects)) continue;
        const session = readOpenCodeSession(store, summary.id);
        if (!session?.directory) continue;

        const imported = importOpenCodeSession(store, session, new Date(), {
          projectId: identity.projectId,
        });
        const observedAt = new Date().toISOString();
        const tapePath = join(
          dataDir,
          "projects",
          imported.projectId,
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
              projectId: imported.projectId,
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
              projectId: imported.projectId,
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
        const shadowDir = join(dataDir, "projects", imported.projectId, "shadow.git");
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
            projectId: imported.projectId,
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
              projectId: imported.projectId,
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

        if (imported.baselineOid !== null && latestSnapshot(db, session.id, "baseline") === null) {
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

        upsertProject(db, {
          id: identity.projectId,
          root: identity.canonicalRoot,
          remoteUrl: identity.remoteUrl,
          name: basename(identity.canonicalRoot),
        });
        upsertSession(db, {
          id: session.id,
          projectId: imported.projectId,
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
      }
    } finally {
      store.close();
    }
    return result;
  }

  async function runOnce(): Promise<IngestRunResult> {
    if (running) return emptyResult();
    running = true;
    try {
      return await scan();
    } finally {
      running = false;
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

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop };
}
