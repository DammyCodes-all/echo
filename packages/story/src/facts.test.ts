import type { TapeEvent, TapeEventKind } from "@echo/contracts";
import { buildAllStorySessions, type FixtureStorySession } from "@echo/fixtures";
import type { FileAttempt, ReviewHunk } from "@echo/tape";
import { describe, expect, it } from "vitest";
import {
  type ActionFact,
  type AttemptFact,
  extractFacts,
  type FactSet,
  type GapFact,
  type HunkFact,
  type PromptFact,
  type RunFact,
} from "./facts";

function factsFor(slug: string): { session: FixtureStorySession; facts: FactSet } {
  const session = buildAllStorySessions().find((entry) => entry.slug === slug);
  if (!session) throw new Error(`fixture session missing: ${slug}`);
  const facts = extractFacts({
    sessionId: session.sessionId,
    tape: session.tape,
    hunks: session.hunks,
    attempts: session.attempts,
  });
  return { session, facts };
}

function ofKind<T>(facts: FactSet, kind: string): T[] {
  return facts.facts.filter((fact) => fact.kind === kind) as T[];
}

function tapeEvent(
  seq: number,
  kind: TapeEventKind,
  options: { toolCallId?: string | null; payload?: unknown } = {},
): TapeEvent {
  const ts = `2026-10-28T10:00:${String(seq).padStart(2, "0")}.000Z`;
  return {
    v: 1,
    tape_seq: seq,
    event_id: `test-${seq}`,
    record_key: null,
    session_id: "ses_test",
    project_id: "proj_test",
    kind,
    ts,
    observed_at: ts,
    source: {
      agent: "muse",
      adapter: "test",
      adapter_version: "0.1.0",
      build: null,
      schema: null,
      record_type: "synthetic",
      payload_type: null,
      sequence: seq,
      durability: "memory",
      origin: "import",
    },
    links: {
      turn_id: null,
      tool_call_id: options.toolCallId ?? null,
      batch_id: null,
      parent_session_id: null,
      subagent_id: null,
      snapshot: null,
    },
    payload: options.payload ?? {},
    redaction: { version: "test", findings: 0 },
    diagnostics: [],
  };
}

function makeHunk(overrides: Partial<ReviewHunk> = {}): ReviewHunk {
  return {
    id: "h_0123456789abcdef",
    path: "src/app.ts",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    patch: "@@ -1,1 +1,1 @@",
    addedText: "+new",
    removedText: "-old",
    addedLines: 1,
    removedLines: 1,
    ...overrides,
  };
}

describe("extractFacts over the story fixtures", () => {
  it("numbers payment-retry facts F1..F5 in emission order", () => {
    const { facts } = factsFor("payment-retry");
    expect(facts.facts.map((fact) => `${fact.id}:${fact.kind}`)).toEqual([
      "F1:prompt",
      "F2:hunk",
      "F3:attempt",
      "F4:run",
      "F5:action",
    ]);
  });

  it("flags the payment hunk and boosts it for the missing passing run", () => {
    const { session, facts } = factsFor("payment-retry");
    const hunks = ofKind<HunkFact>(facts, "hunk");
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0];
    if (!hunk) throw new Error("hunk fact missing");
    expect(hunk.hunkId).toBe(session.hunks[0]?.id);
    expect(hunk).toMatchObject({
      path: "src/payments/retry.ts",
      addedLines: 11,
      removedLines: 1,
      passingRunObserved: false,
    });
    expect(hunk.mechanical).toEqual({ class: null, reason: null });
    expect(hunk.risk.flags.map((flag) => flag.flag)).toContain("payments");
    expect(hunk.risk.flags[0]?.reason).toContain("payment boundary");
    expect(hunk.risk.unverifiedBoost).toBe(true);
    expect(hunk.risk.boostReasons.join(" ")).toContain("no passing run");
    expect(hunk.risk.centrality).toBeNull();
  });

  it("derives the failed payment run and its action from the tape", () => {
    const { facts } = factsFor("payment-retry");
    const runs = ofKind<RunFact>(facts, "run");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      command: "npm test -- payments",
      exitCode: 1,
      outcome: "failed",
      toolCallId: "call_test_pay",
    });
    expect(runs[0]?.outputText).toContain("FAILED after 2 attempts");
    const actions = ofKind<ActionFact>(facts, "action");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      toolCallId: "call_test_pay",
      name: "exec",
      outcome: "failed",
      runFactId: runs[0]?.id,
    });
  });

  it("classifies the routine hunk mechanical from tool evidence", () => {
    const { facts } = factsFor("routine");
    const hunks = ofKind<HunkFact>(facts, "hunk");
    expect(hunks).toHaveLength(1);
    // format + organize-imports + rename touched the file; rename is the
    // most specific class.
    expect(hunks[0]?.mechanical.class).toBe("rename_only");
    expect(hunks[0]?.mechanical.reason).toContain("call_ren");
    expect(hunks[0]?.risk.flags).toEqual([]);
    expect(hunks[0]?.passingRunObserved).toBe(true);
    expect(hunks[0]?.risk.unverifiedBoost).toBe(false);
    const runs = ofKind<RunFact>(facts, "run");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ command: "pnpm lint", outcome: "ok", exitCode: 0 });
  });

  it("emits only prompts for the research session", () => {
    const { facts } = factsFor("research");
    const prompts = ofKind<PromptFact>(facts, "prompt");
    expect(prompts).toHaveLength(2);
    expect(facts.facts.map((fact) => fact.id)).toEqual(["F1", "F2"]);
    expect(ofKind(facts, "hunk")).toHaveLength(0);
    expect(ofKind(facts, "run")).toHaveLength(0);
  });

  it("links the failed deploy run to its production hunk", () => {
    const { facts } = factsFor("failed-deploy");
    const attempts = ofKind<AttemptFact>(facts, "attempt");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: "failed_with_side_effect",
      toolCallId: "call_deploy",
    });
    const runs = ofKind<RunFact>(facts, "run");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      command: "./scripts/deploy-preview.sh",
      outcome: "failed",
      exitCode: 1,
    });
    const hunks = ofKind<HunkFact>(facts, "hunk");
    expect(hunks).toHaveLength(1);
    // dist/preview.txt matches no production path, but the linked tool call
    // ran a deploy command.
    expect(hunks[0]?.risk.flags.map((flag) => flag.flag)).toContain("production");
    expect(hunks[0]?.risk.unverifiedBoost).toBe(true);
  });

  it("records the partial-capture gap and boosts the hunk", () => {
    const { facts } = factsFor("partial-gap");
    const gaps = ofKind<GapFact>(facts, "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ code: "sequence_jump", fromSequence: 4, toSequence: 9 });
    expect(gaps[0]?.detail).toContain("5-8");
    const hunks = ofKind<HunkFact>(facts, "hunk");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.risk.flags.map((flag) => flag.flag)).toContain("stored_data");
    expect(hunks[0]?.risk.boostReasons.join(" ")).toContain("5-8");
    expect(ofKind(facts, "run")).toHaveLength(0);
  });

  it("counts the multi-topic rewrite and keeps the typo fix non-mechanical", () => {
    const { facts } = factsFor("multi-topic");
    expect(ofKind<PromptFact>(facts, "prompt")).toHaveLength(3);
    const hunks = ofKind<HunkFact>(facts, "hunk");
    expect(hunks.map((hunk) => hunk.path)).toEqual(["README.md", "src/home.ts"]);
    const home = hunks.find((hunk) => hunk.path === "src/home.ts");
    expect(home?.risk.rewriteCount).toBe(1);
    expect(home?.risk.flags).toEqual([]);
    expect(home?.passingRunObserved).toBe(true);
    const readme = hunks.find((hunk) => hunk.path === "README.md");
    expect(readme?.mechanical).toEqual({ class: null, reason: null });
    const attempts = ofKind<AttemptFact>(facts, "attempt");
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([
      "landed",
      "landed",
      "replaced",
    ]);
  });

  it("derives the multi-topic lint failure as a run with a synthesized command", () => {
    const { facts } = factsFor("multi-topic");
    const runs = ofKind<RunFact>(facts, "run");
    expect(runs).toHaveLength(2);
    const lint = runs.find((run) => run.toolCallId === "call_lint_triv");
    expect(lint).toMatchObject({
      command: "lint src/unrelated.ts",
      outcome: "failed",
      exitCode: 2,
    });
    expect(lint?.outputText).toBe("no lint config");
  });

  it("is deterministic under re-extraction and input shuffling", () => {
    const { session } = factsFor("multi-topic");
    const input = {
      sessionId: session.sessionId,
      tape: session.tape,
      hunks: session.hunks,
      attempts: session.attempts,
    };
    const first = extractFacts(input);
    const second = extractFacts(input);
    expect(second).toEqual(first);
    const shuffled = extractFacts({
      sessionId: session.sessionId,
      tape: [...session.tape].reverse(),
      hunks: [...session.hunks].reverse(),
      attempts: [...session.attempts].reverse(),
    });
    expect(shuffled).toEqual(first);
  });
});

describe("mechanical classification", () => {
  function classify(hunk: ReviewHunk, tape: TapeEvent[] = []): HunkFact {
    const facts = extractFacts({ sessionId: "ses_test", tape, hunks: [hunk], attempts: [] });
    const found = ofKind<HunkFact>(facts, "hunk")[0];
    if (!found) throw new Error("hunk fact missing");
    return found;
  }

  it("detects whitespace-only changes", () => {
    const hunk = classify(makeHunk({ addedText: "  return x;", removedText: "return x;" }));
    expect(hunk.mechanical.class).toBe("format_only");
  });

  it("does not call a pure deletion formatting", () => {
    const hunk = classify(makeHunk({ addedText: "", removedText: "return x;", addedLines: 0 }));
    expect(hunk.mechanical).toEqual({ class: null, reason: null });
  });

  it("detects comment-only changes in code files", () => {
    const hunk = classify(
      makeHunk({ addedText: "// note\n/* block\n * item\n */", removedText: "// old" }),
    );
    expect(hunk.mechanical.class).toBe("comment_only");
  });

  it("skips comment detection outside code files", () => {
    const hunk = classify(
      makeHunk({ path: "README.md", addedText: "// note", removedText: "// old" }),
    );
    expect(hunk.mechanical).toEqual({ class: null, reason: null });
  });

  it("detects lockfiles and generated markers", () => {
    expect(classify(makeHunk({ path: "pnpm-lock.yaml" })).mechanical.class).toBe("generated");
    expect(classify(makeHunk({ addedText: "// @generated by protoc" })).mechanical.class).toBe(
      "generated",
    );
  });

  it("detects renames from tool evidence, mixed tools stay non-mechanical", () => {
    const renameTape = [
      tapeEvent(1, "tool.requested", {
        toolCallId: "call_ren",
        payload: { name: "rename", input: { path: "src/app.ts", from: "a", to: "b" } },
      }),
      tapeEvent(2, "tool.completed", {
        toolCallId: "call_ren",
        payload: { name: "rename", outcome: "ok", input: { path: "src/app.ts" } },
      }),
    ];
    expect(classify(makeHunk(), renameTape).mechanical.class).toBe("rename_only");
    const mixedTape = [
      ...renameTape,
      tapeEvent(3, "tool.requested", {
        toolCallId: "call_edit",
        payload: { name: "edit", input: { path: "src/app.ts" } },
      }),
    ];
    expect(classify(makeHunk(), mixedTape).mechanical).toEqual({ class: null, reason: null });
  });
});

describe("risk flags and boost", () => {
  function riskFor(
    hunk: ReviewHunk,
    tape: TapeEvent[] = [],
    attempts: FileAttempt[] = [],
  ): HunkFact {
    const facts = extractFacts({ sessionId: "ses_test", tape, hunks: [hunk], attempts });
    const found = ofKind<HunkFact>(facts, "hunk")[0];
    if (!found) throw new Error("hunk fact missing");
    return found;
  }

  it("flags auth, secrets and destructive evidence", () => {
    expect(
      riskFor(makeHunk({ path: "src/auth/session.ts" })).risk.flags.map((f) => f.flag),
    ).toContain("auth");
    expect(riskFor(makeHunk({ path: ".env" })).risk.flags.map((f) => f.flag)).toContain("secrets");
    const destructive = riskFor(makeHunk({ addedText: "rm -rf /tmp/build" }));
    expect(destructive.risk.flags.map((f) => f.flag)).toContain("destructive");
  });

  it("boosts large mechanical diffs with no observed run", () => {
    const big = `${"x\n".repeat(60)}`;
    const hunk = riskFor(
      makeHunk({ addedText: big, removedText: big, addedLines: 60, removedLines: 60 }),
    );
    expect(hunk.mechanical.class).toBe("format_only");
    expect(hunk.risk.boostReasons.join(" ")).toContain("large mechanical diff (120 lines)");
  });

  it("records an interrupted run without fabricating an outcome", () => {
    const facts = extractFacts({
      sessionId: "ses_test",
      tape: [
        tapeEvent(1, "tool.requested", {
          toolCallId: "call_exec",
          payload: { name: "exec", input: { command: "sleep 60" } },
        }),
      ],
      hunks: [],
      attempts: [],
    });
    const runs = ofKind<RunFact>(facts, "run");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "interrupted", exitCode: null, outputText: null });
  });

  it("keeps a lone completion as a run instead of dropping the evidence", () => {
    const facts = extractFacts({
      sessionId: "ses_test",
      tape: [
        tapeEvent(2, "tool.completed", {
          toolCallId: "call_exec",
          payload: { name: "exec", outcome: "ok", exitCode: 0 },
        }),
      ],
      hunks: [],
      attempts: [],
    });
    const runs = ofKind<RunFact>(facts, "run");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "ok", command: "exec" });
  });

  it("skips prompts without text and gaps without a range", () => {
    const facts = extractFacts({
      sessionId: "ses_test",
      tape: [
        tapeEvent(1, "prompt.submitted", { payload: {} }),
        tapeEvent(2, "capture.gap", { payload: { code: "schema_drift" } }),
      ],
      hunks: [],
      attempts: [],
    });
    expect(ofKind(facts, "prompt")).toHaveLength(0);
    const gaps = ofKind<GapFact>(facts, "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ code: "schema_drift", detail: "schema_drift" });
  });
});
