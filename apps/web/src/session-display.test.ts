import { describe, expect, it } from "vitest";
import { compactSessionSummary, sessionDisplayTitle } from "./session-display";

const BASE = {
  summary: null as string | null,
  summarySkeleton: false,
  title: null as string | null,
  captureState: "ready",
};

describe("sessionDisplayTitle priority", () => {
  it("prefers the agent title over a locked model summary", () => {
    expect(
      sessionDisplayTitle({
        ...BASE,
        title: "Pushing changes to GitHub",
        summary: "Fold subagent lanes and stabilize project listings",
      }),
    ).toBe("Pushing changes to GitHub");
  });

  it("prefers the agent title over skeleton text", () => {
    expect(
      sessionDisplayTitle({
        ...BASE,
        title: "Meals ingestion accuracy check",
        summary: "Prompts, changes in a.ts, b.ts.",
        summarySkeleton: true,
      }),
    ).toBe("Meals ingestion accuracy check");
  });

  it("ignores a blank agent title and falls to the model summary", () => {
    expect(
      sessionDisplayTitle({
        ...BASE,
        title: "   ",
        summary: "Fold subagent lanes and stabilize project listings",
      }),
    ).toBe("Fold subagent lanes and stabilize project listings");
  });

  it("uses the locked model summary when no agent title exists", () => {
    expect(
      sessionDisplayTitle({
        ...BASE,
        summary: "Fold subagent lanes and stabilize project listings",
      }),
    ).toBe("Fold subagent lanes and stabilize project listings");
  });

  it("compacts skeleton text as last resort before placeholders", () => {
    expect(
      sessionDisplayTitle({
        ...BASE,
        summary: "Prompts, changes in a.ts, b.ts.",
        summarySkeleton: true,
      }),
    ).toBe("Prompts · changes in a.ts…");
  });

  it("caps a long agent title to one headline", () => {
    const title = sessionDisplayTitle({
      ...BASE,
      title: `Pushing changes to GitHub with an extremely long tail of extra words that keeps going past any reasonable headline length for a card`,
    });
    expect(title.length).toBeLessThanOrEqual(141);
    expect(title).toContain("Pushing changes to GitHub");
  });

  it("falls back to recording/empty placeholders with neither title nor summary", () => {
    expect(sessionDisplayTitle({ ...BASE, captureState: "recording" })).toBe(
      "Still recording — changes pending…",
    );
    expect(sessionDisplayTitle(BASE)).toBe("No summary");
  });
});

describe("compactSessionSummary", () => {
  it("leaves model prose untouched", () => {
    expect(compactSessionSummary("Fold subagent lanes")).toBe("Fold subagent lanes");
    expect(compactSessionSummary(null)).toBe(null);
  });
});
