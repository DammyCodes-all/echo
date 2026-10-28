import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildTapeEvent, emptyLinks } from "@echo/capture-muse";
import type { TapeEvent } from "@echo/contracts";
import {
  type EchoDb,
  getSessionRecordKeys,
  hasEventKind,
  insertSnapshot,
  insertStampedEvents,
  latestSnapshot,
  maxTapeSeq,
} from "@echo/db";
import {
  type SnapshotResult,
  type SnapshotTrigger,
  snapshotWorkingTree,
  type WorkingTreeSnapshotOptions,
} from "@echo/snapshots";
import { TapeWriter } from "@echo/tape";

export interface MuseSnapshotLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export interface MuseSnapshotDeps {
  dataDir: string;
  db: EchoDb;
  log: MuseSnapshotLogger;
  snapshotFn?: (options: WorkingTreeSnapshotOptions) => Promise<SnapshotResult>;
  nowFn?: () => Date;
  // Best-effort budget override for tool.pre (tests use a short budget
  // instead of sleeping through the production 500ms).
  preTimeoutMs?: number;
}

// Best-effort budget for tool.pre: the agent is waiting on the tool, so the
// daemon must not stall behind a slow snapshot. Other triggers run async.
export const TOOL_PRE_TIMEOUT_MS = 500;

// Mutating Muse tools that justify a pre-snapshot. Compared case-insensitively
// against the hook's tool_name. Shell-effect tools are included because a
// failed shell tool may still have written (ARCH §8 trigger policy).
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "apply_patch",
  "apply-patch",
  "patch",
  "bash",
  "shell",
  "exec",
  "sh",
  "run",
  "run_command",
  "command",
  "terminal",
]);

export function isMutatingTool(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  return MUTATING_TOOLS.has(toolName.toLowerCase());
}

export function snapshotRecordKey(sessionId: string, trigger: string, key: string): string {
  return `muse:${sessionId}:snapshot:${trigger}:${key}`;
}

export function snapshotGapRecordKey(sessionId: string, trigger: string, key: string): string {
  return `muse:${sessionId}:gap:snapshot-${trigger}:${key}`;
}

export interface SnapshotOutcome {
  taken: boolean;
  eventsAdded: number;
  eventId: string | null;
  commitOid: string | null;
  timedOut?: boolean;
  reason?: string;
}

function outcome(partial: Partial<SnapshotOutcome> & { taken: boolean }): SnapshotOutcome {
  return {
    eventsAdded: 0,
    eventId: null,
    commitOid: null,
    ...partial,
  };
}

// Local append path mirroring muse-ingest persistFresh: sequence from the
// current max, one fsync per batch, insert count back.
function appendFresh(
  deps: MuseSnapshotDeps,
  projectId: string,
  sessionId: string,
  events: TapeEvent[],
): number {
  if (events.length === 0) return 0;
  const tapePath = join(deps.dataDir, "projects", projectId, "sessions", sessionId, "tape.jsonl");
  mkdirSync(dirname(tapePath), { recursive: true });
  let seq = maxTapeSeq(deps.db, sessionId);
  for (const event of events) {
    seq += 1;
    event.tape_seq = seq;
  }
  const writer = new TapeWriter(tapePath);
  try {
    for (const event of events) writer.append(event);
    writer.flush();
  } finally {
    writer.close();
  }
  return insertStampedEvents(deps.db, sessionId, events);
}

interface GapInput {
  sessionId: string;
  projectId: string;
  trigger: SnapshotTrigger;
  key: string;
  observedAt: string;
  detail: Record<string, unknown>;
  diagnostics: string[];
}

// A snapshot failure is never a license to invent state: the previous snapshot
// stays current and the miss is recorded as a capture.gap (ARCH §20). The gap
// recordKey is deterministic so re-polls dedupe instead of duplicating.
function recordSnapshotGap(deps: MuseSnapshotDeps, input: GapInput): number {
  const recordKey = snapshotGapRecordKey(input.sessionId, input.trigger, input.key);
  if (getSessionRecordKeys(deps.db, input.sessionId).has(recordKey)) return 0;
  const { event } = buildTapeEvent({
    kind: "capture.gap",
    payload: { code: "hook_failure", snapshot_trigger: input.trigger, ...input.detail },
    payloadType: "snapshot",
    recordType: "gap",
    sequence: null,
    ts: input.observedAt,
    recordKey,
    links: emptyLinks(),
    diagnostics: input.diagnostics.slice(0, 16),
    sessionId: input.sessionId,
    projectId: input.projectId,
    build: null,
    observedAt: input.observedAt,
    tapeSeq: 0,
    schema: null,
    origin: "live",
  });
  return appendFresh(deps, input.projectId, input.sessionId, [event]);
}

export interface TakeSnapshotInput {
  sessionId: string;
  projectId: string;
  root: string;
  trigger: SnapshotTrigger;
  key: string;
  observedAt: string;
}

interface PersistSnapshotInput {
  sessionId: string;
  projectId: string;
  recordKey: string;
  observedAt: string;
}

// Single construction site for persisted snapshot results: tape event with
// links.snapshot plus snapshots/snapshot_files rows. Shared by the fresh,
// tool.pre and late-reconciled paths so they cannot drift apart.
function persistSnapshotResult(
  deps: MuseSnapshotDeps,
  input: PersistSnapshotInput,
  result: SnapshotResult,
): { eventsAdded: number; eventId: string; commitOid: string } {
  const { event } = buildTapeEvent({
    kind: "file.snapshot",
    payload: {
      trigger: result.trigger,
      commit_oid: result.commitOid,
      parent_oid: result.parentOid,
      file_count: result.fileCount,
      total_bytes: result.totalBytes,
      status: result.status,
      diagnostics: result.diagnostics,
      redaction_findings: result.redactionFindings,
    },
    payloadType: "snapshot",
    recordType: "echo_snapshot",
    sequence: null,
    ts: result.takenAt,
    recordKey: input.recordKey,
    links: { ...emptyLinks(), snapshot: { kind: "shadow", snapshot_id: result.commitOid } },
    diagnostics: result.diagnostics.slice(0, 16),
    sessionId: input.sessionId,
    projectId: input.projectId,
    build: null,
    observedAt: input.observedAt,
    tapeSeq: 0,
    schema: null,
    origin: "live",
  });
  const eventsAdded = appendFresh(deps, input.projectId, input.sessionId, [event]);
  insertSnapshot(deps.db, {
    id: result.commitOid,
    sessionId: input.sessionId,
    commitOid: result.commitOid,
    parentOid: result.parentOid,
    trigger: result.trigger,
    eventId: event.event_id,
    takenAt: result.takenAt,
    fileCount: result.fileCount,
    totalBytes: result.totalBytes,
    status: result.status,
    diagnostics: result.diagnostics,
    files: result.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      blobOid: file.blobOid,
      size: file.size,
      sha256: file.sha256,
      captured: file.captured,
      reason: file.reason,
    })),
  });
  return { eventsAdded, eventId: event.event_id, commitOid: result.commitOid };
}

async function takeSnapshot(
  deps: MuseSnapshotDeps,
  input: TakeSnapshotInput,
): Promise<SnapshotOutcome> {
  const recordKey = snapshotRecordKey(input.sessionId, input.trigger, input.key);
  if (getSessionRecordKeys(deps.db, input.sessionId).has(recordKey)) {
    return outcome({ taken: false, reason: "duplicate" });
  }
  const snapshotFn = deps.snapshotFn ?? snapshotWorkingTree;
  const takenAt = deps.nowFn ? deps.nowFn() : new Date();
  let result: SnapshotResult;
  try {
    result = await snapshotFn({
      shadowDir: join(deps.dataDir, "projects", input.projectId, "shadow.git"),
      sessionId: input.sessionId,
      projectId: input.projectId,
      trigger: input.trigger,
      eventId: recordKey,
      takenAt,
      root: input.root,
      dataDir: deps.dataDir,
    });
  } catch (error) {
    deps.log.error(
      { err: String(error), session_id: input.sessionId, trigger: input.trigger },
      "muse shadow snapshot failed",
    );
    const eventsAdded = recordSnapshotGap(deps, {
      sessionId: input.sessionId,
      projectId: input.projectId,
      trigger: input.trigger,
      key: input.key,
      observedAt: input.observedAt,
      detail: { error: String(error) },
      diagnostics: ["snapshot_failed"],
    });
    return outcome({ taken: false, eventsAdded, reason: "snapshot_failed" });
  }
  const persisted = persistSnapshotResult(
    deps,
    {
      sessionId: input.sessionId,
      projectId: input.projectId,
      recordKey,
      observedAt: input.observedAt,
    },
    result,
  );
  return outcome({
    taken: true,
    eventsAdded: persisted.eventsAdded,
    eventId: persisted.eventId,
    commitOid: persisted.commitOid,
  });
}

export interface BaselineInput {
  sessionId: string;
  projectId: string;
  root: string;
  observedAt: string;
}

// Exactly once per session: the wrapper's pre-spawn snapshot and the
// SessionStart hook race here, and the latestSnapshot check lets only the
// first one through.
export async function ensureBaselineSnapshot(
  deps: MuseSnapshotDeps,
  input: BaselineInput,
): Promise<SnapshotOutcome> {
  if (latestSnapshot(deps.db, input.sessionId, "baseline") !== null) {
    return outcome({ taken: false, reason: "duplicate" });
  }
  return takeSnapshot(deps, { ...input, trigger: "baseline", key: "baseline" });
}

export interface ToolTriggerInput extends BaselineInput {
  toolName: string | null;
  triggerEventId: string;
}

class SnapshotTimeoutError extends Error {
  constructor() {
    super("snapshot timed out");
    this.name = "SnapshotTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SnapshotTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// tool.pre fires only for mutating tools. On timeout the previous snapshot
// stays current and the pre-state is marked stale via a gap event.
export async function maybeToolPreSnapshot(
  deps: MuseSnapshotDeps,
  input: ToolTriggerInput,
): Promise<SnapshotOutcome> {
  if (!isMutatingTool(input.toolName)) {
    return outcome({ taken: false, reason: "non-mutating" });
  }
  const recordKey = snapshotRecordKey(input.sessionId, "tool.pre", input.triggerEventId);
  if (getSessionRecordKeys(deps.db, input.sessionId).has(recordKey)) {
    return outcome({ taken: false, reason: "duplicate" });
  }
  const snapshotFn = deps.snapshotFn ?? snapshotWorkingTree;
  const takenAt = deps.nowFn ? deps.nowFn() : new Date();
  // The timeout cannot cancel the snapshotter: the abandoned attempt keeps
  // running and its commit still lands in the shadow repo. Keep the handle so
  // the timeout branch below can reconcile a late arrival instead of leaving
  // a ref without tape/DB rows.
  const pending = snapshotFn({
    shadowDir: join(deps.dataDir, "projects", input.projectId, "shadow.git"),
    sessionId: input.sessionId,
    projectId: input.projectId,
    trigger: "tool.pre",
    eventId: recordKey,
    takenAt,
    root: input.root,
    dataDir: deps.dataDir,
  });
  try {
    const result = await withTimeout(pending, deps.preTimeoutMs ?? TOOL_PRE_TIMEOUT_MS);
    const persisted = persistSnapshotResult(
      deps,
      {
        sessionId: input.sessionId,
        projectId: input.projectId,
        recordKey,
        observedAt: input.observedAt,
      },
      result,
    );
    return outcome({
      taken: true,
      eventsAdded: persisted.eventsAdded,
      eventId: persisted.eventId,
      commitOid: persisted.commitOid,
    });
  } catch (error) {
    if (error instanceof SnapshotTimeoutError) {
      deps.log.error(
        { session_id: input.sessionId, trigger: "tool.pre" },
        "muse pre-snapshot timed out, keeping last snapshot",
      );
      const gapKey = snapshotGapRecordKey(
        input.sessionId,
        "tool.pre-timeout",
        input.triggerEventId,
      );
      let gapEvents = 0;
      let gapDuplicate = false;
      if (!getSessionRecordKeys(deps.db, input.sessionId).has(gapKey)) {
        const { event } = buildTapeEvent({
          kind: "capture.gap",
          payload: {
            code: "hook_failure",
            reason: "tool.pre-timeout",
            snapshot_trigger: "tool.pre",
            tool_name: input.toolName,
          },
          payloadType: "snapshot",
          recordType: "gap",
          sequence: null,
          ts: input.observedAt,
          recordKey: gapKey,
          links: emptyLinks(),
          diagnostics: ["tool.pre-timeout", "stale_pre_state"],
          sessionId: input.sessionId,
          projectId: input.projectId,
          build: null,
          observedAt: input.observedAt,
          tapeSeq: 0,
          schema: null,
          origin: "live",
        });
        gapEvents = appendFresh(deps, input.projectId, input.sessionId, [event]);
      } else {
        gapDuplicate = true;
      }
      // Reconcile a late arrival: if the abandoned attempt eventually
      // succeeds, its commit is already the session head, so record the
      // tape event and DB rows for it (idempotent on the recordKey). A
      // late failure needs nothing more: the gap above already covers it.
      void pending.then(
        (late) => {
          try {
            if (getSessionRecordKeys(deps.db, input.sessionId).has(recordKey)) return;
            const reconciled = persistSnapshotResult(
              deps,
              {
                sessionId: input.sessionId,
                projectId: input.projectId,
                recordKey,
                observedAt: input.observedAt,
              },
              late,
            );
            if (reconciled.eventsAdded > 0) {
              deps.log.info(
                { session_id: input.sessionId, commit_oid: reconciled.commitOid },
                "muse pre-snapshot arrived late, recorded",
              );
            }
          } catch (lateError) {
            deps.log.error(
              { err: String(lateError), session_id: input.sessionId, trigger: "tool.pre" },
              "muse late pre-snapshot reconcile failed",
            );
          }
        },
        () => {
          // Late snapshotter failure: the timeout gap already records the
          // miss, so there is nothing further to persist.
        },
      );
      return outcome({
        taken: false,
        timedOut: true,
        eventsAdded: gapEvents,
        reason: gapDuplicate ? "duplicate" : "timeout",
      });
    }
    deps.log.error(
      { err: String(error), session_id: input.sessionId, trigger: "tool.pre" },
      "muse shadow snapshot failed",
    );
    const eventsAdded = recordSnapshotGap(deps, {
      sessionId: input.sessionId,
      projectId: input.projectId,
      trigger: "tool.pre",
      key: input.triggerEventId,
      observedAt: input.observedAt,
      detail: { error: String(error) },
      diagnostics: ["snapshot_failed"],
    });
    return outcome({ taken: false, eventsAdded, reason: "snapshot_failed" });
  }
}

// tool.post fires for completed and failed tools alike: a failed tool may
// still have written part of a file.
export async function maybeToolPostSnapshot(
  deps: MuseSnapshotDeps,
  input: ToolTriggerInput,
): Promise<SnapshotOutcome> {
  return takeSnapshot(deps, {
    sessionId: input.sessionId,
    projectId: input.projectId,
    root: input.root,
    trigger: "tool.post",
    key: input.triggerEventId,
    observedAt: input.observedAt,
  });
}

// One snapshot per tool.batch boundary, keyed by the batch event id.
export async function maybeBatchPostSnapshot(
  deps: MuseSnapshotDeps,
  input: ToolTriggerInput,
): Promise<SnapshotOutcome> {
  return takeSnapshot(deps, {
    sessionId: input.sessionId,
    projectId: input.projectId,
    root: input.root,
    trigger: "batch.post",
    key: input.triggerEventId,
    observedAt: input.observedAt,
  });
}

// Final fires only after SessionEnd; the caller gates on quiescence (stable
// polls) before invoking. Idempotent on re-run via the latestSnapshot check.
export async function maybeFinalSnapshot(
  deps: MuseSnapshotDeps,
  input: BaselineInput,
): Promise<SnapshotOutcome> {
  if (!hasEventKind(deps.db, input.sessionId, "session.ended")) {
    return outcome({ taken: false, reason: "no-session-end" });
  }
  if (latestSnapshot(deps.db, input.sessionId, "final") !== null) {
    return outcome({ taken: false, reason: "duplicate" });
  }
  return takeSnapshot(deps, { ...input, trigger: "final", key: "final" });
}

// Per-poll budget for hook-triggered snapshots (tool.pre/post, batch.post).
// A deep spool backlog must not stall a poll for minutes: beyond the budget,
// triggers are recorded as visible budget gaps instead of silent drops.
// Baselines and finals are exempt — both self-heal on later polls (baseline
// via latestSnapshot, final via the quiescent export gate), while a drained
// hook trigger is one-shot.
export const MAX_TRIGGER_SNAPSHOTS_PER_POLL = 20;

export interface HookTrigger {
  sessionId: string;
  projectId: string;
  root: string;
  kind: string | null;
  toolName: string | null;
  eventId: string;
  isNewSession: boolean;
}

export interface TriggerBatchResult {
  eventsAdded: number;
  triggerSnapshots: number;
  budgetSkipped: number;
}

function triggerOf(kind: string | null): "tool.pre" | "tool.post" | "batch.post" | null {
  if (kind === "tool.requested") return "tool.pre";
  if (kind === "tool.completed" || kind === "tool.failed") return "tool.post";
  if (kind === "tool.batch") return "batch.post";
  return null;
}

export async function handleHookTriggerSnapshots(
  deps: MuseSnapshotDeps,
  hooks: HookTrigger[],
  observedAt: string,
  maxSnapshots: number = MAX_TRIGGER_SNAPSHOTS_PER_POLL,
): Promise<TriggerBatchResult> {
  let eventsAdded = 0;
  let triggerSnapshots = 0;
  let budgetSkipped = 0;
  for (const hook of hooks) {
    if (hook.isNewSession) {
      try {
        eventsAdded += (
          await ensureBaselineSnapshot(deps, {
            sessionId: hook.sessionId,
            projectId: hook.projectId,
            root: hook.root,
            observedAt,
          })
        ).eventsAdded;
      } catch (error) {
        deps.log.error({ err: String(error), session_id: hook.sessionId }, "muse baseline failed");
      }
    }
    const trigger = triggerOf(hook.kind);
    if (trigger === null) continue;
    const input = {
      sessionId: hook.sessionId,
      projectId: hook.projectId,
      root: hook.root,
      observedAt,
      toolName: hook.toolName,
      triggerEventId: hook.eventId,
    };
    if (triggerSnapshots >= maxSnapshots) {
      try {
        eventsAdded += recordSnapshotGap(deps, {
          sessionId: hook.sessionId,
          projectId: hook.projectId,
          trigger,
          key: hook.eventId,
          observedAt,
          detail: { reason: "snapshot budget exhausted for this poll" },
          diagnostics: ["snapshot_budget_exhausted"],
        });
      } catch (error) {
        deps.log.error(
          { err: String(error), session_id: hook.sessionId },
          "muse budget gap failed",
        );
      }
      budgetSkipped += 1;
      continue;
    }
    try {
      const snapshot =
        trigger === "tool.pre"
          ? await maybeToolPreSnapshot(deps, input)
          : trigger === "tool.post"
            ? await maybeToolPostSnapshot(deps, input)
            : await maybeBatchPostSnapshot(deps, input);
      eventsAdded += snapshot.eventsAdded;
      // A charged attempt held the snapshotter (lock, walk, 500ms budget);
      // fast no-ops (non-mutating, duplicate) cost nothing and skip the charge.
      if (snapshot.taken || snapshot.timedOut === true) triggerSnapshots += 1;
    } catch (error) {
      deps.log.error(
        { err: String(error), session_id: hook.sessionId, kind: hook.kind },
        "muse trigger snapshot failed",
      );
    }
  }
  return { eventsAdded, triggerSnapshots, budgetSkipped };
}
