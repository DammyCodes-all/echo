import { describe, expect, it } from "vitest";
import { projectIdForDirectory } from "./project";

describe("projectIdForDirectory", () => {
  it("pins the canonical prj_ scheme both adapters share", () => {
    expect(projectIdForDirectory("/home/dev-aluminate/dev/echo-spike-scratch")).toBe(
      "prj_5ef618c8aaeef739",
    );
  });

  it("yields distinct 16-hex ids for distinct inputs", () => {
    const first = projectIdForDirectory("/repo");
    const second = projectIdForDirectory("/repo/sub");
    expect(first).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(second).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(first).not.toBe(second);
    expect(projectIdForDirectory("/repo")).toBe(first);
  });
});
