import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildChangeNarrationMessages,
  buildSessionSummaryFromDigests,
  buildSkeletonChange,
  CHANGE_MODEL_GENERATOR,
  type ChangeDraft,
  type ChangeGroup,
  type CreatedFrom,
  type DiffFile,
  groupDiffIntoChanges,
  MAX_FILES_PER_CHANGE,
  mergeSessionGroups,
  parseChangeDraft,
  rollupIdFor,
  validateSkeletonChange,
} from "@echo/chapters";
import {
  CHANGES_FILE_NAME,
  type Change,
  type ChangeCodeFile,
  type ChangeCodeHunk,
  type ChangeCodeLine,
  ChangeCodeResponseSchema,
  ChangeIdSchema,
  ChangeSchema,
  capSessionTitle,
  PROGRESS_FILE_NAME,
  type Progress,
  ProgressSchema,
  z,
} from "@echo/contracts";
import {
  type EchoDb,
  getChangeRefs,
  getFirstPromptText,
  getProgress,
  getSession,
  getSessionLastObservedAt,
  getSessionTitle,
  listSnapshots,
  pruneChangeRefs,
  readAllEvents,
  recordChangeRef,
  setSessionSummary,
  setSessionTitleIfNull,
  recordProgress as storeProgressRow,
} from "@echo/db";
import {
  type ChatMessage,
  type ModelConfig,
  ModelError,
  modelConfigFromEnv,
  requestJson,
} from "@echo/model";
import { redactJson, redactText } from "@echo/redaction";
import { diffShadowTrees } from "@echo/snapshots";
import { isSessionQuiet } from "./session-readiness";

export const CHANGES_GENERATOR = "skeleton-v1";

/**
 * Marker diagnostic proving the tape-evidence gate ran for an artifact.
 * Artifacts without the current value predate the gate and must regenerate:
 * their diffs may attribute other sessions' shared-tree writes to this
 * session. Bumped to v2 when the gate went per-window; v1 (session-wide)
 * artifacts regenerate once more so every session is repaired under the
 * final logic.
 */
export const CHANGES_EVIDENCE_GATE = "changes_evidence_gated_v2";

// Mutating file tools whose input.path proves the session authored file
// state. Read/grep/glob/search/question never count: observing a file is
// not changing it. Shell is excluded on purpose: a command that merely
// names a file (cat, git status) must not become authorship; shell-driven
// writes surface as unattributed gaps instead of fabricated changes.

/** Cap on prompt texts per generation: bounds the substring matching in grouping. */
const MAX_PROMPTS = 500;
/** Cap on model narration per generation run: bounds spend and latency. */
const MAX_NARRATE_PER_RUN = 24;
/** Cap on skeleton fill-in per generation run: same id/version, new prose. */
const MAX_FILL_PER_RUN = 6;

/**
 * requestJson parse: structural shape only. Field caps stay with
 * validateSkeletonChange so the retry quotes the violated cap, and the
 * server stamps id/version/provenance afterwards.
 */
function parseModelDraft(value: unknown): ChangeDraft {
  const parsed = parseChangeDraft(value);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.draft;
}

export interface ChangesLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export interface ChangesBackfillPick {
  sessionId: string;
  reason: "missing" | "stale" | "fill" | "meta";
}

export interface ChangesServiceDeps {
  db: EchoDb;
  dataDir: string;
  log: ChangesLogger;
}

export interface ChangesServiceOptions {
  /** Injected for tests; defaults to the wall clock. */
  clock?: () => Date;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the real redaction gate. */
  redactJsonImpl?: typeof redactJson;
}

export interface ChangesArtifact {
  sessionId: string;
  generatedAt: string;
  generator: string;
  summary: string;
  diagnostics: string[];
  changes: Change[];
  /**
   * Snapshot set this artifact was built from. Sessions with no diffs still
   * write the watermark so the backfill skips them until snapshots change —
   * they are not reprocessed on every poll.
   */
  snapshotWatermark?: { snapshotCount: number; lastOid: string | null };
}

export interface ChangesResponse {
  changes: Change[];
  progress: Progress[];
  summary: string;
  isLive: boolean;
}

export type ChangesGenerateOutcome =
  | { outcome: "generated" | "fresh"; artifact: ChangesArtifact }
  | { outcome: "unknown_session" | "unavailable"; artifact: null };

export interface ChangesOutcome {
  status: number;
  body: unknown;
}

// Git emits one "diff --git a/<old> b/<new>" header per file. Split the
// whole-tree diff there so grouping sees per-path diffs; a moved file reads
// as delete+add, matching the review index. Binary chunks carry no +/- lines
// and fold into the small-changes group downstream.
function splitDiffByFile(rawDiff: string): DiffFile[] {
  const out: DiffFile[] = [];
  const chunks = rawDiff.split("\ndiff --git ");
  for (const [index, chunk] of chunks.entries()) {
    const text = index === 0 ? chunk : `diff --git ${chunk}`;
    if (!text.startsWith("diff --git ")) continue;
    const added = /^\+{3} b\/(.+)$/m.exec(text)?.[1];
    const removed = /^--- a\/(.+)$/m.exec(text)?.[1];
    const path = (added ?? removed ?? "").trim();
    if (path === "" || path === "/dev/null") continue;
    out.push({ path, diff: text });
  }
  return out;
}

/** Cap on served diff lines per file; added/removed counts still cover the whole file. */
const MAX_CODE_LINES_PER_FILE = 600;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse one per-file unified diff into numbered hunks. Counts always cover
 * every +/- line; served lines stop at the cap with truncated set. Binary
 * chunks carry no renderable lines and report truncated as the gap marker.
 */
function parseCodeHunks(
  diff: string,
): Pick<ChangeCodeFile, "added" | "removed" | "truncated" | "hunks"> {
  const hunks: ChangeCodeHunk[] = [];
  let added = 0;
  let removed = 0;
  let kept = 0;
  let truncated = false;
  let current: ChangeCodeHunk | null = null;
  let prevNo = 0;
  let nextNo = 0;
  const push = (line: ChangeCodeLine) => {
    if (kept >= MAX_CODE_LINES_PER_FILE) {
      truncated = true;
      return;
    }
    current?.lines.push(line);
    kept += 1;
  };
  for (const raw of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("Binary files ") && raw.endsWith(" differ")) {
      truncated = true;
      continue;
    }
    const header = HUNK_HEADER.exec(raw);
    if (header !== null) {
      current = {
        prevStart: Number(header[1]),
        prevLines: header[2] === undefined ? 1 : Number(header[2]),
        nextStart: Number(header[3]),
        nextLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      prevNo = current.prevStart;
      nextNo = current.nextStart;
      continue;
    }
    if (current === null || raw === "") continue;
    const marker = raw[0];
    if (marker === "+") {
      added += 1;
      push({ kind: "add", prevNo: null, nextNo, text: raw.slice(1) });
      nextNo += 1;
    } else if (marker === "-") {
      removed += 1;
      push({ kind: "del", prevNo, nextNo: null, text: raw.slice(1) });
      prevNo += 1;
    } else if (marker === " ") {
      push({ kind: "context", prevNo, nextNo, text: raw.slice(1) });
      prevNo += 1;
      nextNo += 1;
    }
    // Anything else (file headers, "\ No newline" markers) is skipped:
    // only hunk content lines are served.
  }
  return { added, removed, truncated, hunks };
}

// Prompt texts in tape order for the grouping's promptRefs linkage. Only
// prompt.submitted payloads carry quotable prompt text; everything else is
// skipped rather than guessed.
function promptTextsFor(db: EchoDb, sessionId: string): string[] {
  const texts: string[] = [];
  for (const event of readAllEvents(db, sessionId)) {
    if (event.kind !== "prompt.submitted") continue;
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") continue;
    const text = (payload as Record<string, unknown>).text;
    if (typeof text === "string" && text !== "") texts.push(text);
  }
  return texts.slice(-MAX_PROMPTS);
}

interface TimedEvidence {
  /** Source and daemon millis of the evidence event; null when unparseable. */
  tsMs: number | null;
  obsMs: number | null;
}

/**
 * Snapshot lag tolerance: a tool lands, then a later poll takes the
 * post-snapshot. Evidence just outside the pair still belongs to it.
 * Wide open past this, same-file edits by concurrent sessions blend —
 * that remainder is reported, not hidden (see the pair filter below).
 */
const EVIDENCE_SKEW_MS = 120_000;

/**
 * Wall-clock budget for the pair-diff loop below; mirrors the review index.
 * A monster session degrades to a partial fold with a diagnostic instead of
 * freezing the daemon's event loop for minutes on blocking git output.
 */
const CHANGES_DIFF_BUDGET_MS = 20_000;

/**
 * Minimum gap between fill-only narration passes on unchanged snapshots.
 * Fill caps narration per run, so uncapped re-picks would re-diff the whole
 * session every backfill tick until its skeletons clear. In-memory: a
 * restart allows one extra fill pass per session.
 */
const FILL_COOLDOWN_MS = 10 * 60 * 1000;

interface TapeFileEvidence {
  /** Mutating tool input paths with event times. */
  paths: Array<{ path: string } & TimedEvidence>;
  /**
   * Stringified tool.requested payloads (agent intent, not results) with
   * event times. Muse tool_calls args carry {"path": ...} and
   * workspace:<rel> subjects here; opencode pendings are partial/empty and
   * match nothing. Completed outputs are excluded: results may list other
   * sessions' files (git status, grep), which must never become authorship.
   */
  intents: Array<{ text: string } & TimedEvidence>;
}

// File paths this session's own tape proves it touched. Completed/failed
// mutating file tools contribute their input.path; requested payloads
// contribute intent text for substring matching (Muse opaque records).
// A diff file with no evidence in the pair's window is another session's
// shared-tree write, not this session's change. Either clock counts: live
// tools carry both source and observed times near the snapshots, while
// imports stamp observed_at at import time with older source times.
function tapeFileEvidenceFor(db: EchoDb, sessionId: string): TapeFileEvidence {
  const paths: Array<{ path: string } & TimedEvidence> = [];
  const intents: Array<{ text: string } & TimedEvidence> = [];
  for (const event of readAllEvents(db, sessionId)) {
    const tsMs = parseMs(event.ts);
    const obsMs = parseMs(event.observed_at);
    if (event.kind === "tool.requested") {
      const payload = event.payload;
      if (payload === null || typeof payload !== "object") continue;
      const record = payload as Record<string, unknown>;
      // Shell/read/search intents name files without changing them.
      if (typeof record.name === "string") {
        const name = record.name.toLowerCase();
        if (name !== "edit" && name !== "write" && name !== "patch" && name !== "apply_patch") {
          continue;
        }
      }
      try {
        intents.push({ text: JSON.stringify(payload), tsMs, obsMs });
      } catch {
        // Unstringifiable intent contributes no evidence.
      }
      continue;
    }
    if (event.kind !== "tool.completed" && event.kind !== "tool.failed") continue;
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") continue;
    const record = payload as Record<string, unknown>;
    if (typeof record.name !== "string") continue;
    const name = record.name.toLowerCase();
    if (name !== "edit" && name !== "write" && name !== "patch" && name !== "apply_patch") {
      continue;
    }
    const input = record.input;
    if (input === null || typeof input !== "object" || Array.isArray(input)) continue;
    const path = (input as Record<string, unknown>).path;
    if (typeof path === "string" && path !== "") paths.push({ path, tsMs, obsMs });
  }
  return { paths, intents };
}

/** Parsed millis, null when the timestamp is missing or malformed. */
function parseMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * True when the session's tape evidences authorship of a diff path inside
 * the snapshot pair's window. Untimestamped evidence counts (never punish
 * a clock gap by dropping real work); everything else must land in
 * [fromMs - skew, toMs + skew].
 */
function isPathEvident(
  rel: string,
  evidence: TapeFileEvidence,
  fromMs: number,
  toMs: number,
): boolean {
  const inWindow = (entry: TimedEvidence): boolean => {
    // Either clock counts: live tools carry source and observed times near
    // the snapshots, while imports stamp observed_at at import time with
    // older source times. Untimestamped evidence counts (never punish a
    // clock gap by dropping real work).
    if (entry.tsMs === null && entry.obsMs === null) return true;
    const hit = (atMs: number | null): boolean =>
      atMs !== null && atMs >= fromMs - EVIDENCE_SKEW_MS && atMs <= toMs + EVIDENCE_SKEW_MS;
    return hit(entry.tsMs) || hit(entry.obsMs);
  };
  for (const candidate of evidence.paths) {
    if (!inWindow(candidate)) continue;
    if (candidate.path === rel || candidate.path.endsWith(`/${rel}`)) return true;
  }
  for (const intent of evidence.intents) {
    if (!inWindow(intent)) continue;
    if (intent.text.includes(rel)) return true;
  }
  return false;
}

// Model-distilled session name from the first prompt plus change titles.
// Runs at most once per session: first-write-wins forever, agent titles
// never lose, and any failure just leaves the title null for the next run.
async function nameSessionFromModel(args: {
  db: EchoDb;
  log: ChangesLogger;
  fetchImpl: typeof fetch;
  redactJsonImpl: typeof redactJson;
  reasoningEffort: string;
  sessionId: string;
  config: ModelConfig | null;
  changes: Change[];
}): Promise<void> {
  if (args.config === null) return;
  if (getSessionTitle(args.db, args.sessionId) !== null) return;
  const firstPrompt = getFirstPromptText(args.db, args.sessionId);
  const titles = args.changes.map((change) => change.title).filter((title) => title !== "");
  if (firstPrompt === null && titles.length === 0) return;
  // Prompt text leaves the process only through the gate.
  let redacted: ChatMessage[];
  try {
    redacted = args.redactJsonImpl([
      {
        role: "system",
        content:
          'Name this coding session in 6 words or fewer: a short topic phrase like an agent session title. Reply with JSON only: {"title": string}. No quotes, no trailing period.',
      },
      {
        role: "user",
        content: [
          firstPrompt !== null ? `First request:\n${firstPrompt.slice(0, 500)}` : null,
          titles.length > 0 ? `Changes:\n${titles.slice(0, 20).join("\n")}` : null,
        ]
          .filter((part): part is string => part !== null)
          .join("\n\n"),
      },
    ]).value as ChatMessage[];
  } catch {
    return;
  }
  const parse = (value: unknown): string => {
    if (typeof value !== "object" || value === null) throw new Error("name must be an object");
    const title = (value as Record<string, unknown>).title;
    if (typeof title !== "string" || title.trim() === "") throw new Error("name needs a title");
    return title;
  };
  try {
    const { value } = await requestJson(args.config, redacted, parse, {
      fetchImpl: args.fetchImpl,
      reasoningEffort: args.reasoningEffort,
    });
    // Names land in SQLite, so the model text passes the gate first too.
    setSessionTitleIfNull(args.db, args.sessionId, capSessionTitle(redactText(value).value));
  } catch (error) {
    // Content-free diagnostic: never log the candidate name.
    args.log.error({ session_id: args.sessionId, err: String(error) }, "session naming failed");
  }
}

const ProgressArtifactSchema = z.object({
  sessionId: z.string().min(1),
  updatedAt: z.string().min(1),
  progress: z.array(ProgressSchema),
});

function changesArtifactPath(dataDir: string, projectId: string, sessionId: string): string {
  return join(dataDir, "projects", projectId, "sessions", sessionId, CHANGES_FILE_NAME);
}

function progressArtifactPath(dataDir: string, projectId: string, sessionId: string): string {
  return join(dataDir, "projects", projectId, "sessions", sessionId, PROGRESS_FILE_NAME);
}

function readArtifactFile(path: string, sessionId: string): ChangesArtifact | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.changes)) return null;
    const changes: Change[] = [];
    for (const entry of record.changes) {
      const change = ChangeSchema.safeParse(entry);
      if (change.success) changes.push(change.data);
    }
    const watermark = record.snapshotWatermark;
    return {
      sessionId,
      generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : "",
      generator: typeof record.generator === "string" ? record.generator : CHANGES_GENERATOR,
      summary: typeof record.summary === "string" ? record.summary : "",
      diagnostics: Array.isArray(record.diagnostics)
        ? record.diagnostics.filter((entry): entry is string => typeof entry === "string")
        : [],
      changes,
      ...(watermark !== null &&
      typeof watermark === "object" &&
      typeof (watermark as { snapshotCount?: unknown }).snapshotCount === "number"
        ? {
            snapshotWatermark: {
              snapshotCount: (watermark as { snapshotCount: number }).snapshotCount,
              lastOid:
                typeof (watermark as { lastOid?: unknown }).lastOid === "string"
                  ? (watermark as { lastOid: string }).lastOid
                  : null,
            },
          }
        : {}),
    };
  } catch {
    // Corrupt artifact reads as missing; the next hook run regenerates it.
    return null;
  }
}

function toProgress(db: EchoDb, sessionId: string): Progress[] {
  return getProgress(db, sessionId).map((row) => ({
    changeId: row.changeId,
    version: row.version,
    state: row.state,
    updatedAt: row.updatedAt,
  }));
}

export function createChangesService(
  deps: ChangesServiceDeps,
  options: ChangesServiceOptions = {},
) {
  const { db, dataDir, log } = deps;
  const clock = options.clock ?? (() => new Date());
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const redactJsonImpl = options.redactJsonImpl ?? redactJson;
  /** Last fill-pass start per session; spaces narration-only re-runs. */
  const lastFillAt = new Map<string, number>();

  function modelOff(): boolean {
    return env.ECHO_MODEL === "off";
  }

  function persistProgressFile(sessionId: string, projectId: string): void {
    const payload = {
      sessionId,
      updatedAt: clock().toISOString(),
      progress: toProgress(db, sessionId),
    };
    // Ids and states only, but every Echo-owned write passes the gate.
    const scanned = ProgressArtifactSchema.parse(redactJsonImpl(payload).value);
    const path = progressArtifactPath(dataDir, projectId, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(scanned, null, 2)}\n`);
  }

  /**
   * Best-effort model narration for one change group. The model drafts only
   * content fields; id/version/provenance are stamped from the skeleton so a
   * narrated change dedupes and versions exactly like its fallback. Any
   * failure (redaction, transport, shape, caps twice) returns null and the
   * caller keeps the skeleton. Never throws.
   */
  async function narrateGroup(args: {
    sessionId: string;
    config: ModelConfig;
    group: ChangeGroup;
    /** Moment prompt texts mentioning this group (the only moment text kept). */
    prompts: string[];
    /** Earlier digests only, oldest first. Never the current group's digest. */
    digests: string[];
    prevOid: string;
    nextOid: string;
    id: string;
    version: number;
    createdFrom: CreatedFrom;
  }): Promise<Change | null> {
    const messages = buildChangeNarrationMessages({
      group: args.group,
      prompts: args.prompts,
      digests: args.digests,
      pair: { prevOid: args.prevOid, nextOid: args.nextOid },
    });
    // Diff plus moment text leaves the process only through the gate.
    let redacted: ChatMessage[];
    try {
      redacted = redactJsonImpl([
        { role: "system", content: messages.system },
        { role: "user", content: messages.user },
      ]).value as ChatMessage[];
    } catch {
      return null;
    }
    // One change of JSON is small: an 8k floor covers the prompt plus
    // reasoning headroom without story-scale spend.
    const width = Math.max(args.config.maxTokens * 2, 8192);
    const wide = { ...args.config, maxTokens: width };
    const reasoningEffort = env.META_REASONING_EFFORT ?? "low";
    const request = (chat: ChatMessage[]) =>
      requestJson(wide, chat, parseModelDraft, {
        fetchImpl,
        retryMaxTokens: width,
        reasoningEffort,
      });
    const stamp = (draft: ChangeDraft) => ({
      ...draft,
      id: args.id,
      version: args.version,
      snapshotPair: { prevOid: args.prevOid, nextOid: args.nextOid },
      createdFrom: args.createdFrom,
      origin: "model" as const,
    });
    try {
      let draft: ChangeDraft;
      try {
        draft = (await request(redacted)).value;
      } catch (error) {
        if (!(error instanceof ModelError) || error.code !== "invalid_response") return null;
        // Shape failure, not a dead model: one retry with the failure
        // spelled out. The message names fields only, never draft content.
        log.error(
          { session_id: args.sessionId, stage: "changes-draft-retry" },
          "changes draft failed structural parse; retrying",
        );
        try {
          draft = (
            await request([
              ...redacted,
              {
                role: "assistant",
                content: "I will return only the corrected JSON change, same shape.",
              },
              {
                role: "user",
                content: `The previous draft was not valid: ${error.message.slice(0, 1200)}\nReturn ONLY the full corrected JSON change, same shape.`,
              },
            ])
          ).value;
        } catch {
          return null;
        }
      }
      const first = validateSkeletonChange(stamp(draft), { files: args.group.files });
      if (first.ok) {
        const parsed = ChangeSchema.safeParse(stamp(draft));
        if (parsed.success) return parsed.data;
      } else {
        // Content-free: counts only. Error text may quote file paths, so it
        // goes to the model retry below, never to the log.
        log.error(
          {
            session_id: args.sessionId,
            note: "changes-first-draft-failed",
            failing: first.errors.length,
          },
          "changes draft failed validation; retrying",
        );
      }
      const fixPrompt = [
        "The previous draft failed these checks. Fix every failure and return the full corrected JSON change, same shape:",
        ...(first.ok
          ? ["The draft failed contract validation with no further detail."]
          : first.errors.map((failure) => `- ${failure}`)),
      ].join("\n");
      try {
        const second = (
          await request([
            ...redacted,
            { role: "assistant", content: JSON.stringify(draft) },
            { role: "user", content: fixPrompt },
          ])
        ).value;
        const candidate = stamp(second);
        if (!validateSkeletonChange(candidate, { files: args.group.files }).ok) return null;
        const parsed = ChangeSchema.safeParse(candidate);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }

  async function maybeGenerateChanges(sessionId: string): Promise<ChangesGenerateOutcome> {
    const session = getSession(db, sessionId);
    if (!session) return { outcome: "unknown_session", artifact: null };
    const snapshots = listSnapshots(db, sessionId);
    const shadowDir = join(dataDir, "projects", session.projectId, "shadow.git");
    const diagnostics: string[] = [];
    if (snapshots.length < 2) diagnostics.push("needs_two_snapshots");

    const refs = getChangeRefs(db, sessionId);
    // Each fold chunk keeps a stable per-session id so regens update rows
    // in place instead of minting new rollup rows per fold shift. The set
    // is precomputed: 512 chunks cover 5120 folded files, past any real
    // session, and recognition must not depend on this run's fold.
    const rollupIds = new Set(
      Array.from({ length: 512 }, (_, index) => rollupIdFor(sessionId, index)),
    );
    // The file wins: a ref without file content never blocks. Skip only what
    // the artifact actually carries; a recorded-but-missing id regenerates
    // at its recorded version instead of bumping, so orphans heal in place.
    // Span versions freeze at run start: groups within one run share the
    // span's next version instead of incrementing per group (that produced
    // v14-style runs meaning "14th group", not "14th rewrite"). Rollups
    // stay out of the span map: their spans overlap real spans by design.
    const refMaxVersion = new Map<string, number>();
    const frozenSpanVersion = new Map<string, number>();
    for (const ref of refs) {
      refMaxVersion.set(ref.changeId, Math.max(refMaxVersion.get(ref.changeId) ?? 0, ref.version));
      if (rollupIds.has(ref.changeId)) continue;
      const span = `${ref.prevOid}\n${ref.nextOid}`;
      frozenSpanVersion.set(span, Math.max(frozenSpanVersion.get(span) ?? 0, ref.version));
    }

    const artifactPath = changesArtifactPath(dataDir, session.projectId, sessionId);
    const previous = readArtifactFile(artifactPath, sessionId);
    const carried = new Map<string, Change>();
    for (const change of previous?.changes ?? []) {
      // Pre-split rows never carry: the fold below rebuilds them small at
      // the recorded version, so progress survives and the backfill cannot
      // stale-loop on an artifact that regenerates byte-identical.
      if (change.files.length > MAX_FILES_PER_CHANGE) continue;
      carried.set(`${change.id}:v${change.version}`, change);
    }
    const carriedIds = new Set([...carried.values()].map((change) => change.id));
    const carriedVersion = new Map(
      [...carried.values()].map((change) => [change.id, change.version] as const),
    );
    const watermark = {
      snapshotCount: snapshots.length,
      lastOid: snapshots.length > 0 ? (snapshots[snapshots.length - 1]?.commitOid ?? null) : null,
    };
    // Watermark hit: snapshots unchanged since the last build. Only a
    // model-on fill pass can still do work; otherwise return byte-identical.
    const watermarkHit =
      previous?.snapshotWatermark?.snapshotCount === watermark.snapshotCount &&
      previous?.snapshotWatermark?.lastOid === watermark.lastOid;
    // Fold shape changed under old artifacts: a stored change wider than
    // the reader cap is a pre-split rollup that must regenerate, even when
    // the snapshots themselves are unchanged.
    const needsResplit = (previous?.changes ?? []).some(
      (change) => change.files.length > MAX_FILES_PER_CHANGE,
    );
    // Same for the summary: the builder is deterministic, so drift means
    // its shape changed under a quiet session and one rewrite heals it.
    const needsSummaryRewrite =
      previous !== null &&
      previous.summary !==
        buildSessionSummaryFromDigests(previous.changes.map((change) => change.digest));

    const prompts = promptTextsFor(db, sessionId);
    // Files this session's tape proves it touched. Every snapshot-pair
    // diff is filtered against it below: shared-tree writes from concurrent
    // sessions are dropped, never claimed.
    const evidence = tapeFileEvidenceFor(db, sessionId);
    // Earlier digests only, oldest first: carried rows in artifact order,
    // then each fresh digest as it lands. The session summary is built from
    // digests alone, so narration never sees the current group's digest.
    const digestHistory = [...carried.values()].map((change) => change.digest);
    const digestIndex = new Map(
      [...carried.values()].map((change, index) => [change.id, index] as const),
    );
    let usedModel = false;
    let modelFallback = false;
    // Resolve once: per-group narration is best-effort, and a missing key
    // means silent skeletons, never a throw.
    let modelConfig: ModelConfig | null = null;
    if (!modelOff()) {
      try {
        modelConfig = modelConfigFromEnv(env);
      } catch {
        modelConfig = null;
      }
    }
    const fresh: Change[] = [];
    const ordered: Change[] = [];
    let filled = 0;
    let narratedCount = 0;
    // Diff files dropped for lack of tape evidence, reported as a gap count.
    let unattributedFiles = 0;
    // Pre-gate artifacts lack the marker and must regenerate even when the
    // snapshots are unchanged: their diffs may claim other sessions' writes.
    const previousGated = previous?.diagnostics.includes(CHANGES_EVIDENCE_GATE) ?? false;
    // Watermark hit with nothing to fill: snapshots unchanged and every
    // row already has prose (or the model is off). Skip the pair loop
    // entirely — diffing hundreds of pairs just to skip them is the slow
    // path this early exit removes. A pre-split rollup or a drifted
    // summary always regenerates.
    if (watermarkHit && previous && previousGated && !needsResplit && !needsSummaryRewrite) {
      const needsFill =
        modelConfig !== null &&
        previous.changes.some((change) => (change.origin ?? "skeleton") === "skeleton");
      // Fill caps narration per run, so without a cooldown the same session
      // would re-diff every pair on every 20s tick until its skeletons clear
      // — a permanent burn on big sessions. The cooldown spaces fill passes;
      // a restart allows one extra pass.
      const fillCooling =
        needsFill && clock().getTime() - (lastFillAt.get(sessionId) ?? 0) < FILL_COOLDOWN_MS;
      if (!needsFill || fillCooling) {
        const progressPath = progressArtifactPath(dataDir, session.projectId, sessionId);
        if (!existsSync(progressPath)) persistProgressFile(sessionId, session.projectId);
        pruneChangeRefs(
          db,
          sessionId,
          previous.changes.map((change) => change.id),
        );
        // Fresh artifact, possibly stale inbox columns: heal legacy rows.
        setSessionSummary(db, sessionId, previous.summary);
        await nameSessionFromModel({
          db,
          log,
          fetchImpl,
          redactJsonImpl,
          reasoningEffort: env.META_REASONING_EFFORT ?? "low",
          sessionId,
          config: modelConfig,
          changes: previous.changes,
        });
        return { outcome: "fresh", artifact: previous };
      }
      // Fill proceeds: snapshots are unchanged, so this run only narrates.
      lastFillAt.set(sessionId, clock().getTime());
    }
    // Phase 1: group every pair. Phase 2 folds the session to budget.
    // Skeletons build only for the folded set, so ids stay stable and one
    // run never writes changes the fold would immediately hide. The loop is
    // budget-bound: a monster session degrades to a partial fold with a
    // diagnostic instead of blocking the loop for minutes.
    const candidates: ChangeGroup[] = [];
    const pairDeadline = Date.now() + CHANGES_DIFF_BUDGET_MS;
    for (let index = 1; index < snapshots.length; index += 1) {
      if (Date.now() > pairDeadline) {
        diagnostics.push("changes_budget_exceeded");
        break;
      }
      const prev = snapshots[index - 1];
      const next = snapshots[index];
      if (!prev || !next || prev.commitOid === next.commitOid) continue;
      let rawDiff: string;
      try {
        rawDiff = await diffShadowTrees(shadowDir, prev.commitOid, next.commitOid);
      } catch {
        // One unreadable pair degrades to a diagnostic; other pairs still group.
        diagnostics.push(
          `changes_diff_failed:${prev.commitOid.slice(0, 8)}..${next.commitOid.slice(0, 8)}`,
        );
        continue;
      }
      const files = splitDiffByFile(rawDiff);
      // No diff means no change.
      if (files.length === 0) continue;
      // Evidence gate: keep only files this session's tape proves it
      // touched inside this pair's window. The shadow tree is shared per
      // project, so concurrent sessions' writes land between these
      // snapshots; claiming them would put one session's explanation under
      // another session's name.
      const fromMs = Date.parse(prev.takenAt);
      const toMs = Date.parse(next.takenAt);
      const evidenced = files.filter((file) => isPathEvident(file.path, evidence, fromMs, toMs));
      unattributedFiles += files.length - evidenced.length;
      // A pair with nothing attributable is all gap, no change.
      if (evidenced.length === 0) continue;
      const span = { prevOid: prev.commitOid, nextOid: next.commitOid };
      for (const group of groupDiffIntoChanges({
        files: evidenced,
        prompts,
        createdFrom: { kind: "snapshot_pair", ...span },
      })) {
        candidates.push({ ...group, span });
      }
    }
    const folded = mergeSessionGroups(candidates);
    if (candidates.length > folded.length) {
      diagnostics.push(`changes_folded:${candidates.length}->${folded.length}`);
    }
    // Gaps are data: dropped files are counted, never silently absorbed.
    // The gate marker proves this artifact ran the filter, so the backfill
    // can tell pre-gate artifacts apart and regenerate them.
    if (unattributedFiles > 0) {
      diagnostics.push(`changes_unattributed:${unattributedFiles}`);
    }
    diagnostics.push(CHANGES_EVIDENCE_GATE);
    for (const group of folded) {
      const span = group.span;
      // Unstamped groups cannot anchor an id; without a span there is no change.
      if (!span) {
        diagnostics.push("changes_validation_failed");
        continue;
      }
      {
        const skeleton = buildSkeletonChange(group, span);
        // Rollups keep stable per-session ids (one per fold chunk);
        // everything else keeps its content hash, so regens update rows
        // instead of piling new ones.
        const id =
          group.rollup === true ? rollupIdFor(sessionId, group.rollupIndex ?? 0) : skeleton.id;
        const spanKey = `${span.prevOid}\n${span.nextOid}`;
        // Group-relevant moment texts: the grouping links prompts that name
        // the group's files, the only moment text this pipeline retains.
        const groupPrompts = group.promptRefs
          .map((index) => prompts[index])
          .filter((text): text is string => typeof text === "string");
        // Each rollup chunk keeps its stable id and refreshes in place:
        // same id, same version, new content when the folded set changes.
        // Progress never resets; a byte-identical rebuild stays "fresh".
        if (group.rollup === true) {
          const built = buildSkeletonChange(group, span);
          const fingerprint = (files: Change["files"], digest: string): string =>
            `${digest}|${files.map((file) => `${file.path}:${file.note}`).join("|")}`;
          const versionForId = carriedVersion.get(id) ?? null;
          const carriedRow =
            versionForId === null ? undefined : carried.get(`${id}:v${versionForId}`);
          const version = refMaxVersion.get(id) ?? 1;
          if (
            carriedRow !== undefined &&
            fingerprint(built.files, built.digest) ===
              fingerprint(carriedRow.files, carriedRow.digest)
          ) {
            ordered.push(carriedRow);
            continue;
          }
          let refreshed: Change | null = null;
          if (modelConfig !== null) {
            if (narratedCount >= MAX_NARRATE_PER_RUN) {
              diagnostics.push("changes_narrate_capped");
            } else {
              narratedCount += 1;
              try {
                refreshed = await narrateGroup({
                  sessionId,
                  config: modelConfig,
                  group,
                  prompts: groupPrompts,
                  digests: digestHistory,
                  prevOid: span.prevOid,
                  nextOid: span.nextOid,
                  id,
                  version,
                  createdFrom: built.createdFrom,
                });
              } catch {
                refreshed = null;
              }
            }
            if (refreshed !== null) usedModel = true;
            else modelFallback = true;
          }
          const parsed =
            refreshed !== null
              ? { success: true as const, data: refreshed }
              : ChangeSchema.safeParse({ ...built, id, version, origin: "skeleton" as const });
          if (!parsed.success) {
            diagnostics.push("changes_validation_failed");
            continue;
          }
          refMaxVersion.set(id, version);
          recordChangeRef(db, {
            sessionId,
            changeId: parsed.data.id,
            version: parsed.data.version,
            prevOid: span.prevOid,
            nextOid: span.nextOid,
          });
          carried.set(`${id}:v${version}`, parsed.data);
          const at = digestIndex.get(id);
          if (at !== undefined) digestHistory[at] = parsed.data.digest;
          else digestHistory.push(parsed.data.digest);
          ordered.push(parsed.data);
          fresh.push(parsed.data);
          continue;
        }
        // Already carried: fill in real prose when the model is on and the
        // row is still a skeleton, same id/version so progress never resets.
        if (carriedIds.has(id)) {
          const versionForId = carriedVersion.get(id) ?? null;
          const carriedRow =
            versionForId === null ? undefined : carried.get(`${id}:v${versionForId}`);
          const needsProse =
            carriedRow !== undefined &&
            modelConfig !== null &&
            filled < MAX_FILL_PER_RUN &&
            (carriedRow.origin ?? "skeleton") === "skeleton";
          if (needsProse && carriedRow && modelConfig !== null) {
            try {
              const filledRow = await narrateGroup({
                sessionId,
                config: modelConfig,
                group,
                prompts: groupPrompts,
                digests: digestHistory,
                prevOid: span.prevOid,
                nextOid: span.nextOid,
                id,
                version: carriedRow.version,
                createdFrom: skeleton.createdFrom,
              });
              if (filledRow !== null) {
                const key = `${filledRow.id}:v${filledRow.version}`;
                carried.set(key, filledRow);
                const at = digestIndex.get(filledRow.id);
                if (at !== undefined) digestHistory[at] = filledRow.digest;
                recordChangeRef(db, {
                  sessionId,
                  changeId: filledRow.id,
                  version: filledRow.version,
                  prevOid: span.prevOid,
                  nextOid: span.nextOid,
                });
                filled += 1;
                usedModel = true;
              } else {
                modelFallback = true;
              }
            } catch {
              modelFallback = true;
            }
          }
          const current = carried.get(`${id}:v${carriedVersion.get(id) ?? 0}`) ?? carriedRow;
          if (current) ordered.push(current);
          continue;
        }
        // Same span, different hash: a new version row, the old row stays.
        // A recorded-but-missing id reuses its recorded version (orphan heal).
        // (Rollups return early above with version 1 or their recorded one.)
        const version = refMaxVersion.get(id) ?? (frozenSpanVersion.get(spanKey) ?? 0) + 1;
        // Model narration is best-effort per group: any failure (transport,
        // shape, caps twice) falls back to the skeleton, whose digest still
        // feeds the summary like any other. Capped per run to bound spend.
        let narrated: Change | null = null;
        if (modelConfig !== null) {
          if (narratedCount >= MAX_NARRATE_PER_RUN) {
            diagnostics.push("changes_narrate_capped");
          } else {
            narratedCount += 1;
            try {
              narrated = await narrateGroup({
                sessionId,
                config: modelConfig,
                group,
                prompts: groupPrompts,
                digests: digestHistory,
                prevOid: span.prevOid,
                nextOid: span.nextOid,
                id,
                version,
                createdFrom: skeleton.createdFrom,
              });
            } catch {
              narrated = null;
            }
          }
          if (narrated !== null) usedModel = true;
          else if (narratedCount <= MAX_NARRATE_PER_RUN) modelFallback = true;
        }
        const parsed =
          narrated !== null
            ? { success: true as const, data: narrated }
            : ChangeSchema.safeParse({ ...skeleton, id, version, origin: "skeleton" as const });
        if (!parsed.success) {
          diagnostics.push("changes_validation_failed");
          continue;
        }
        refMaxVersion.set(id, version);
        recordChangeRef(db, {
          sessionId,
          changeId: parsed.data.id,
          version: parsed.data.version,
          prevOid: span.prevOid,
          nextOid: span.nextOid,
        });
        fresh.push(parsed.data);
        ordered.push(parsed.data);
        digestHistory.push(parsed.data.digest);
      }
    }
    if (modelFallback) diagnostics.push("changes_model_fallback");

    // Rebuild, never pile on: the list is what is current this run. Fell-out
    // rows leave the list (their DB rows and progress stay, just hidden);
    // carried rows keep id, version, prose and progress untouched.
    const changes = ordered;
    const summary = buildSessionSummaryFromDigests(changes.map((change) => change.digest));
    // Rerun-safe: nothing new and the same summary means nothing is
    // rewritten, so reruns are byte-identical and existing rows keep their
    // timestamps. A drifted summary (shape changed under a quiet session)
    // falls through to a prose-preserving rewrite below.
    if (
      fresh.length === 0 &&
      filled === 0 &&
      previous &&
      previousGated &&
      previous.summary === summary
    ) {
      const progressPath = progressArtifactPath(dataDir, session.projectId, sessionId);
      if (!existsSync(progressPath)) persistProgressFile(sessionId, session.projectId);
      // Watermark moved (or predates watermarks) while content didn't: advance
      // the stored watermark so the backfill stops picking this session on
      // every tick. Everything else stays byte-identical.
      const advanced = { ...previous, snapshotWatermark: watermark };
      if (
        previous.snapshotWatermark?.snapshotCount !== watermark.snapshotCount ||
        previous.snapshotWatermark?.lastOid !== watermark.lastOid
      ) {
        writeFileSync(artifactPath, `${JSON.stringify(advanced, null, 2)}\n`);
      }
      // Fresh artifact, possibly stale inbox columns: heal legacy rows.
      setSessionSummary(db, sessionId, previous.summary);
      await nameSessionFromModel({
        db,
        log,
        fetchImpl,
        redactJsonImpl,
        reasoningEffort: env.META_REASONING_EFFORT ?? "low",
        sessionId,
        config: modelConfig,
        changes: previous.changes,
      });
      return { outcome: "fresh", artifact: advanced };
    }
    const payload = {
      sessionId,
      generatedAt: clock().toISOString(),
      generator: usedModel ? CHANGE_MODEL_GENERATOR : (previous?.generator ?? CHANGES_GENERATOR),
      summary,
      diagnostics,
      changes,
      snapshotWatermark: watermark,
    };
    let scanned: ChangesArtifact;
    try {
      scanned = redactJsonImpl(payload).value as ChangesArtifact;
    } catch (error) {
      // Content-free diagnostic: never log the payload that failed.
      log.error({ session_id: sessionId, err: String(error) }, "changes redaction gate failed");
      return { outcome: "unavailable", artifact: null };
    }
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, `${JSON.stringify(scanned, null, 2)}\n`);
    persistProgressFile(sessionId, session.projectId);
    pruneChangeRefs(
      db,
      sessionId,
      scanned.changes.map((change) => change.id),
    );
    setSessionSummary(db, sessionId, scanned.summary);
    await nameSessionFromModel({
      db,
      log,
      fetchImpl,
      redactJsonImpl,
      reasoningEffort: env.META_REASONING_EFFORT ?? "low",
      sessionId,
      config: modelConfig,
      changes: scanned.changes,
    });
    return { outcome: "generated", artifact: scanned };
  }

  /**
   * One session per tick for the backfill timer. Missing artifacts first,
   * then snapshot-drifted ones, then inbox columns lagging the artifact,
   * then skeleton rows due for narration when the model is on. Sessions
   * with no diffs keep a watermark artifact and are skipped until their
   * snapshots change — never reprocessed per poll.
   */
  function findSessionNeedingChanges(modelOn: boolean): ChangesBackfillPick | null {
    const sessions = db
      .prepare(
        `SELECT s.id, s.project_id FROM sessions s
         WHERE EXISTS (SELECT 1 FROM snapshots WHERE session_id = s.id)
         ORDER BY s.updated_at DESC`,
      )
      .all() as Array<{ id: string; project_id: string }>;
    let fillCandidate: ChangesBackfillPick | null = null;
    for (const session of sessions) {
      const artifact = readArtifactFile(
        changesArtifactPath(dataDir, session.project_id, session.id),
        session.id,
      );
      if (!artifact) return { sessionId: session.id, reason: "missing" };
      // A recording session's watermark drifts on every tick, so picking it
      // would re-diff all pairs every 20s until it goes quiet. Skip live
      // sessions with an artifact; the reader serves the live slot meanwhile.
      // Silent sessions (null observed_at counts as quiet) still get picked.
      if (!isSessionQuiet(getSessionLastObservedAt(db, session.id), clock().getTime())) {
        continue;
      }
      // Pre-gate artifacts regenerate even when snapshots are unchanged:
      // their diffs may claim other sessions' shared-tree writes.
      if (!artifact.diagnostics.includes(CHANGES_EVIDENCE_GATE)) {
        return { sessionId: session.id, reason: "stale" };
      }
      const snaps = listSnapshots(db, session.id);
      const lastOid = snaps.length > 0 ? (snaps[snaps.length - 1]?.commitOid ?? null) : null;
      if (
        artifact.snapshotWatermark?.snapshotCount !== snaps.length ||
        artifact.snapshotWatermark?.lastOid !== lastOid
      ) {
        return { sessionId: session.id, reason: "stale" };
      }
      // Pre-split rollups self-heal on the backfill tick even when their
      // snapshots are quiet: the reader never sees a giant change twice.
      if (artifact.changes.some((change) => change.files.length > MAX_FILES_PER_CHANGE)) {
        return { sessionId: session.id, reason: "stale" };
      }
      // The summary builder is deterministic, so any drift means its shape
      // changed under a quiet session: one prose-preserving rewrite heals it.
      const summary = buildSessionSummaryFromDigests(
        artifact.changes.map((change) => change.digest),
      );
      if (artifact.summary !== summary) {
        return { sessionId: session.id, reason: "stale" };
      }
      // Inbox columns lag the artifact on legacy rows: one cheap run heals
      // them. The title flag needs the model on plus something to name
      // from — otherwise an unnameable session gets picked every tick.
      const inbox = db
        .prepare(
          `SELECT s.title, s.story_summary,
            EXISTS(SELECT 1 FROM events e WHERE e.session_id = s.id AND e.kind = 'prompt.submitted') AS has_prompt
           FROM sessions s WHERE s.id = ?`,
        )
        .get(session.id) as
        | { title: unknown; story_summary: unknown; has_prompt: unknown }
        | undefined;
      const titleMissing = inbox?.title === null || inbox?.title === "";
      const nameable = inbox?.has_prompt === 1 || artifact.changes.length > 0;
      if (inbox?.story_summary !== artifact.summary || (modelOn && titleMissing && nameable)) {
        return { sessionId: session.id, reason: "meta" };
      }
      if (
        modelOn &&
        fillCandidate === null &&
        artifact.changes.some((change) => (change.origin ?? "skeleton") === "skeleton")
      ) {
        fillCandidate = { sessionId: session.id, reason: "fill" };
      }
    }
    return fillCandidate;
  }

  function getChanges(sessionId: string): ChangesOutcome {
    const session = getSession(db, sessionId);
    if (!session) {
      return {
        status: 404,
        body: { error: { code: "not_found", message: "unknown session" } },
      };
    }
    const artifact = readArtifactFile(
      changesArtifactPath(dataDir, session.projectId, sessionId),
      sessionId,
    );
    const changes = artifact?.changes ?? [];
    // The DB owns progress (never reset by regen); the file is a mirror.
    const progress = toProgress(db, sessionId);
    // Liveness is tape silence, same rule as the story read-through: an
    // active session with nothing grouped yet reports waiting (the reader
    // renders still-going copy), while one that already has changes serves
    // them with the live flag for the in-progress slot.
    const isLive = !isSessionQuiet(getSessionLastObservedAt(db, sessionId), clock().getTime());
    if (isLive && changes.length === 0) {
      return { status: 202, body: { waiting: true, sessionId } };
    }
    const body: ChangesResponse = {
      changes,
      progress,
      summary: artifact ? artifact.summary : buildSessionSummaryFromDigests([]),
      isLive,
    };
    return { status: 200, body };
  }

  /**
   * On-demand unified diff for one stored change, between its own snapshot
   * pair and filtered to its own file list. Computed per request from
   * shadow git (local, milliseconds) and never persisted.
   */
  async function getChangeCode(sessionId: string, changeId: string): Promise<ChangesOutcome> {
    const session = getSession(db, sessionId);
    if (!session) {
      return {
        status: 404,
        body: { error: { code: "not_found", message: "unknown session" } },
      };
    }
    if (!ChangeIdSchema.safeParse(changeId).success) {
      return {
        status: 400,
        body: {
          error: {
            code: "invalid_request",
            message: "changeId must look like c_ plus 16 hex chars",
          },
        },
      };
    }
    const artifact = readArtifactFile(
      changesArtifactPath(dataDir, session.projectId, sessionId),
      sessionId,
    );
    const change = artifact?.changes.find((entry) => entry.id === changeId) ?? null;
    if (!change) {
      return {
        status: 404,
        body: { error: { code: "not_found", message: "unknown change" } },
      };
    }
    const shadowDir = join(dataDir, "projects", session.projectId, "shadow.git");
    let rawDiff: string;
    try {
      rawDiff = await diffShadowTrees(
        shadowDir,
        change.snapshotPair.prevOid,
        change.snapshotPair.nextOid,
      );
    } catch (error) {
      log.error(
        { session_id: sessionId, change_id: changeId, err: String(error) },
        "change code diff failed",
      );
      return {
        status: 503,
        body: {
          error: { code: "code_unavailable", message: "the snapshots for this change are gone" },
        },
      };
    }
    const chunks = new Map(splitDiffByFile(rawDiff).map((file) => [file.path, file.diff]));
    const files: ChangeCodeFile[] = change.files.map((file) => {
      const chunk = chunks.get(file.path);
      // A listed path with no diff chunk is a gap: served empty and flagged,
      // never silently dropped from the file list.
      if (chunk === undefined) {
        return { path: file.path, added: 0, removed: 0, truncated: true, hunks: [] };
      }
      return { path: file.path, ...parseCodeHunks(chunk) };
    });
    const parsed = ChangeCodeResponseSchema.safeParse({
      changeId: change.id,
      version: change.version,
      files,
    });
    if (!parsed.success) {
      log.error(
        { session_id: sessionId, change_id: changeId },
        "change code response failed validation",
      );
      return {
        status: 503,
        body: { error: { code: "code_unavailable", message: "the diff could not be served" } },
      };
    }
    return { status: 200, body: parsed.data };
  }

  function recordProgress(sessionId: string, body: unknown): ChangesOutcome {
    const parsed =
      body !== null && typeof body === "object"
        ? ProgressSchema.safeParse({
            ...(body as Record<string, unknown>),
            updatedAt: clock().toISOString(),
          })
        : ProgressSchema.safeParse(undefined);
    if (!parsed.success) {
      return {
        status: 400,
        body: {
          error: {
            code: "invalid_request",
            message: "changeId, version and state are required",
          },
        },
      };
    }
    const session = getSession(db, sessionId);
    if (!session) {
      return {
        status: 404,
        body: { error: { code: "not_found", message: "unknown session" } },
      };
    }
    // No redaction gate: ids, versions and states carry no content.
    const progress: Progress = parsed.data;
    storeProgressRow(db, {
      sessionId,
      changeId: progress.changeId,
      version: progress.version,
      state: progress.state,
    });
    persistProgressFile(sessionId, session.projectId);
    return { status: 200, body: progress };
  }

  return {
    maybeGenerateChanges,
    getChanges,
    getChangeCode,
    recordProgress,
    findSessionNeedingChanges,
  };
}

export type ChangesService = ReturnType<typeof createChangesService>;
