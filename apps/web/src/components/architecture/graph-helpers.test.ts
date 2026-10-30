import type { Architecture } from "@echo/contracts";
import { describe, expect, test } from "vitest";
import {
  arrowheadPoints,
  computeHubs,
  neighborCount,
  polylineArrowhead,
  polylineMidpoint,
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

describe("arrowheadPoints", () => {
  test("points down, up, left, and right", () => {
    expect(arrowheadPoints({ x: 0, y: 10 }, { x: 0, y: 0 })).toBe("0,10 -4,1 4,1");
    expect(arrowheadPoints({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe("0,0 4,9 -4,9");
    expect(arrowheadPoints({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe("0,0 9,-4 9,4");
    expect(arrowheadPoints({ x: 10, y: 0 }, { x: 0, y: 0 })).toBe("10,0 1,4 1,-4");
  });

  test("normalizes diagonal and long approaches", () => {
    // 45° approach from the top-left: unit (0.71,0.71), base 9 back, ±4 across.
    expect(arrowheadPoints({ x: 0, y: 0 }, { x: -100, y: -100 })).toBe(
      "0,0 -9.19,-3.54 -3.54,-9.19",
    );
  });

  test("returns null when tip and approach coincide", () => {
    expect(arrowheadPoints({ x: 1, y: 2 }, { x: 1, y: 2 })).toBeNull();
  });
});

describe("polylineArrowhead", () => {
  const line = [
    { x: 0, y: 0 },
    { x: 0, y: 50 },
    { x: 0, y: 100 },
  ];

  test("caps the end pointing along travel", () => {
    expect(polylineArrowhead(line, "end")).toBe(arrowheadPoints({ x: 0, y: 100 }, { x: 0, y: 50 }));
  });

  test("caps the start pointing back along travel", () => {
    expect(polylineArrowhead(line, "start")).toBe(arrowheadPoints({ x: 0, y: 0 }, { x: 0, y: 50 }));
  });

  test("skips duplicate points and gives up on degenerate input", () => {
    expect(
      polylineArrowhead(
        [
          { x: 5, y: 5 },
          { x: 5, y: 5 },
          { x: 5, y: 20 },
        ],
        "start",
      ),
    ).toBe(arrowheadPoints({ x: 5, y: 5 }, { x: 5, y: 20 }));
    expect(polylineArrowhead([], "end")).toBeNull();
    expect(polylineArrowhead([{ x: 1, y: 1 }], "end")).toBeNull();
    expect(
      polylineArrowhead(
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
        "end",
      ),
    ).toBeNull();
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
