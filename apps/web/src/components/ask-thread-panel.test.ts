import { describe, expect, it } from "vitest";
import { askStarters } from "./ask-thread-panel";

describe("askStarters", () => {
  it("leads with the change title when Ask is scoped to a change", () => {
    expect(askStarters({ id: "c1", title: "the login retry" })).toEqual([
      "Why did you change the login retry?",
      "What could break?",
      "What was tried before?",
    ]);
  });

  it("leaves the session starters as they are when unscoped", () => {
    expect(askStarters(null)).toEqual([
      "Why this approach?",
      "What could break?",
      "What was tried before?",
    ]);
  });
});
