import { createHash } from "node:crypto";
import type {
  SessionReview,
  SessionStory,
  StoredEvent,
  TapeWatermark,
  VerificationBadge,
} from "@echo/contracts";

export interface StoryFact {
  id: string;
  kind: "prompt" | "hunk" | "action" | "attempt" | "run" | "routine";
  summary: string;
  eventIds: string[];
  files: string[];
  riskFlags: string[];
  riskReasons: string[];
  verification: VerificationBadge;
  testedByRunIds: string[];
}

export interface PromptCluster {
  id: string;
  promptEventId: string;
  text: string;
  index: number;
}

export interface FactSet {
  sessionId: string;
  promptClusters: PromptCluster[];
  facts: StoryFact[];
  routineFactIds: string[];
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Best-effort human text for prompt/content payloads. Internal shape, not evidence. */
function eventText(event: Pick<StoredEvent, "payload">): string {
  const payload = event.payload;
  if (typeof payload === "string") return payload;
  const record = payloadRecord(payload);
  if (!record) return "";
  const direct = asText(record.text);
  if (direct !== null) return direct;
  if (Array.isArray(record.parts)) {
    const joined = record.parts
      .filter((part): part is Record<string, unknown> => part !== null && typeof part === "object")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter((text) => text.length > 0)
      .join("\n");
    if (joined.length > 0) return joined;
  }
  const name = asText(record.name) ?? asText(record.tool) ?? "";
  const input = record.input ?? record.command ?? record.args;
  const target = typeof input === "string" ? input : JSON.stringify(input ?? "");
  return `${name} ${target}`.trim();
}

/** Tool name + command text for tool.* events. Empty strings when absent. */
function toolNameAndCommand(event: Pick<StoredEvent, "payload">): {
  name: string;
  command: string;
} {
  const payload = event.payload;
  if (typeof payload === "string") return { name: "", command: payload };
  const record = payloadRecord(payload);
  if (!record) return { name: "", command: "" };
  const name = asText(record.name) ?? asText(record.tool) ?? asText(record.toolName) ?? "";
  const rawCommand =
    asText(record.command) ??
    asText(record.cmd) ??
    (typeof record.input === "string"
      ? record.input
      : asText(payloadRecord(record.input)?.command ?? null)) ??
    "";
  const args = Array.isArray(record.args)
    ? record.args.filter((arg): arg is string => typeof arg === "string").join(" ")
    : "";
  const command = rawCommand !== "" ? rawCommand : args !== "" ? `${name} ${args}`.trim() : "";
  return { name, command };
}

interface BlastRule {
  flag: string;
  pattern: RegExp;
  reason: (path: string) => string;
}

const BLAST_RULES: BlastRule[] = [
  {
    flag: "auth",
    pattern: /auth|login|session|token|password/i,
    reason: (p) => `touches auth code (${p})`,
  },
  {
    flag: "payments",
    pattern: /pay|billing|stripe|checkout|invoice/i,
    reason: (p) => `touches payment code (${p})`,
  },
  {
    flag: "stored_data",
    pattern: /migrat|schema|\.sql|drop table/i,
    reason: (p) => `touches stored data or migrations (${p})`,
  },
  {
    flag: "destructive",
    pattern: /rm -rf|\bdelete\b|drop|revoke/i,
    reason: (p) => `looks destructive (${p})`,
  },
  {
    flag: "secrets",
    pattern: /secret|api[_-]?key|credential|passwd/i,
    reason: (p) => `touches secrets or credentials (${p})`,
  },
  {
    flag: "production",
    pattern: /prod|deploy|release/i,
    reason: (p) => `touches production or deploy config (${p})`,
  },
];

function blastFlags(path: string, content: string): { riskFlags: string[]; riskReasons: string[] } {
  const haystack = `${path}\n${content}`;
  const riskFlags: string[] = [];
  const riskReasons: string[] = [];
  for (const rule of BLAST_RULES) {
    if (rule.pattern.test(haystack)) {
      riskFlags.push(rule.flag);
      riskReasons.push(rule.reason(path));
    }
  }
  return { riskFlags, riskReasons };
}

/** First changed line, stripped of diff/comment markers, as one-line context. */
function hunkContext(addedText: string, removedText: string): string {
  const first = `${addedText}\n${removedText}`
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^[+\-#/*\s]+/, "")
        .trim(),
    )
    .find((line) => line.length > 0);
  if (!first) return "changes";
  return first.length > 40 ? `${first.slice(0, 39)}…` : first;
}

const ROUTINE_FILENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
]);

function isGeneratedPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return (
    ROUTINE_FILENAMES.has(base) ||
    path.startsWith("dist/") ||
    path.includes("/dist/") ||
    path.endsWith(".min.js") ||
    path.endsWith(".d.ts") ||
    path.endsWith(".pb.go")
  );
}

function isWhitespacePatch(patch: string, addedText: string, removedText: string): boolean {
  const lines = patch
    .split("\n")
    .filter((line) => !/^(---|\+\+\+|@@)/.test(line))
    .map((line) =>
      line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") ? line.slice(1) : line,
    );
  const changed = `${addedText}\n${removedText}`.split("\n");
  const meaningful = [...lines, ...changed].filter((line) => line.length > 0);
  if (meaningful.length === 0) return addedText.length + removedText.length + patch.length > 0;
  return meaningful.every((line) => /^\s*$/.test(line));
}

const COMMENT_PREFIX = /^(\/\/|#|\/\*|\*|<!--)/;

function isCommentOnlyPatch(addedText: string, removedText: string): boolean {
  const lines = `${addedText}\n${removedText}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => COMMENT_PREFIX.test(line));
}

const ACTION_PATTERN = /run|exec|push|deploy|migrate|\brm\b|delete/i;
const RUNLIKE_PATTERN =
  /exec|run|test|bash|shell|command|check|lint|build|typecheck|vitest|jest|pytest|npm|pnpm|yarn|bun|node|python|cargo|\bgo\b|make/i;

function exitIndicatesPass(value: unknown): boolean {
  if (value === 0) return true;
  if (typeof value !== "string") return false;
  return ["0", "success", "ok", "passed", "completed", "exit 0"].includes(
    value.trim().toLowerCase(),
  );
}

function runPassed(payload: unknown): boolean {
  const record = payloadRecord(payload);
  if (!record) return false;
  const candidate =
    record.exit_code ?? record.exitCode ?? record.status ?? record.exitStatus ?? null;
  return exitIndicatesPass(candidate);
}

/** Carrier token so skeletonStory can map attempt status without a second channel. */
function attemptStatusToken(status: string): string {
  return `attempt-status:${status}`;
}

function attemptStatusOf(fact: StoryFact): string | null {
  const token = fact.riskFlags.find((flag) => flag.startsWith("attempt-status:"));
  return token ? token.slice("attempt-status:".length) : null;
}

export function buildFacts(review: SessionReview, events: StoredEvent[]): FactSet {
  const ordered = [...events].sort((a, b) => a.tape_seq - b.tape_seq);
  const indexByEventId = new Map(ordered.map((event, index) => [event.event_id, index]));

  const promptClusters: PromptCluster[] = [];
  let promptCount = 0;
  for (const event of ordered) {
    if (event.kind !== "prompt.submitted") continue;
    promptCount += 1;
    promptClusters.push({
      id: `P${promptCount}`,
      promptEventId: event.event_id,
      text: truncate(eventText(event), 500),
      index: promptCount - 1,
    });
  }

  const facts: StoryFact[] = [];
  const hunkFacts: StoryFact[] = [];

  for (const hunk of review.hunks) {
    const content = `${hunk.patch}\n${hunk.addedText}\n${hunk.removedText}`;
    const { riskFlags, riskReasons } = blastFlags(hunk.path, content);
    const evidence = review.evidenceByHunk[hunk.id] ?? [];
    const eventIds = [
      ...new Set(evidence.map((entry) => entry.eventId).filter((id): id is string => id !== null)),
    ];
    let summary = `${hunk.path}: +${hunk.addedLines} \u2212${hunk.removedLines} around ${hunkContext(hunk.addedText, hunk.removedText)}`;
    let routineReason: string | null = null;
    if (isGeneratedPath(hunk.path)) routineReason = "generated file";
    else if (isWhitespacePatch(hunk.patch, hunk.addedText, hunk.removedText))
      routineReason = "whitespace-only";
    else if (isCommentOnlyPatch(hunk.addedText, hunk.removedText)) routineReason = "comment-only";
    if (routineReason) summary += ` (routine: ${routineReason})`;
    const fact: StoryFact = {
      id: hunk.id,
      kind: "hunk",
      summary,
      eventIds,
      files: [hunk.path],
      riskFlags,
      riskReasons,
      verification: "nothing",
      testedByRunIds: [],
    };
    facts.push(fact);
    hunkFacts.push(fact);
  }

  const routineFactIds = hunkFacts
    .filter((fact) => fact.summary.includes("(routine: "))
    .map((fact) => fact.id);

  const runCommands = new Map<string, { command: string; index: number }>();
  let actionCount = 0;
  let runCount = 0;
  for (const event of ordered) {
    if (!event.kind.startsWith("tool.")) continue;
    const { name, command } = toolNameAndCommand(event);
    const haystack = `${name} ${command}`.trim();
    if (event.kind !== "tool.completed" || !runPassed(event.payload)) {
      if (ACTION_PATTERN.test(haystack)) {
        actionCount += 1;
        facts.push({
          id: `A${actionCount}`,
          kind: "action",
          summary: truncate(
            `ran consequential tool action: ${command !== "" ? command : name}`,
            200,
          ),
          eventIds: [event.event_id],
          files: [],
          riskFlags: [],
          riskReasons: [],
          verification: "nothing",
          testedByRunIds: [],
        });
      }
      continue;
    }
    if (RUNLIKE_PATTERN.test(haystack)) {
      runCount += 1;
      const id = `R${runCount}`;
      facts.push({
        id,
        kind: "run",
        summary: truncate(`ran ${command !== "" ? command : name} (exit 0, observed pass)`, 200),
        eventIds: [event.event_id],
        files: [],
        riskFlags: [],
        riskReasons: [],
        verification: "nothing",
        testedByRunIds: [],
      });
      runCommands.set(id, {
        command: command !== "" ? command : name,
        index: indexByEventId.get(event.event_id) ?? -1,
      });
    } else if (ACTION_PATTERN.test(haystack)) {
      actionCount += 1;
      facts.push({
        id: `A${actionCount}`,
        kind: "action",
        summary: truncate(`ran consequential tool action: ${command !== "" ? command : name}`, 200),
        eventIds: [event.event_id],
        files: [],
        riskFlags: [],
        riskReasons: [],
        verification: "nothing",
        testedByRunIds: [],
      });
    }
  }

  for (const attempt of review.attempts) {
    if (
      attempt.status !== "reverted" &&
      attempt.status !== "replaced" &&
      attempt.status !== "failed" &&
      attempt.status !== "failed_with_side_effect"
    ) {
      continue;
    }
    const eventIds = attempt.eventId
      ? [attempt.eventId]
      : attempt.link.eventId
        ? [attempt.link.eventId]
        : [];
    facts.push({
      id: attempt.id,
      kind: "attempt",
      summary: truncate(attempt.detail, 200),
      eventIds,
      files: [attempt.path],
      riskFlags: [attemptStatusToken(attempt.status)],
      riskReasons: [],
      verification: "nothing",
      testedByRunIds: [],
    });
  }

  // Heuristic run→hunk link: substring match of the hunk path (or its parent
  // dir) in the run command, anchored after the hunk's latest introducing
  // evidence event. Substrings over-match (dir names in flags) and miss
  // renames or bare filenames run from another cwd; the validator owns truth.
  for (const hunk of review.hunks) {
    const fact = hunkFacts.find((entry) => entry.id === hunk.id);
    if (!fact) continue;
    const evidence = review.evidenceByHunk[hunk.id] ?? [];
    const anchors = evidence
      .filter((entry) => entry.relation === "introduced_by" || entry.relation === "touched_by")
      .map((entry) => (entry.eventId ? indexByEventId.get(entry.eventId) : undefined))
      .filter((index): index is number => index !== undefined);
    if (anchors.length === 0) continue;
    const anchor = Math.max(...anchors);
    const parentDir = hunk.path.includes("/")
      ? hunk.path.slice(0, hunk.path.lastIndexOf("/"))
      : null;
    const linked: string[] = [];
    for (const [runId, run] of runCommands) {
      if (run.index <= anchor) continue;
      if (
        run.command.includes(hunk.path) ||
        (parentDir !== null && run.command.includes(parentDir))
      ) {
        linked.push(runId);
      }
    }
    fact.testedByRunIds = linked;
    // The validator owns final badges; a skeleton never claims "observed"
    // because a passing command that names a path is only weak evidence the
    // hunk itself was exercised.
    fact.verification = linked.length > 0 ? "partly_observed" : "nothing";
  }

  return { sessionId: review.sessionId, promptClusters, facts, routineFactIds };
}

export function computeWatermark(events: Array<{ event_id: string }>): TapeWatermark {
  const sha256 = createHash("sha256")
    .update(events.map((event) => event.event_id).join("\n"))
    .digest("hex");
  return { eventCount: events.length, sha256 };
}

export function skeletonStory(args: {
  sessionId: string;
  facts: FactSet;
  watermark: TapeWatermark;
  captureQuality: string;
}): SessionStory {
  const hunkFacts = args.facts.facts.filter((fact) => fact.kind === "hunk");
  const routine = new Set(args.facts.routineFactIds);
  const liveHunks = hunkFacts.filter((fact) => !routine.has(fact.id));
  const actionFacts = args.facts.facts.filter((fact) => fact.kind === "action");
  const attemptFacts = args.facts.facts.filter((fact) => fact.kind === "attempt");

  const firstPrompt = args.facts.promptClusters[0];
  const summary = firstPrompt
    ? firstPrompt.text.slice(0, 140)
    : `Session with ${liveHunks.length} changes.`;

  const shortVersion = [
    {
      text: `Session includes ${args.facts.promptClusters.length} prompts, ${liveHunks.length} file changes and ${actionFacts.length} consequential actions.`,
      label: "observed" as const,
      factIds: args.facts.promptClusters.map((cluster) => cluster.id),
    },
    {
      text: "How these changes fit together is not yet narrated; regenerate after the Phase 2 model slice.",
      label: "uncertain" as const,
      factIds: [],
    },
  ];

  const cards = liveHunks.map((fact, index) => ({
    id: fact.id,
    headline: fact.summary,
    constituentHunkIds: [fact.id],
    constituentActionIds: [] as string[],
    rank: index + 1,
    sessionOrder: index,
    highRisk: fact.riskFlags.length > 0,
    riskReasons: [...fact.riskReasons],
    verification: fact.verification,
    why: [],
    before: [],
    now: [],
    checkedBy: [],
    touches: [...fact.files],
    moment: {
      eventId: fact.eventIds[0] ?? null,
      toolCallId: null,
      ts: null,
      excerpt: fact.summary,
      label: "uncertain" as const,
    },
    history: { priorSessionIds: [] as string[], previousPicture: null, note: null },
  }));

  const attemptsByPath = new Map<string, number>();
  for (const fact of attemptFacts) {
    const key = fact.files[0] ?? "";
    attemptsByPath.set(key, (attemptsByPath.get(key) ?? 0) + 1);
  }
  const detours = attemptFacts.map((fact) => {
    const status = attemptStatusOf(fact);
    let costReason: "reverted" | "side_effect" | "repeated_attempt" = "reverted";
    if (status === "failed_with_side_effect") costReason = "side_effect";
    else if (status === "failed" && (attemptsByPath.get(fact.files[0] ?? "") ?? 0) >= 2) {
      costReason = "repeated_attempt";
    }
    return {
      id: fact.id,
      headline: fact.summary,
      claims: [{ text: fact.summary, label: "uncertain" as const, factIds: [fact.id] }],
      attemptIds: [fact.id],
      costReason,
    };
  });

  const blindSpots: string[] = [];
  if (args.captureQuality === "partial" || args.captureQuality === "import_only") {
    blindSpots.push("intermediate states may not be captured");
  }

  const verifiedCounts = {
    observed: 0,
    partlyObserved: 0,
    agentStated: 0,
    nothing: 0,
    total: cards.length,
  };
  for (const card of cards) {
    if (card.verification === "observed") verifiedCounts.observed += 1;
    else if (card.verification === "partly_observed") verifiedCounts.partlyObserved += 1;
    else if (card.verification === "agent_stated") verifiedCounts.agentStated += 1;
    else verifiedCounts.nothing += 1;
  }

  return {
    schemaVersion: 1,
    sessionId: args.sessionId,
    generatedAt: new Date().toISOString(),
    generator: { kind: "skeleton", model: null, promptVersion: "skeleton-v1" },
    tapeWatermark: args.watermark,
    summary,
    skeleton: true,
    shortVersion,
    askVsResult: {
      asked: args.facts.promptClusters.map((cluster) => ({
        text: cluster.text,
        label: "agent_stated" as const,
        factIds: [cluster.id],
      })),
      delivered: [],
      extras: [],
      missing: [],
    },
    cards,
    routineSummary:
      args.facts.routineFactIds.length > 0
        ? `${args.facts.routineFactIds.length} routine changes (formatting, generated files, lockfiles) folded.`
        : null,
    detours,
    looseEnds: [],
    blindSpots,
    gaps: [],
    verifiedCounts,
  };
}
