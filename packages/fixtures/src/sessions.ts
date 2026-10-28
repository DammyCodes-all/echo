import type { TapeEvent, TapeEventKind } from "@echo/contracts";
import { TapeEnvelopeSchema } from "@echo/contracts";
import {
  buildFileAttempts,
  type FileAttempt,
  type FileVersion,
  hunkFromParsed,
  type ParsedDiffHunk,
  parseUnifiedDiffs,
  type ReviewHunk,
} from "@echo/tape";
import { BASE_TS } from "./index";

const DAY_MS = 86_400_000;

/** Tape-only story fixture: prompts, tape, hunks, attempts, observed runs.
 *  No expected cards, badges, risk reasons, detours, blind spots or
 *  must-drop verdicts — those belong to the story validator once the locked
 *  contracts land. Everything here is computed, never asserted. */
export interface FixtureObservedRun {
  runId: string;
  command: string;
  exitCode: number | null;
  outcome: "ok" | "failed" | "interrupted";
  toolCallId: string | null;
  eventIds: string[];
  outputText: string | null;
}

export interface FixtureStoryFile {
  path: string;
  baseline: string;
  /** Child text per transition, in order. */
  versions: string[];
  transitionDiffs: string[];
  finalDiff: string;
}

export interface FixtureStorySession {
  slug: string;
  projectId: string;
  sessionId: string;
  prompts: string[];
  tape: TapeEvent[];
  hunks: ReviewHunk[];
  attempts: FileAttempt[];
  runs: FixtureObservedRun[];
  files: FixtureStoryFile[];
}

interface StoryEventInput {
  kind: TapeEventKind;
  payload: unknown;
  diagnostics?: string[];
  toolCallId?: string | null;
  sourceSequence?: number | null;
}

function storyEvent(
  session: { projectId: string; sessionId: string; slug: string },
  seq: number,
  baseTs: number,
  input: StoryEventInput,
): TapeEvent {
  const ts = new Date(baseTs + seq * 1000).toISOString();
  return TapeEnvelopeSchema.parse({
    v: 1,
    tape_seq: seq,
    event_id: `fixture-${session.slug}-${seq}`,
    record_key: null,
    session_id: session.sessionId,
    project_id: session.projectId,
    kind: input.kind,
    ts,
    observed_at: ts,
    source: {
      agent: "muse",
      adapter: "fixture",
      adapter_version: "0.1.0",
      build: null,
      schema: null,
      record_type: "synthetic",
      payload_type: null,
      // Explicit null (gap/marker-style events) must survive; only a
      // missing key falls back to the tape position.
      sequence: "sourceSequence" in input ? input.sourceSequence : seq,
      durability: "memory",
      origin: "import",
    },
    links: {
      turn_id: null,
      tool_call_id: input.toolCallId ?? null,
      batch_id: null,
      parent_session_id: null,
      subagent_id: null,
      snapshot: null,
    },
    payload: input.payload,
    redaction: { version: "fixture", findings: 0 },
    diagnostics: input.diagnostics ?? [],
  });
}

interface StoryFileInput {
  path: string;
  baseline: string;
  /** One entry per transition: the child text plus its link. */
  transitions: Array<{
    text: string;
    diff: string;
    snapshotId: string;
    commitOid: string;
    trigger: string;
    link: FileAttempt["link"];
    takenAtSeq: number;
  }>;
  finalDiff: string;
}

interface BuiltFile {
  hunks: ReviewHunk[];
  attempts: FileAttempt[];
  file: FixtureStoryFile;
}

function eventTs(baseTs: number, seq: number): string {
  return new Date(baseTs + seq * 1000).toISOString();
}

function buildFile(
  session: { sessionId: string },
  baseTs: number,
  input: StoryFileInput,
): BuiltFile {
  const versions: FileVersion[] = [
    {
      snapshotId: `${session.sessionId}-s0`,
      commitOid: `c-${session.sessionId}-0`,
      trigger: "baseline",
      eventId: null,
      takenAt: eventTs(baseTs, 1),
      text: input.baseline,
      captured: true,
      reason: null,
    },
  ];
  const hunksByTransition: ParsedDiffHunk[][] = [];
  const linksByTransition: Array<FileAttempt["link"]> = [];
  input.transitions.forEach((transition, index) => {
    const files = parseUnifiedDiffs(transition.diff);
    const file = files.find((entry) => (entry.newPath ?? entry.oldPath) === input.path);
    if (!file) throw new Error(`transition ${index} has no diff for ${input.path}`);
    hunksByTransition.push(file.hunks);
    linksByTransition.push(transition.link);
    versions.push({
      snapshotId: transition.snapshotId,
      commitOid: transition.commitOid,
      trigger: transition.trigger,
      eventId: transition.link.eventId,
      takenAt: eventTs(baseTs, transition.takenAtSeq),
      text: transition.text,
      captured: true,
      reason: null,
    });
  });
  const finalFiles = parseUnifiedDiffs(input.finalDiff);
  const finalFile = finalFiles.find((entry) => (entry.newPath ?? entry.oldPath) === input.path);
  if (!finalFile) throw new Error(`final diff has no entry for ${input.path}`);
  const hunks = finalFile.hunks.map((hunk) => hunkFromParsed(input.path, hunk));
  const finalText = versions[versions.length - 1]?.text ?? null;
  const attempts = buildFileAttempts({
    path: input.path,
    versions,
    hunksByTransition,
    linksByTransition,
    finalText,
  });
  return {
    hunks,
    attempts,
    file: {
      path: input.path,
      baseline: input.baseline,
      versions: input.transitions.map((transition) => transition.text),
      transitionDiffs: input.transitions.map((transition) => transition.diff),
      finalDiff: input.finalDiff,
    },
  };
}

function linkFor(
  eventId: string,
  toolCallId: string,
  toolOutcome: "completed" | "failed",
): FileAttempt["link"] {
  return { eventId, toolCallId, toolOutcome, turnId: null, batchId: null };
}

function sessionBase(index: number): number {
  return BASE_TS + index * DAY_MS;
}

function sessionShell(
  slug: string,
  sessionId: string,
  index: number,
): { projectId: string; sessionId: string; slug: string; baseTs: number } {
  return { projectId: "proj_fixture_story", sessionId, slug, baseTs: sessionBase(index) };
}

/** 1. High-risk payment retry with no observed verification. */
function buildPaymentRetry(): FixtureStorySession {
  const session = sessionShell("payment-retry", "sess_fixture_payment", 0);
  const baseline =
    "export async function chargeWithRetry(order: Order): Promise<Receipt> {\n  return charge(order);\n}\n";
  const fixed =
    "export async function chargeWithRetry(order: Order): Promise<Receipt> {\n" +
    "  let delayMs = 100;\n" +
    "  for (let attempt = 1; attempt <= 5; attempt++) {\n" +
    "    try {\n" +
    "      return await charge(order);\n" +
    "    } catch (error) {\n" +
    "      if (attempt === 5) throw error;\n" +
    "      await sleep(delayMs);\n" +
    "      delayMs *= 2;\n" +
    "    }\n" +
    "  }\n" +
    '  throw new Error("unreachable");\n' +
    "}\n";
  const prompt = "Retry failed payments with exponential backoff in src/payments/retry.ts";
  const tape = [
    storyEvent(session, 1, session.baseTs, {
      kind: "session.started",
      payload: { agent: "muse", model: "fixture" },
    }),
    storyEvent(session, 2, session.baseTs, {
      kind: "prompt.submitted",
      payload: { text: prompt },
    }),
    storyEvent(session, 3, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_edit_retry",
      payload: { name: "write", input: { path: "src/payments/retry.ts" } },
    }),
    storyEvent(session, 4, session.baseTs, {
      kind: "tool.completed",
      toolCallId: "call_edit_retry",
      payload: { name: "write", outcome: "ok", input: { path: "src/payments/retry.ts" } },
    }),
    storyEvent(session, 5, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_test_pay",
      payload: { name: "exec", input: { command: "npm test -- payments" } },
    }),
    storyEvent(session, 6, session.baseTs, {
      kind: "tool.failed",
      toolCallId: "call_test_pay",
      payload: {
        name: "exec",
        outcome: "error",
        exitCode: 1,
        output: "attempt 1: timeout\nattempt 2: timeout\nFAILED after 2 attempts",
      },
    }),
    storyEvent(session, 7, session.baseTs, {
      kind: "session.ended",
      payload: { outcome: "ok" },
    }),
  ];
  const { hunks, attempts, file } = buildFile(session, session.baseTs, {
    path: "src/payments/retry.ts",
    baseline,
    transitions: [
      {
        text: fixed,
        diff: [
          "diff --git a/src/payments/retry.ts b/src/payments/retry.ts",
          "--- a/src/payments/retry.ts",
          "+++ b/src/payments/retry.ts",
          "@@ -1,3 +1,13 @@",
          " export async function chargeWithRetry(order: Order): Promise<Receipt> {",
          "-  return charge(order);",
          "+  let delayMs = 100;",
          "+  for (let attempt = 1; attempt <= 5; attempt++) {",
          "+    try {",
          "+      return await charge(order);",
          "+    } catch (error) {",
          "+      if (attempt === 5) throw error;",
          "+      await sleep(delayMs);",
          "+      delayMs *= 2;",
          "+    }",
          "+  }",
          '+  throw new Error("unreachable");',
          " }",
        ].join("\n"),
        snapshotId: `${session.sessionId}-s1`,
        commitOid: `c-${session.sessionId}-1`,
        trigger: "tool.post",
        link: linkFor(`fixture-${session.slug}-4`, "call_edit_retry", "completed"),
        takenAtSeq: 4,
      },
    ],
    finalDiff: [
      "diff --git a/src/payments/retry.ts b/src/payments/retry.ts",
      "--- a/src/payments/retry.ts",
      "+++ b/src/payments/retry.ts",
      "@@ -1,3 +1,13 @@",
      " export async function chargeWithRetry(order: Order): Promise<Receipt> {",
      "-  return charge(order);",
      "+  let delayMs = 100;",
      "+  for (let attempt = 1; attempt <= 5; attempt++) {",
      "+    try {",
      "+      return await charge(order);",
      "+    } catch (error) {",
      "+      if (attempt === 5) throw error;",
      "+      await sleep(delayMs);",
      "+      delayMs *= 2;",
      "+    }",
      "+  }",
      '+  throw new Error("unreachable");',
      " }",
    ].join("\n"),
  });
  return {
    ...session,
    prompts: [prompt],
    tape,
    hunks,
    attempts,
    files: [file],
    runs: [
      {
        runId: "run-payments-test",
        command: "npm test -- payments",
        exitCode: 1,
        outcome: "failed",
        toolCallId: "call_test_pay",
        eventIds: [`fixture-${session.slug}-5`, `fixture-${session.slug}-6`],
        outputText: "attempt 1: timeout\nattempt 2: timeout\nFAILED after 2 attempts",
      },
    ],
  };
}

/** 2. Routine-only session: formatting, import order, internal rename. */
function buildRoutineCleanup(): FixtureStorySession {
  const session = sessionShell("routine", "sess_fixture_routine", 1);
  const baseline =
    'import { z } from "zod";\nimport { parse } from "./parse";\nexport function format(value: unknown): string {\nreturn String(parse(value));\n}\n';
  const final =
    'import { parseValue } from "./parse";\nimport { z } from "zod";\nexport function format(value: unknown): string {\n  return String(parseValue(value));\n}\n';
  const prompt = "Clean up formatting and imports in src/util/format.ts";
  const tape = [
    storyEvent(session, 1, session.baseTs, {
      kind: "session.started",
      payload: { agent: "muse", model: "fixture" },
    }),
    storyEvent(session, 2, session.baseTs, {
      kind: "prompt.submitted",
      payload: { text: prompt },
    }),
    storyEvent(session, 3, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_fmt",
      payload: { name: "format", input: { path: "src/util/format.ts" } },
    }),
    storyEvent(session, 4, session.baseTs, {
      kind: "tool.completed",
      toolCallId: "call_fmt",
      payload: { name: "format", outcome: "ok" },
    }),
    storyEvent(session, 5, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_imp",
      payload: { name: "organize-imports", input: { path: "src/util/format.ts" } },
    }),
    storyEvent(session, 6, session.baseTs, {
      kind: "tool.completed",
      toolCallId: "call_imp",
      payload: { name: "organize-imports", outcome: "ok" },
    }),
    storyEvent(session, 7, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_ren",
      payload: {
        name: "rename",
        input: { path: "src/util/format.ts", from: "parse", to: "parseValue" },
      },
    }),
    storyEvent(session, 8, session.baseTs, {
      kind: "tool.completed",
      toolCallId: "call_ren",
      payload: { name: "rename", outcome: "ok" },
    }),
    storyEvent(session, 9, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_lint",
      payload: { name: "exec", input: { command: "pnpm lint" } },
    }),
    storyEvent(session, 10, session.baseTs, {
      kind: "tool.completed",
      toolCallId: "call_lint",
      payload: { name: "exec", outcome: "ok", exitCode: 0 },
    }),
    storyEvent(session, 11, session.baseTs, {
      kind: "session.ended",
      payload: { outcome: "ok" },
    }),
  ];
  const diff = [
    "diff --git a/src/util/format.ts b/src/util/format.ts",
    "--- a/src/util/format.ts",
    "+++ b/src/util/format.ts",
    "@@ -1,5 +1,5 @@",
    '-import { z } from "zod";',
    '-import { parse } from "./parse";',
    '+import { parseValue } from "./parse";',
    '+import { z } from "zod";',
    " export function format(value: unknown): string {",
    "-return String(parse(value));",
    "+  return String(parseValue(value));",
    " }",
  ].join("\n");
  const { hunks, attempts, file } = buildFile(session, session.baseTs, {
    path: "src/util/format.ts",
    baseline,
    transitions: [
      {
        text: final,
        diff,
        snapshotId: `${session.sessionId}-s1`,
        commitOid: `c-${session.sessionId}-1`,
        trigger: "tool.post",
        link: linkFor(`fixture-${session.slug}-8`, "call_ren", "completed"),
        takenAtSeq: 8,
      },
    ],
    finalDiff: diff,
  });
  return {
    ...session,
    prompts: [prompt],
    tape,
    hunks,
    attempts,
    files: [file],
    runs: [
      {
        runId: "run-lint",
        command: "pnpm lint",
        exitCode: 0,
        outcome: "ok",
        toolCallId: "call_lint",
        eventIds: [`fixture-${session.slug}-9`, `fixture-${session.slug}-10`],
        outputText: "Checked 12 files. No fixes applied.",
      },
    ],
  };
}

/** 3. No-change research session: answers only, zero file changes. */
function buildResearchOnly(): FixtureStorySession {
  const session = sessionShell("research", "sess_fixture_research", 2);
  const prompts = ["Why does the retry loop use jitter?", "Where is the timeout configured?"];
  const tape = [
    storyEvent(session, 1, session.baseTs, {
      kind: "session.started",
      payload: { agent: "muse", model: "fixture" },
    }),
    storyEvent(session, 2, session.baseTs, {
      kind: "prompt.submitted",
      payload: { text: prompts[0] },
    }),
    storyEvent(session, 3, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_read_1",
      payload: { name: "read", input: { path: "src/payments/retry.ts" } },
    }),
    storyEvent(session, 4, session.baseTs, {
      kind: "tool.completed",
      toolCallId: "call_read_1",
      payload: { name: "read", outcome: "ok" },
    }),
    storyEvent(session, 5, session.baseTs, {
      kind: "agent.unknown",
      payload: { text: "The loop adds jitter so retries do not synchronize after an outage." },
    }),
    storyEvent(session, 6, session.baseTs, {
      kind: "prompt.submitted",
      payload: { text: prompts[1] },
    }),
    storyEvent(session, 7, session.baseTs, {
      kind: "agent.unknown",
      payload: { text: "The timeout lives in the payment provider client defaults." },
    }),
    storyEvent(session, 8, session.baseTs, {
      kind: "session.ended",
      payload: { outcome: "ok" },
    }),
  ];
  return { ...session, prompts, tape, hunks: [], attempts: [], runs: [], files: [] };
}

/** 4. Failed session: turn failure plus a failed tool with side effects. */
function buildFailedDeploy(): FixtureStorySession {
  const session = sessionShell("failed-deploy", "sess_fixture_deploy", 3);
  const baseline = "";
  const partial = "chunk 1/9 ok\nchunk 2/9 ok\nchunk 3/9 partial\n";
  const prompt = "Deploy the preview build";
  const tape = [
    storyEvent(session, 1, session.baseTs, {
      kind: "session.started",
      payload: { agent: "muse", model: "fixture" },
    }),
    storyEvent(session, 2, session.baseTs, {
      kind: "prompt.submitted",
      payload: { text: prompt },
    }),
    storyEvent(session, 3, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_deploy",
      payload: { name: "exec", input: { command: "./scripts/deploy-preview.sh" } },
    }),
    storyEvent(session, 4, session.baseTs, {
      kind: "tool.failed",
      toolCallId: "call_deploy",
      payload: {
        name: "exec",
        outcome: "error",
        exitCode: 1,
        output: "upload failed at chunk 3/9 (dist/preview.txt partial)",
      },
    }),
    storyEvent(session, 5, session.baseTs, {
      kind: "turn.failed",
      payload: { outcome: "error", error: { type: "deploy_failed" } },
    }),
    storyEvent(session, 6, session.baseTs, {
      kind: "session.ended",
      payload: { outcome: "error" },
    }),
  ];
  const diff = [
    "diff --git a/dist/preview.txt b/dist/preview.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/dist/preview.txt",
    "@@ -0,0 +1,3 @@",
    "+chunk 1/9 ok",
    "+chunk 2/9 ok",
    "+chunk 3/9 partial",
  ].join("\n");
  const { hunks, attempts, file } = buildFile(session, session.baseTs, {
    path: "dist/preview.txt",
    baseline,
    transitions: [
      {
        text: partial,
        diff,
        snapshotId: `${session.sessionId}-s1`,
        commitOid: `c-${session.sessionId}-1`,
        trigger: "tool.post",
        link: linkFor(`fixture-${session.slug}-4`, "call_deploy", "failed"),
        takenAtSeq: 4,
      },
    ],
    finalDiff: diff,
  });
  return {
    ...session,
    prompts: [prompt],
    tape,
    hunks,
    attempts,
    files: [file],
    runs: [
      {
        runId: "run-deploy",
        command: "./scripts/deploy-preview.sh",
        exitCode: 1,
        outcome: "failed",
        toolCallId: "call_deploy",
        eventIds: [`fixture-${session.slug}-3`, `fixture-${session.slug}-4`],
        outputText: "upload failed at chunk 3/9 (dist/preview.txt partial)",
      },
    ],
  };
}

/** 5. Partial capture: a sequence jump over unobserved records. */
function buildPartialGap(): FixtureStorySession {
  const session = sessionShell("partial-gap", "sess_fixture_partial", 4);
  const baseline = "export const store = new Map();\n";
  const migrated =
    'import Database from "./sqlite";\nexport const store = new Database("sessions.db");\n';
  const prompt = "Migrate the session store to SQLite";
  const tape = [
    storyEvent(session, 1, session.baseTs, {
      kind: "session.started",
      payload: { agent: "muse", model: "fixture" },
      sourceSequence: 3,
    }),
    storyEvent(session, 2, session.baseTs, {
      kind: "prompt.submitted",
      payload: { text: prompt },
      sourceSequence: 4,
    }),
    storyEvent(session, 3, session.baseTs, {
      kind: "capture.gap",
      payload: {
        code: "sequence_jump",
        stream_id: "ses_fixture_partial",
        from_sequence: 4,
        to_sequence: 9,
      },
      diagnostics: ["sequence_jump"],
      sourceSequence: null,
    }),
    storyEvent(session, 4, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_migrate_1",
      payload: { name: "write", input: { path: "src/db/store.ts" } },
      sourceSequence: 9,
    }),
    storyEvent(session, 5, session.baseTs, {
      kind: "tool.completed",
      toolCallId: "call_migrate_1",
      payload: { name: "write", outcome: "ok", input: { path: "src/db/store.ts" } },
      sourceSequence: 10,
    }),
    storyEvent(session, 6, session.baseTs, {
      kind: "session.ended",
      payload: { outcome: "ok" },
      sourceSequence: 11,
    }),
  ];
  const diff = [
    "diff --git a/src/db/store.ts b/src/db/store.ts",
    "--- a/src/db/store.ts",
    "+++ b/src/db/store.ts",
    "@@ -1,1 +1,2 @@",
    "-export const store = new Map();",
    '+import Database from "./sqlite";',
    '+export const store = new Database("sessions.db");',
  ].join("\n");
  const { hunks, attempts, file } = buildFile(session, session.baseTs, {
    path: "src/db/store.ts",
    baseline,
    transitions: [
      {
        text: migrated,
        diff,
        snapshotId: `${session.sessionId}-s1`,
        commitOid: `c-${session.sessionId}-1`,
        trigger: "tool.post",
        link: linkFor(`fixture-${session.slug}-5`, "call_migrate_1", "completed"),
        takenAtSeq: 5,
      },
    ],
    finalDiff: diff,
  });
  return { ...session, prompts: [prompt], tape, hunks, attempts, runs: [], files: [file] };
}

/** 6. Multi-topic session: costly revert chain plus one trivial dead end. */
function buildMultiTopic(): FixtureStorySession {
  const session = sessionShell("multi-topic", "sess_fixture_multi", 5);
  const homeBaseline = 'export const greeting = "hi";\n';
  const homeV2 = 'export const greeting = "hi";\nexport const loudGreeting = "hello!!";\n';
  const homeFinal = 'export const greeting = "hi";\nexport const loudGreeting = "hello";\n';
  const readmeBaseline = "An awsome project.\n";
  const readmeFinal = "An awesome project.\n";
  const prompts = [
    "Add a greeting to the homepage",
    "Fix the typo in the README",
    "Why is the build slow?",
  ];
  const tape = [
    storyEvent(session, 1, session.baseTs, {
      kind: "session.started",
      payload: { agent: "muse", model: "fixture" },
    }),
    storyEvent(session, 2, session.baseTs, {
      kind: "prompt.submitted",
      payload: { text: prompts[0] },
    }),
    storyEvent(session, 3, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_home_1",
      payload: { name: "write", input: { path: "src/home.ts", content: "hello!!" } },
    }),
    storyEvent(session, 4, session.baseTs, {
      kind: "tool.completed",
      toolCallId: "call_home_1",
      payload: { name: "write", outcome: "ok", input: { path: "src/home.ts" } },
    }),
    storyEvent(session, 5, session.baseTs, {
      kind: "prompt.submitted",
      payload: { text: prompts[1] },
    }),
    storyEvent(session, 6, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_readme",
      payload: { name: "edit", input: { path: "README.md", from: "awsome", to: "awesome" } },
    }),
    storyEvent(session, 7, session.baseTs, {
      kind: "tool.completed",
      toolCallId: "call_readme",
      payload: { name: "edit", outcome: "ok", input: { path: "README.md" } },
    }),
    storyEvent(session, 8, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_home_2",
      payload: { name: "write", input: { path: "src/home.ts", content: "hello" } },
    }),
    storyEvent(session, 9, session.baseTs, {
      kind: "tool.completed",
      toolCallId: "call_home_2",
      payload: { name: "write", outcome: "ok", input: { path: "src/home.ts" } },
    }),
    storyEvent(session, 10, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_test_home",
      payload: { name: "exec", input: { command: "npm test -- homepage" } },
    }),
    storyEvent(session, 11, session.baseTs, {
      kind: "tool.completed",
      toolCallId: "call_test_home",
      payload: { name: "exec", outcome: "ok", exitCode: 0 },
    }),
    storyEvent(session, 12, session.baseTs, {
      kind: "tool.requested",
      toolCallId: "call_lint_triv",
      payload: { name: "lint", input: { path: "src/unrelated.ts" } },
    }),
    storyEvent(session, 13, session.baseTs, {
      kind: "tool.failed",
      toolCallId: "call_lint_triv",
      payload: {
        name: "lint",
        outcome: "error",
        exitCode: 2,
        error: { type: "config_missing", detail: "no lint config" },
      },
    }),
    storyEvent(session, 14, session.baseTs, {
      kind: "prompt.submitted",
      payload: { text: prompts[2] },
    }),
    storyEvent(session, 15, session.baseTs, {
      kind: "agent.unknown",
      payload: { text: "The build spends most time in type checking." },
    }),
    storyEvent(session, 16, session.baseTs, {
      kind: "session.ended",
      payload: { outcome: "ok" },
    }),
  ];
  const homeDiffV1 = [
    "diff --git a/src/home.ts b/src/home.ts",
    "--- a/src/home.ts",
    "+++ b/src/home.ts",
    "@@ -1,1 +1,2 @@",
    ' export const greeting = "hi";',
    '+export const loudGreeting = "hello!!";',
  ].join("\n");
  const homeDiffV2 = [
    "diff --git a/src/home.ts b/src/home.ts",
    "--- a/src/home.ts",
    "+++ b/src/home.ts",
    "@@ -1,2 +1,2 @@",
    ' export const greeting = "hi";',
    '-export const loudGreeting = "hello!!";',
    '+export const loudGreeting = "hello";',
  ].join("\n");
  const homeFinalDiff = [
    "diff --git a/src/home.ts b/src/home.ts",
    "--- a/src/home.ts",
    "+++ b/src/home.ts",
    "@@ -1,1 +1,2 @@",
    ' export const greeting = "hi";',
    '+export const loudGreeting = "hello";',
  ].join("\n");
  const readmeDiff = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,1 +1,1 @@",
    "-An awsome project.",
    "+An awesome project.",
  ].join("\n");
  const home = buildFile(session, session.baseTs, {
    path: "src/home.ts",
    baseline: homeBaseline,
    transitions: [
      {
        text: homeV2,
        diff: homeDiffV1,
        snapshotId: `${session.sessionId}-s1`,
        commitOid: `c-${session.sessionId}-1`,
        trigger: "tool.post",
        link: linkFor(`fixture-${session.slug}-4`, "call_home_1", "completed"),
        takenAtSeq: 4,
      },
      {
        text: homeFinal,
        diff: homeDiffV2,
        snapshotId: `${session.sessionId}-s2`,
        commitOid: `c-${session.sessionId}-2`,
        trigger: "tool.post",
        link: linkFor(`fixture-${session.slug}-9`, "call_home_2", "completed"),
        takenAtSeq: 9,
      },
    ],
    finalDiff: homeFinalDiff,
  });
  const readme = buildFile(session, session.baseTs, {
    path: "README.md",
    baseline: readmeBaseline,
    transitions: [
      {
        text: readmeFinal,
        diff: readmeDiff,
        snapshotId: `${session.sessionId}-s3`,
        commitOid: `c-${session.sessionId}-3`,
        trigger: "tool.post",
        link: linkFor(`fixture-${session.slug}-7`, "call_readme", "completed"),
        takenAtSeq: 7,
      },
    ],
    finalDiff: readmeDiff,
  });
  return {
    ...session,
    prompts,
    tape,
    hunks: [...home.hunks, ...readme.hunks],
    attempts: [...home.attempts, ...readme.attempts],
    files: [home.file, readme.file],
    runs: [
      {
        runId: "run-home-test",
        command: "npm test -- homepage",
        exitCode: 0,
        outcome: "ok",
        toolCallId: "call_test_home",
        eventIds: [`fixture-${session.slug}-10`, `fixture-${session.slug}-11`],
        outputText: "1 passing",
      },
      {
        runId: "run-lint-trivial",
        command: "lint src/unrelated.ts",
        exitCode: 2,
        outcome: "failed",
        toolCallId: "call_lint_triv",
        eventIds: [`fixture-${session.slug}-12`, `fixture-${session.slug}-13`],
        outputText: "no lint config",
      },
    ],
  };
}

export function buildAllStorySessions(): FixtureStorySession[] {
  return [
    buildPaymentRetry(),
    buildRoutineCleanup(),
    buildResearchOnly(),
    buildFailedDeploy(),
    buildPartialGap(),
    buildMultiTopic(),
  ];
}
