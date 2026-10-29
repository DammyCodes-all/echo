import { describe, expect, it } from "vitest";
import { capStorySummary, STORY_SUMMARY_MAX_CHARS, STORY_SUMMARY_MAX_SENTENCES } from "./summary";

describe("capStorySummary", () => {
  it("leaves short headlines untouched", () => {
    expect(capStorySummary("add a greeting line")).toBe("add a greeting line");
    expect(capStorySummary("Separated tabs into areas.")).toBe("Separated tabs into areas.");
  });

  it("keeps one sentence", () => {
    expect(STORY_SUMMARY_MAX_SENTENCES).toBe(1);
    expect(capStorySummary("Shipped auth. Fixed login. Cleaned docs.")).toBe("Shipped auth.");
  });

  it("never splits filenames, versions or initials", () => {
    expect(capStorySummary("Prompts, changes in notes.txt.")).toBe(
      "Prompts, changes in notes.txt.",
    );
    expect(capStorySummary("Shipped v1.3 with fixes. Cleaned up.")).toBe(
      "Shipped v1.3 with fixes.",
    );
    expect(capStorySummary("Fixed U.S. policy handling. Next steps.")).toBe(
      "Fixed U.S. policy handling.",
    );
  });

  it("cuts long single sentences at a word boundary with an ellipsis", () => {
    const long =
      "Separated project workspace into overview learn and architecture areas with code index and generated project summary and tech stack alongside ingest hardening";
    expect(long.length).toBeGreaterThan(STORY_SUMMARY_MAX_CHARS);
    expect(capStorySummary(long)).toBe(
      "Separated project workspace into overview learn and architecture areas with code index and generated project summary and tech stack…",
    );
    expect(capStorySummary(long).length).toBeLessThanOrEqual(STORY_SUMMARY_MAX_CHARS);
  });

  it("collapses whitespace and never empties non-blank input", () => {
    expect(capStorySummary("  Did  work\nacross\tlines.  ")).toBe("Did work across lines.");
    expect(capStorySummary("   ")).toBe("   ");
  });

  it("hard-cuts unbreakable tokens within the bound", () => {
    expect(capStorySummary("x".repeat(200))).toBe(`${"x".repeat(STORY_SUMMARY_MAX_CHARS - 1)}…`);
  });

  it("is idempotent", () => {
    const inputs = [
      "add a greeting line",
      "Shipped auth. Fixed login. Cleaned docs.",
      "Separated project workspace into overview learn and architecture areas with code index and generated project summary and tech stack alongside ingest hardening",
      "First long headline sentence with plenty of words in it. Second sentence here. Third gone.",
      "x".repeat(200),
    ];
    for (const input of inputs) {
      const once = capStorySummary(input);
      expect(capStorySummary(once)).toBe(once);
    }
  });
});
