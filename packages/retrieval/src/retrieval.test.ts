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
