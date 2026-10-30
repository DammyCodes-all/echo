import type { Architecture } from "@echo/contracts";
import { describe, expect, test } from "vitest";
import {
  computeHubs,
  isEdgeVisible,
  neighborCount,
  polylineMidpoint,
  revealedHubs,
  routedPath,
} from "./graph-helpers";

function architecture(nodeIds: string[], edges: Array<[string, string]>): Architecture {
  return {
    version: 1,
    generatedAt: "2026-10-30T00:00:00.000Z",
    groups: [{ id: "g", label: "G", order: 0 }],
    nodes: nodeIds.map((id) => ({
      id,
      label: `Node ${id}`,
      group: "g",
      description: "Does things.",
      paths: [],
      status: "existing" as const,
    })),
    edges: edges.map(([from, to]) => ({ from, to })),
  };
}

describe("computeHubs", () => {
  test("flags nodes past the threshold, in either direction", () => {
    const arch = architecture(
      ["hub", "a", "b", "c", "d", "e", "plain"],
      [
        ["hub", "a"],
        ["b", "hub"],
        ["hub", "c"],
        ["d", "hub"],
        ["hub", "e"],
        ["a", "plain"],
      ],
    );
    expect(computeHubs(arch)).toEqual(new Set(["hub"]));
  });

  test("leaves a 4-edge node alone (boundary)", () => {
    const arch = architecture(
      ["n", "a", "b", "c", "d"],
      [
        ["n", "a"],
        ["n", "b"],
        ["n", "c"],
        ["n", "d"],
      ],
    );
    expect(computeHubs(arch)).toEqual(new Set());
  });

  test("counts a self-loop once toward the degree", () => {
    const arch = architecture(
      ["n", "a", "b", "c", "d"],
      [
        ["n", "n"],
        ["n", "a"],
        ["n", "b"],
        ["n", "c"],
        ["n", "d"],
      ],
    );
    expect(computeHubs(arch)).toEqual(new Set(["n"]));
  });
});

describe("neighborCount", () => {
  test("counts distinct others, excluding self", () => {
    const arch = architecture(
      ["hub", "a", "b"],
      [
        ["hub", "a"],
        ["hub", "a"],
        ["b", "hub"],
        ["hub", "hub"],
      ],
    );
    expect(neighborCount(arch, "hub")).toBe(2);
    expect(neighborCount(arch, "ghost")).toBe(0);
  });
});

describe("revealedHubs", () => {
  const arch = architecture(
    ["hub", "leaf", "far", "hub2"],
    [
      ["hub", "leaf"],
      ["hub", "far"],
      ["hub", "hub2"],
      ["hub", "leaf"],
      ["hub", "far"],
    ],
  );
  const hubs = new Set(["hub", "hub2"]);

  test("reveals nothing without hover", () => {
    expect(revealedHubs(arch, hubs, null)).toEqual(new Set());
  });

  test("reveals the hovered hub itself", () => {
    expect(revealedHubs(arch, hubs, "hub")).toEqual(new Set(["hub", "hub2"]));
  });

  test("reveals hubs connected to the hovered node", () => {
    expect(revealedHubs(arch, hubs, "leaf")).toEqual(new Set(["hub"]));
    expect(revealedHubs(arch, hubs, "far")).toEqual(new Set(["hub"]));
  });

  test("reveals nothing for an unconnected node", () => {
    expect(revealedHubs(arch, hubs, "lonely")).toEqual(new Set());
  });
});

describe("isEdgeVisible", () => {
  const hubs = new Set(["hub"]);
  const revealed = new Set(["hub"]);

  test("plain edges always show", () => {
    expect(isEdgeVisible({ from: "a", to: "b" }, hubs, new Set())).toBe(true);
  });

  test("hub edges hide until revealed", () => {
    expect(isEdgeVisible({ from: "hub", to: "a" }, hubs, new Set())).toBe(false);
    expect(isEdgeVisible({ from: "a", to: "hub" }, hubs, new Set())).toBe(false);
    expect(isEdgeVisible({ from: "hub", to: "a" }, hubs, revealed)).toBe(true);
  });

  test("hub-hub edges show when either side is revealed", () => {
    const two = new Set(["h1", "h2"]);
    expect(isEdgeVisible({ from: "h1", to: "h2" }, two, new Set())).toBe(false);
    expect(isEdgeVisible({ from: "h1", to: "h2" }, two, new Set(["h2"]))).toBe(true);
  });
});

describe("routedPath", () => {
  test("returns null for degenerate input", () => {
    expect(routedPath([])).toBeNull();
    expect(routedPath([{ x: 1, y: 2 }])).toBeNull();
    expect(
      routedPath([
        { x: 1, y: 2 },
        { x: 1, y: 2 },
      ]),
    ).toBeNull();
  });

  test("draws a straight segment", () => {
    expect(
      routedPath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe("M 0 0 L 10 0");
  });

  test("rounds one corner and skips straight joints", () => {
    const path = routedPath(
      [
        { x: 0, y: 0 },
        { x: 0, y: 100 },
        { x: 0, y: 200 },
        { x: 100, y: 200 },
      ],
      8,
    ) as string;
    expect(path.startsWith("M 0 0")).toBe(true);
    expect(path.endsWith("L 100 200")).toBe(true);
    expect(path.match(/Q/g)).toHaveLength(1);
    expect(path).toContain("Q 0 200 8 200");
  });

  test("clamps the radius to half the shortest side", () => {
    const path = routedPath(
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 100, y: 10 },
      ],
      8,
    ) as string;
    // Corner radius 5 (half of the 10px side): arc from (0,5) to (5,10).
    expect(path).toContain("L 0 5 Q 0 10 5 10");
  });

  test("rounds coordinates to two decimals", () => {
    const path = routedPath([
      { x: 165.3333333, y: 226 },
      { x: 165.3333333, y: 300 },
    ]) as string;
    expect(path).toBe("M 165.33 226 L 165.33 300");
  });
});

describe("polylineMidpoint", () => {
  test("returns null and singletons sanely", () => {
    expect(polylineMidpoint([])).toBeNull();
    expect(polylineMidpoint([{ x: 3, y: 4 }])).toEqual({ x: 3, y: 4 });
  });

  test("walks half the total length", () => {
    expect(
      polylineMidpoint([
        { x: 0, y: 0 },
        { x: 0, y: 100 },
        { x: 100, y: 100 },
      ]),
    ).toEqual({ x: 0, y: 100 });
  });
});
