import type { TapeEvent } from "@echo/contracts";
import type { FileAttempt, ReviewHunk } from "@echo/tape";

/**
 * Deterministic fact extraction (ARCHITECTURE §12, `generate_story` step 1).
 * Pure function over redacted inputs: no model, no DB, no filesystem. The
 * server gathers inputs and writes the artifact; this maps inputs to facts.
 *
 * Fact IDs are sequential (`F1`, `F2`, …) in a fixed emission order so a
 * finalized session re-extracts to identical IDs: prompts (tape order),
 * agent texts (tape order), hunks (path, position), attempts (path, time),
 * runs (request order), actions (run order), gaps (tape order).
 */
export interface FactExtractionInput {
  sessionId: string;
  tape: TapeEvent[];
  hunks: ReviewHunk[];
  attempts: FileAttempt[];
  /** Raw tape length. Defaults to the input length; callers that dedupe
   *  revisions pass the raw count so the watermark matches the tape. */
  tapeEventCount?: number;
}

export type FactKind = "prompt" | "agent_text" | "hunk" | "attempt" | "run" | "action" | "gap";

export interface PromptFact {
  id: string;
  kind: "prompt";
  eventId: string;
  tapeSeq: number;
  text: string;
}

/** Quotable agent-said text. Only `agent.unknown` carries a known text shape;
 *  model.response payloads are adapter-specific and stay out. */
export interface AgentTextFact {
  id: string;
  kind: "agent_text";
  eventId: string;
  tapeSeq: number;
  text: string;
}

export type MechanicalClass = "format_only" | "rename_only" | "generated" | "comment_only";

export interface MechanicalTag {
  class: MechanicalClass | null;
  reason: string | null;
}

export type BlastFlagName =
  | "auth"
  | "payments"
  | "stored_data"
  | "destructive"
  | "secrets"
  | "production";

export interface BlastFlag {
  flag: BlastFlagName;
  reason: string;
}

export interface HunkRisk {
  flags: BlastFlag[];
  unverifiedBoost: boolean;
  boostReasons: string[];
  rewriteCount: number;
  /** Import-graph centrality is unwired; always null rather than guessed. */
  centrality: null;
}

export interface HunkFact {
  id: string;
  kind: "hunk";
  hunkId: string;
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  addedLines: number;
  removedLines: number;
  /** Full side texts: the validator checks claim numbers/paths against them. */
  addedText: string;
  removedText: string;
  mechanical: MechanicalTag;
  risk: HunkRisk;
  /** A passing run anywhere in the session counts as coverage (coarse: tape
   *  carries no run-to-file linkage yet, so per-file attribution would be a
   *  guess). */
  passingRunObserved: boolean;
}

export interface AttemptFact {
  id: string;
  kind: "attempt";
  attemptId: string;
  path: string;
  status: FileAttempt["status"];
  confidence: FileAttempt["confidence"];
  introducedLines: number;
  survivingLines: number;
  eventId: string | null;
  toolCallId: string | null;
  trigger: string;
  takenAt: string;
}

export type RunOutcome = "ok" | "failed" | "interrupted";

export interface RunFact {
  id: string;
  kind: "run";
  runId: string;
  command: string;
  exitCode: number | null;
  outcome: RunOutcome;
  toolCallId: string;
  eventIds: string[];
  outputText: string | null;
}

export interface ActionFact {
  id: string;
  kind: "action";
  toolCallId: string;
  name: string;
  command: string | null;
  outcome: RunOutcome;
  runFactId: string | null;
}

export interface GapFact {
  id: string;
  kind: "gap";
  eventId: string;
  tapeSeq: number;
  code: string;
  fromSequence: number | null;
  toSequence: number | null;
  detail: string;
}

export type Fact =
  | PromptFact
  | AgentTextFact
  | HunkFact
  | AttemptFact
  | RunFact
  | ActionFact
  | GapFact;

export interface FactSet {
  sessionId: string;
  /** Raw tape length, so the validator can spot a stale watermark. */
  tapeEventCount: number;
  facts: Fact[];
}

function payloadOf(event: TapeEvent): Record<string, unknown> {
  if (typeof event.payload === "object" && event.payload !== null) {
    return event.payload as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function inputOf(payload: Record<string, unknown>): Record<string, unknown> {
  const input = payload.input;
  if (typeof input === "object" && input !== null) return input as Record<string, unknown>;
  return {};
}

function orderedTape(tape: TapeEvent[]): TapeEvent[] {
  return [...tape].sort((a, b) => a.tape_seq - b.tape_seq || a.event_id.localeCompare(b.event_id));
}

interface ToolCall {
  toolCallId: string;
  name: string;
  request: TapeEvent | null;
  completion: TapeEvent | null;
}

function collectToolCalls(tape: TapeEvent[]): ToolCall[] {
  const byCall = new Map<string, { request: TapeEvent | null; completion: TapeEvent | null }>();
  for (const event of tape) {
    const callId = event.links.tool_call_id;
    if (callId === null) continue;
    if (
      event.kind !== "tool.requested" &&
      event.kind !== "tool.completed" &&
      event.kind !== "tool.failed"
    ) {
      continue;
    }
    let entry = byCall.get(callId);
    if (!entry) {
      entry = { request: null, completion: null };
      byCall.set(callId, entry);
    }
    if (event.kind === "tool.requested" && entry.request === null) entry.request = event;
    if (
      (event.kind === "tool.completed" || event.kind === "tool.failed") &&
      entry.completion === null
    ) {
      entry.completion = event;
    }
  }
  const calls: ToolCall[] = [];
  for (const [toolCallId, entry] of byCall) {
    const source = entry.request ?? entry.completion;
    if (!source) continue;
    const name = asString(payloadOf(source).name) ?? "unknown";
    calls.push({ toolCallId, name, request: entry.request, completion: entry.completion });
  }
  calls.sort((a, b) => {
    const aSeq = (a.request ?? a.completion)?.tape_seq ?? 0;
    const bSeq = (b.request ?? b.completion)?.tape_seq ?? 0;
    return aSeq - bSeq || a.toolCallId.localeCompare(b.toolCallId);
  });
  return calls;
}

/** A tool call is a run when it carries a command or an exit code. Plain
 *  file tools (read/write/edit) report neither, so they stay actions-only. */
function isRun(call: ToolCall): boolean {
  if (call.request) {
    if (asString(inputOf(payloadOf(call.request)).command) !== null) return true;
  }
  if (call.completion) {
    if (asInt(payloadOf(call.completion).exitCode) !== null) return true;
  }
  return false;
}

function runOutcome(call: ToolCall): RunOutcome {
  if (!call.completion) return "interrupted";
  if (call.completion.kind === "tool.failed") return "failed";
  const payload = payloadOf(call.completion);
  if (payload.outcome === "error") return "failed";
  const exitCode = asInt(payload.exitCode);
  if (exitCode !== null && exitCode !== 0) return "failed";
  return "ok";
}

function runCommand(call: ToolCall): string {
  if (call.request) {
    const command = asString(inputOf(payloadOf(call.request)).command);
    if (command !== null) return command;
  }
  const source = call.request ?? call.completion;
  const path = source ? asString(inputOf(payloadOf(source)).path) : null;
  return path ? `${call.name} ${path}` : call.name;
}

function runOutput(call: ToolCall): string | null {
  if (!call.completion) return null;
  const payload = payloadOf(call.completion);
  const output = asString(payload.output);
  if (output !== null) return output;
  const error = payload.error;
  if (typeof error === "object" && error !== null) {
    return asString((error as Record<string, unknown>).detail);
  }
  return null;
}

const GENERATED_PATHS = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/,
  /\.min\.(js|css)$/,
  /\.bundle\.js$/,
];

const GENERATED_MARKER = /@generated|auto-generated/i;

const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === "" ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*/") ||
    trimmed === "*" ||
    trimmed.startsWith("* ")
  );
}

/** Tools whose only effect on a file is mechanical. `lint` is excluded: a
 *  bare lint run reports; only lint-with-fix rewrites, and the tape does not
 *  distinguish them. */
const MECHANICAL_TOOLS = new Set(["format", "organize-imports", "rename"]);

function fileToolsByPath(
  tape: TapeEvent[],
): Map<string, Array<{ name: string; toolCallId: string }>> {
  const byPath = new Map<string, Array<{ name: string; toolCallId: string }>>();
  for (const event of tape) {
    if (event.kind !== "tool.requested" && event.kind !== "tool.completed") continue;
    const callId = event.links.tool_call_id;
    if (callId === null) continue;
    const payload = payloadOf(event);
    const name = asString(payload.name);
    const path = asString(inputOf(payload).path);
    if (name === null || path === null) continue;
    const list = byPath.get(path) ?? [];
    if (!list.some((entry) => entry.toolCallId === callId)) list.push({ name, toolCallId: callId });
    byPath.set(path, list);
  }
  return byPath;
}

function classifyMechanical(
  hunk: ReviewHunk,
  fileTools: Map<string, Array<{ name: string; toolCallId: string }>>,
): MechanicalTag {
  if (GENERATED_PATHS.some((pattern) => pattern.test(hunk.path))) {
    return { class: "generated", reason: `generated or lockfile path: ${hunk.path}` };
  }
  if (GENERATED_MARKER.test(hunk.addedText)) {
    return { class: "generated", reason: `generated marker in added text of ${hunk.path}` };
  }
  if (CODE_EXTENSIONS.test(hunk.path)) {
    const lines = `${hunk.addedText}\n${hunk.removedText}`.split("\n");
    if (lines.length > 0 && lines.every(isCommentLine)) {
      return { class: "comment_only", reason: `only comments changed in ${hunk.path}` };
    }
  }
  const strip = (text: string) => text.replace(/\s+/g, "");
  if (hunk.addedText.length > 0 && hunk.removedText.length > 0) {
    if (strip(hunk.addedText) === strip(hunk.removedText)) {
      return { class: "format_only", reason: `whitespace-only change in ${hunk.path}` };
    }
  }
  const tools = fileTools.get(hunk.path) ?? [];
  if (tools.length > 0 && tools.every((tool) => MECHANICAL_TOOLS.has(tool.name))) {
    const names = [...new Set(tools.map((tool) => tool.name))].sort();
    const calls = [...new Set(tools.map((tool) => tool.toolCallId))].sort();
    const reason = `touched only by ${names.join("/")} (${calls.join(", ")})`;
    return {
      class: names.includes("rename") ? "rename_only" : "format_only",
      reason,
    };
  }
  return { class: null, reason: null };
}

// Blast-radius taxonomy (ARCHITECTURE §12). The flag set is a guess until
// hand-checked against 3 tapes; reasons always cite the matched evidence.
const PATH_FLAGS: Array<{ flag: BlastFlagName; pattern: RegExp; boundary: string }> = [
  {
    flag: "auth",
    pattern: /auth|login|logout|passwd|password|credential|oauth|jwt|passport|mfa/i,
    boundary: "auth boundary",
  },
  {
    flag: "payments",
    pattern: /payment|billing|checkout|charge|invoice|stripe|paypal/i,
    boundary: "payment boundary",
  },
  {
    flag: "stored_data",
    pattern: /\/db\/|^db\/|store|migration|schema|sql|sqlite|postgres|mongo|redis/i,
    boundary: "stored-data boundary",
  },
  { flag: "secrets", pattern: /\.env|secrets?\/|credentials?/i, boundary: "secret-adjacent path" },
  {
    flag: "production",
    pattern: /prod|production|deploy|infra|docker|k8s|terraform|cloudform/i,
    boundary: "production boundary",
  },
];

const DESTRUCTIVE_PATTERN =
  /rm\s+-rf|DROP\s+(TABLE|DATABASE)|deleteMany|deleteFrom|TRUNCATE|mkfs|:\(\)\s*\{/i;
const PRODUCTION_COMMAND = /deploy|release|prod/i;

// Large-mechanical-diff boost threshold (lines). Provisional until the
// ARCHITECTURE §12 hand-check against 3 tapes.
const LARGE_MECHANICAL_LINES = 50;

function blastFlagsFor(hunk: ReviewHunk, linkedCommands: string[]): BlastFlag[] {
  const flags: BlastFlag[] = [];
  for (const { flag, pattern, boundary } of PATH_FLAGS) {
    if (pattern.test(hunk.path)) {
      flags.push({ flag, reason: `${flag}: touches ${hunk.path} — ${boundary}` });
    }
  }
  const code = `${hunk.addedText}\n${hunk.removedText}`;
  if (DESTRUCTIVE_PATTERN.test(code)) {
    flags.push({
      flag: "destructive",
      reason: `destructive: ${hunk.path} matches a destructive pattern`,
    });
  }
  for (const command of linkedCommands) {
    if (PRODUCTION_COMMAND.test(command) && !flags.some((entry) => entry.flag === "production")) {
      flags.push({
        flag: "production",
        reason: `production: deploy command ${JSON.stringify(command)}`,
      });
    }
    if (DESTRUCTIVE_PATTERN.test(command) && !flags.some((entry) => entry.flag === "destructive")) {
      flags.push({
        flag: "destructive",
        reason: `destructive: command ${JSON.stringify(command)}`,
      });
    }
  }
  return flags;
}

const REWRITE_STATUSES: ReadonlySet<string> = new Set([
  "reverted",
  "replaced",
  "failed_with_side_effect",
]);

function gapDetail(code: string, from: number | null, to: number | null): string {
  if (from === null || to === null) return code;
  if (from + 1 > to - 1) return `${code} ${from}→${to}`;
  return `${code} ${from}→${to} (sequences ${from + 1}-${to - 1} unobserved)`;
}

export function extractFacts(input: FactExtractionInput): FactSet {
  const tape = orderedTape(input.tape);
  const hunks = [...input.hunks].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.oldStart - b.oldStart ||
      a.newStart - b.newStart ||
      a.id.localeCompare(b.id),
  );
  // Baseline pseudo-nodes are pre-session state, not behavior: they get no
  // fact. The story sees landed/reverted/replaced/failed attempts only.
  const attempts = [...input.attempts]
    .filter((attempt) => attempt.status !== "baseline")
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.takenAt.localeCompare(b.takenAt) ||
        a.id.localeCompare(b.id),
    );
  const calls = collectToolCalls(tape);
  const fileTools = fileToolsByPath(tape);

  let nextId = 1;
  const takeId = () => `F${nextId++}`;
  const facts: Fact[] = [];

  for (const event of tape) {
    if (event.kind !== "prompt.submitted") continue;
    const text = asString(payloadOf(event).text);
    if (text === null || text === "") continue;
    const fact: PromptFact = {
      id: takeId(),
      kind: "prompt",
      eventId: event.event_id,
      tapeSeq: event.tape_seq,
      text,
    };
    facts.push(fact);
  }

  for (const event of tape) {
    if (event.kind !== "agent.unknown") continue;
    const text = asString(payloadOf(event).text);
    if (text === null) continue;
    const fact: AgentTextFact = {
      id: takeId(),
      kind: "agent_text",
      eventId: event.event_id,
      tapeSeq: event.tape_seq,
      text,
    };
    facts.push(fact);
  }

  const runCalls = calls.filter(isRun);
  const passingRunObserved = runCalls.some((call) => runOutcome(call) === "ok");
  const gaps = tape.filter((event) => event.kind === "capture.gap");
  const gapSummaries = gaps.map((event) => {
    const payload = payloadOf(event);
    const code = asString(payload.code) ?? "unknown";
    return gapDetail(code, asInt(payload.from_sequence), asInt(payload.to_sequence));
  });
  const commandsByCall = new Map(
    runCalls.map((call) => [call.toolCallId, runCommand(call)] as const),
  );

  for (const hunk of hunks) {
    const mechanical = classifyMechanical(hunk, fileTools);
    const linkedCommands = attempts.flatMap((attempt) => {
      if (attempt.path !== hunk.path || attempt.link.toolCallId === null) return [];
      const command = commandsByCall.get(attempt.link.toolCallId);
      return command === undefined ? [] : [command];
    });
    const flags = blastFlagsFor(hunk, linkedCommands);
    const boostReasons: string[] = [];
    if (!passingRunObserved) boostReasons.push("no passing run observed in this session");
    for (const summary of gapSummaries) boostReasons.push(`capture gap in session: ${summary}`);
    const pathAttempts = attempts.filter((attempt) => attempt.path === hunk.path);
    if (!pathAttempts.some((attempt) => attempt.survivingLines > 0)) {
      boostReasons.push(`no surviving attempt evidence for ${hunk.path}`);
    }
    const changedLines = hunk.addedLines + hunk.removedLines;
    if (
      mechanical.class !== null &&
      changedLines > LARGE_MECHANICAL_LINES &&
      runCalls.length === 0
    ) {
      boostReasons.push(`large mechanical diff (${changedLines} lines) with no observed run`);
    }
    const fact: HunkFact = {
      id: takeId(),
      kind: "hunk",
      hunkId: hunk.id,
      path: hunk.path,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      addedLines: hunk.addedLines,
      removedLines: hunk.removedLines,
      addedText: hunk.addedText,
      removedText: hunk.removedText,
      mechanical,
      risk: {
        flags,
        unverifiedBoost: boostReasons.length > 0,
        boostReasons,
        rewriteCount: pathAttempts.filter((attempt) => REWRITE_STATUSES.has(attempt.status)).length,
        centrality: null,
      },
      passingRunObserved,
    };
    facts.push(fact);
  }

  for (const attempt of attempts) {
    const fact: AttemptFact = {
      id: takeId(),
      kind: "attempt",
      attemptId: attempt.id,
      path: attempt.path,
      status: attempt.status,
      confidence: attempt.confidence,
      introducedLines: attempt.introducedLines,
      survivingLines: attempt.survivingLines,
      eventId: attempt.eventId,
      toolCallId: attempt.link.toolCallId,
      trigger: attempt.trigger,
      takenAt: attempt.takenAt,
    };
    facts.push(fact);
  }

  const runFactIds = new Map<string, string>();
  for (const call of runCalls) {
    const eventIds = [call.request, call.completion]
      .filter((event): event is TapeEvent => event !== null)
      .map((event) => event.event_id);
    const completion = call.completion ? payloadOf(call.completion) : {};
    const fact: RunFact = {
      id: takeId(),
      kind: "run",
      runId: `run-${call.toolCallId}`,
      command: runCommand(call),
      exitCode: asInt(completion.exitCode),
      outcome: runOutcome(call),
      toolCallId: call.toolCallId,
      eventIds,
      outputText: runOutput(call),
    };
    runFactIds.set(call.toolCallId, fact.id);
    facts.push(fact);
  }

  for (const call of runCalls) {
    const fact: ActionFact = {
      id: takeId(),
      kind: "action",
      toolCallId: call.toolCallId,
      name: call.name,
      command: runCommand(call),
      outcome: runOutcome(call),
      runFactId: runFactIds.get(call.toolCallId) ?? null,
    };
    facts.push(fact);
  }

  for (const event of gaps) {
    const payload = payloadOf(event);
    const code = asString(payload.code) ?? "unknown";
    const from = asInt(payload.from_sequence);
    const to = asInt(payload.to_sequence);
    const fact: GapFact = {
      id: takeId(),
      kind: "gap",
      eventId: event.event_id,
      tapeSeq: event.tape_seq,
      code,
      fromSequence: from,
      toSequence: to,
      detail: gapDetail(code, from, to),
    };
    facts.push(fact);
  }

  return {
    sessionId: input.sessionId,
    tapeEventCount: input.tapeEventCount ?? input.tape.length,
    facts,
  };
}
