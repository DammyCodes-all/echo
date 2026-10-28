import { buildAllStorySessions } from "@echo/fixtures";
import { describe, expect, it } from "vitest";
import { extractFacts, type FactSet } from "./facts";
import {
  buildNarrationMessages,
  MAX_PROMPT_CHARS,
  renderFact,
  STORY_PROMPT_VERSION,
} from "./narration";

function factsFor(slug: string): FactSet {
  const session = buildAllStorySessions().find((entry) => entry.slug === slug);
  if (!session) throw new Error(`fixture session missing: ${slug}`);
  return extractFacts({
    sessionId: session.sessionId,
    tape: session.tape,
    hunks: session.hunks,
    attempts: session.attempts,
  });
}

describe("buildNarrationMessages", () => {
  it("stamps the prompt version and renders every fact id", () => {
    const facts = factsFor("payment-retry");
    const messages = buildNarrationMessages(facts, "sess_fixture_payment");
    expect(messages.user).toContain(`prompt_version: ${STORY_PROMPT_VERSION}`);
    expect(messages.user).toContain("sess_fixture_payment");
    for (const fact of facts.facts) {
      expect(messages.user).toContain(`[${fact.id}]`);
    }
    expect(messages.truncated).toBe(false);
  });

  it("instructs fact-id-only claims with server recomputation", () => {
    const facts = factsFor("research");
    const messages = buildNarrationMessages(facts, "ses_test");
    expect(messages.system).toContain("JSON only");
    expect(messages.system).toContain("fact IDs");
    expect(messages.system).toContain("server recomputes");
    expect(messages.system).toContain("h_");
  });

  it("renders hunks with risk signals and code sides", () => {
    const facts = factsFor("payment-retry");
    const hunk = facts.facts.find((fact) => fact.kind === "hunk");
    if (!hunk) throw new Error("hunk fact missing");
    const rendered = renderFact(hunk);
    expect(rendered).toContain("src/payments/retry.ts");
    expect(rendered).toContain("payments");
    expect(rendered).toContain("attempt <= 5");
    expect(rendered).toContain("--- added");
    expect(rendered).toContain("--- removed");
  });

  it("marks field truncation instead of silently cutting", () => {
    const facts = factsFor("payment-retry");
    const run = facts.facts.find((fact) => fact.kind === "run");
    if (run?.kind !== "run") throw new Error("run fact missing");
    const big = { ...run, outputText: `${"x\n".repeat(3000)}tail` };
    const rendered = renderFact(big);
    expect(rendered).toContain("…(+");
    expect(rendered).toContain("chars)");
    expect(rendered).not.toContain("tail");
  });

  it("drops whole facts past the cap with a marker", () => {
    const facts = factsFor("multi-topic");
    const hunk = facts.facts.find((fact) => fact.kind === "hunk");
    if (hunk?.kind !== "hunk") throw new Error("hunk fact missing");
    const copies = Array.from({ length: 40 }, (_, index) => ({
      ...hunk,
      id: `F100${index}`,
      addedText: "y\n".repeat(2000),
    }));
    const bigFacts: FactSet = { ...facts, facts: [...facts.facts, ...copies] };
    const messages = buildNarrationMessages(bigFacts, "ses_test");
    expect(messages.truncated).toBe(true);
    expect(messages.user.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS + 200);
    expect(messages.user).toContain("omitted over the prompt cap");
    // Fact order is preserved: the head always survives.
    expect(messages.user).toContain("[F1]");
  });
});

describe("extractFacts tapeEventCount override", () => {
  it("prefers the raw count over the deduped input length", () => {
    const session = buildAllStorySessions().find((entry) => entry.slug === "payment-retry");
    if (!session) throw new Error("fixture session missing");
    const facts = extractFacts({
      sessionId: session.sessionId,
      tape: session.tape,
      hunks: session.hunks,
      attempts: session.attempts,
      tapeEventCount: 99,
    });
    expect(facts.tapeEventCount).toBe(99);
  });
});
