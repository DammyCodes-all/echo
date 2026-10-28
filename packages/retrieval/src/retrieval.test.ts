import { TapeEnvelopeSchema, type TapeEvent } from "@echo/contracts";
import { buildFixtureTape } from "@echo/fixtures";
import { describe, expect, it } from "vitest";
import {
  buildEvidenceBundle,
  parseAnswer,
  refusalAnswer,
  shouldRefuseBeforeModel,
  validateCitations,
} from "./index";

const tape = buildFixtureTape();

function makeEvent(seq: number, kind: string, text: string): TapeEvent {
  return TapeEnvelopeSchema.parse({
    v: 1,
    tape_seq: seq,
    event_id: `fixture-fts-${seq}`,
    record_key: null,
    session_id: "sess_fts",
    project_id: "proj_fts",
    kind,
    ts: "2026-10-28T12:00:00.000Z",
    observed_at: "2026-10-28T12:00:00.000Z",
    source: {
      agent: "muse",
      adapter: "fixture",
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
      tool_call_id: null,
      batch_id: null,
      parent_session_id: null,
      subagent_id: null,
      snapshot: null,
    },
    payload: { text },
    redaction: { version: "fixture", findings: 0 },
    diagnostics: [],
  });
}

describe("evidence bundle", () => {
  it("retrieves file-related evidence for a why question", () => {
    const bundle = buildEvidenceBundle(tape.events, {
      question: "What was written to src/app.ts and why did it change back?",
      filePath: "src/app.ts",
    });
    expect(bundle.items.length).toBeGreaterThan(0);
    expect(bundle.items[0]?.filePath).toBe("src/app.ts");
    expect(bundle.bundleHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same query", () => {
    const query = { question: "Why did the format step fail?" };
    const first = buildEvidenceBundle(tape.events, query);
    const second = buildEvidenceBundle(tape.events, query);
    expect(second.items.map((item) => item.evidenceId)).toEqual(
      first.items.map((item) => item.evidenceId),
    );
    expect(second.bundleHash).toBe(first.bundleHash);
  });

  it("refuses before the model when nothing is relevant", () => {
    const bundle = buildEvidenceBundle(tape.events, {
      question: "What is the capital of France?",
    });
    expect(bundle.items).toHaveLength(0);
    expect(shouldRefuseBeforeModel(bundle)).toBe("not_on_tape");
    expect(refusalAnswer("not_on_tape").refusal).toBe(true);
  });

  it("refuses a file-scoped question with no term or file overlap", () => {
    // Regression: the scope used to relabel every doc with the query file,
    // making fileMatched true tape-wide so scoped gibberish never refused —
    // even for a file nothing on the tape touches.
    const scoped = buildEvidenceBundle(tape.events, {
      question: "xyzzy plugh blorpt",
      filePath: "src/does-not-exist.ts",
    });
    expect(scoped.items).toHaveLength(0);
    expect(shouldRefuseBeforeModel(scoped)).toBe("not_on_tape");
    // But the scope still admits a genuinely related event via overlap.
    const related = buildEvidenceBundle(tape.events, {
      question: "What was written to src/app.ts and why did it change back?",
      filePath: "src/app.ts",
    });
    expect(related.items.length).toBeGreaterThan(0);
  });
});

describe("citation validation", () => {
  it("accepts a verbatim quote and rejects invented support", () => {
    const bundle = buildEvidenceBundle(tape.events, {
      question: "Why did the format step fail?",
    });
    expect(bundle.items.length).toBeGreaterThan(0);
    const target = bundle.items.find((item) => item.text.includes("prettier"));
    expect(target).toBeDefined();
    const good = parseAnswer({
      refusal: false,
      refusalReason: null,
      answer: "The formatter was missing.",
      claims: [
        {
          text: "The format step failed because prettier was missing.",
          evidenceIds: [target?.evidenceId],
          quote: "prettier: not found",
        },
      ],
      uncertainty: "low",
    });
    expect(good).not.toBeNull();
    if (good === null) return;
    expect(validateCitations(bundle, good).status).toBe("answered");

    const bad = parseAnswer({
      refusal: false,
      refusalReason: null,
      answer: "It exploded.",
      claims: [
        {
          text: "The server exploded.",
          evidenceIds: [target?.evidenceId],
          quote: "server exploded",
        },
      ],
      uncertainty: "high",
    });
    expect(bad).not.toBeNull();
    if (bad === null) return;
    const result = validateCitations(bundle, bad);
    expect(result.status).toBe("refused");
    expect(result.refusalReason).toBe("insufficient_evidence");
  });

  it("rejects unknown evidence ids and keeps quoteless claims weak", () => {
    const bundle = buildEvidenceBundle(tape.events, {
      question: "What happened with src/flag.ts?",
      filePath: "src/flag.ts",
    });
    const parsed = parseAnswer({
      refusal: false,
      refusal_reason: null,
      answer: "Two writes happened.",
      claims: [
        { text: "A snapshot was taken.", evidence_ids: [bundle.items[0]?.evidenceId], quote: null },
        { text: "Bogus.", evidence_ids: ["E999"], quote: "anything" },
      ],
      uncertainty: "medium",
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    const result = validateCitations(bundle, parsed);
    expect(result.status).toBe("partial");
    expect(result.validClaims[0]?.weak).toBe(true);
  });

  it("rejects malformed model output at the boundary", () => {
    expect(parseAnswer({ answer: "hi" })).toBeNull();
    expect(parseAnswer(null)).toBeNull();
  });
});

describe("retrieval improvements", () => {
  it("keeps exit codes and snapshot triggers in summaries", () => {
    const bundle = buildEvidenceBundle(tape.events, {
      question: "Did the exec shell command exit cleanly and was a snapshot taken?",
    });
    const texts = bundle.items.map((item) => item.text).join("\n");
    expect(texts).toContain("exit 0");
    expect(texts).toContain("snapshot tool.post");
  });

  it("ranks the earliest attempt first for try-first questions", () => {
    const bundle = buildEvidenceBundle(tape.events, {
      question: "What did it try first in src/app.ts?",
      filePath: "src/app.ts",
    });
    // fixture-3 is the first of three writes to src/app.ts; the tape later
    // overwrote it twice, so it is the reverted attempt.
    expect(bundle.items[0]?.eventId).toBe("fixture-3");
  });

  it("fills best-first within the character budget", () => {
    const question = "What did the tool calls do?";
    const full = buildEvidenceBundle(tape.events, { question });
    expect(full.items.length).toBeGreaterThan(1);
    const tiny = buildEvidenceBundle(tape.events, { question }, { maxChars: 10 });
    expect(tiny.items).toHaveLength(1);
    expect(tiny.items[0]?.evidenceId).toBe("E1");
    expect(tiny.items[0]?.eventId).toBe(full.items[0]?.eventId);
  });
});

describe("fts recall", () => {
  it("stems: running matches a service that runs", () => {
    // Word overlap sees "running" vs "runs" and refuses; porter sees one stem.
    const events = [makeEvent(1, "tool.completed", "the service runs nightly")];
    const bundle = buildEvidenceBundle(events, { question: "Why is it running?" });
    expect(bundle.items).toHaveLength(1);
    expect(bundle.items[0]?.eventId).toBe("fixture-fts-1");
  });

  it("prefix-matches: prett finds the prettier failure", () => {
    const bundle = buildEvidenceBundle(tape.events, { question: "What does prett mean?" });
    expect(bundle.items.length).toBeGreaterThan(0);
    expect(bundle.items.map((item) => item.text).join("\n")).toContain("prettier");
  });
});
