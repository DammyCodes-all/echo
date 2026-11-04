import { describe, expect, it } from "vitest";
import { endScreenSummary } from "./caught-up";

describe("endScreenSummary", () => {
  it("states total, skipped, and never-opened counts in plain words", () => {
    expect(endScreenSummary(8, 2, 1)).toBe(
      "This session had 8 changes — you skipped 2 and never opened 1.",
    );
  });

  it("uses the singular when there is one change", () => {
    expect(endScreenSummary(1, 0, 0)).toBe(
      "This session had 1 change — you skipped 0 and never opened 0.",
    );
  });
});
