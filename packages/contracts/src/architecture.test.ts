import { describe, expect, test } from "vitest";
import {
  type ArchitectureEdge,
  type ArchitectureModelOutput,
  ArchitectureModelOutputSchema,
  ArchitecturePatchSchema,
  ArchitectureSchema,
  enforceAcyclicEdges,
} from "./architecture";

function validStructure(): ArchitectureModelOutput {
  return {
    groups: [
      { id: "capture", label: "Capture" },
      { id: "storage", label: "Storage" },
    ],
    nodes: [
      {
        id: "reader",
        label: "Native reader",
        group: "capture",
        description: "Tails agent session logs.",
        paths: ["packages/capture-*/**"],
        status: "existing",
      },
      {
        id: "tape",
        label: "Tape store",
        group: "storage",
        description: "Append-only event log.",
        paths: ["packages/tape/**"],
        status: "existing",
      },
    ],
    edges: [{ from: "reader", to: "tape" }],
  };
}

describe("ArchitectureModelOutputSchema", () => {
  test("accepts a valid structure", () => {
    expect(ArchitectureModelOutputSchema.safeParse(validStructure()).success).toBe(true);
  });

  test("rejects edges to missing nodes", () => {
    const bad = validStructure();
    bad.edges = [{ from: "reader", to: "ghost" }];
    const result = ArchitectureModelOutputSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("rejects duplicate node ids", () => {
    const bad = validStructure();
    bad.nodes = [
      bad.nodes[0] as (typeof bad.nodes)[number],
      bad.nodes[0] as (typeof bad.nodes)[number],
    ];
    expect(ArchitectureModelOutputSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects duplicate group ids", () => {
    const bad = validStructure();
    bad.groups = [
      bad.groups[0] as (typeof bad.groups)[number],
      bad.groups[0] as (typeof bad.groups)[number],
    ];
    expect(ArchitectureModelOutputSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects nodes in unknown groups", () => {
    const bad = validStructure();
    bad.nodes[0] = { ...(bad.nodes[0] as (typeof bad.nodes)[number]), group: "nope" };
    expect(ArchitectureModelOutputSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects labels over three words", () => {
    const bad = validStructure();
    bad.nodes[0] = {
      ...(bad.nodes[0] as (typeof bad.nodes)[number]),
      label: "Native session log reader",
    };
    const result = ArchitectureModelOutputSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("accepts a three-word label", () => {
    const ok = validStructure();
    ok.nodes[0] = { ...(ok.nodes[0] as (typeof ok.nodes)[number]), label: "Native log reader" };
    expect(ArchitectureModelOutputSchema.safeParse(ok).success).toBe(true);
  });

  test("accepts group order when present, in any numbering", () => {
    const ordered = validStructure();
    ordered.groups = [
      { id: "capture", label: "Capture", order: 0 },
      { id: "storage", label: "Storage", order: 5 },
    ];
    expect(ArchitectureModelOutputSchema.safeParse(ordered).success).toBe(true);

    const oneBased = validStructure();
    oneBased.groups = [
      { id: "capture", label: "Capture", order: 1 },
      { id: "storage", label: "Storage", order: 2 },
    ];
    expect(ArchitectureModelOutputSchema.safeParse(oneBased).success).toBe(true);
  });

  test("accepts bidirectional edges and edges without the flag", () => {
    const bidir = validStructure();
    bidir.edges = [{ from: "reader", to: "tape", bidirectional: true }];
    expect(ArchitectureModelOutputSchema.safeParse(bidir).success).toBe(true);
    expect(ArchitectureModelOutputSchema.safeParse(validStructure()).success).toBe(true);
  });

  test("accepts groups without order (pre-ordering stored versions)", () => {
    expect(ArchitectureModelOutputSchema.safeParse(validStructure()).success).toBe(true);
    expect(
      ArchitectureSchema.safeParse({
        ...validStructure(),
        version: 1,
        generatedAt: "2026-10-29T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  test("rejects non-integer group order", () => {
    const bad = validStructure();
    bad.groups = [
      { id: "capture", label: "Capture", order: 1.5 },
      { id: "storage", label: "Storage" },
    ];
    expect(ArchitectureModelOutputSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects multi-line descriptions and oversized graphs", () => {
    const bad = validStructure();
    bad.nodes[0] = {
      ...(bad.nodes[0] as (typeof bad.nodes)[number]),
      description: "line one\nline two",
    };
    expect(ArchitectureModelOutputSchema.safeParse(bad).success).toBe(false);

    const many = validStructure();
    many.nodes = Array.from({ length: 16 }, (_, i) => ({
      ...(many.nodes[0] as (typeof many.nodes)[number]),
      id: `node-${i}`,
    }));
    expect(ArchitectureModelOutputSchema.safeParse(many).success).toBe(false);
  });
});

describe("ArchitectureSchema", () => {
  test("requires server-stamped version fields", () => {
    expect(ArchitectureSchema.safeParse(validStructure()).success).toBe(false);
    expect(
      ArchitectureSchema.safeParse({
        ...validStructure(),
        version: 1,
        generatedAt: "2026-10-29T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

describe("enforceAcyclicEdges", () => {
  const edge = (from: string, to: string, extra?: Partial<ArchitectureEdge>): ArchitectureEdge => ({
    from,
    to,
    ...extra,
  });

  test("passes acyclic input through untouched", () => {
    const input = [edge("a", "b"), edge("b", "c"), edge("a", "c")];
    const result = enforceAcyclicEdges(input);
    expect(result.edges).toEqual(input);
    expect(result.merged).toBe(0);
    expect(result.dropped).toBe(0);
  });

  test("merges an opposite pair into one bidirectional edge, first wins", () => {
    const input = [edge("a", "b", { label: "writes" }), edge("b", "a", { label: "reads" })];
    const result = enforceAcyclicEdges(input);
    expect(result.edges).toEqual([{ from: "a", to: "b", label: "writes", bidirectional: true }]);
    expect(result.merged).toBe(1);
    expect(result.dropped).toBe(0);
  });

  test("drops the edge that closes a longer cycle", () => {
    const input = [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("c", "d")];
    const result = enforceAcyclicEdges(input);
    expect(result.edges).toEqual([edge("a", "b"), edge("b", "c"), edge("c", "d")]);
    expect(result.merged).toBe(0);
    expect(result.dropped).toBe(1);
  });

  test("keeps self-loops and same-direction duplicates", () => {
    const input = [edge("a", "a"), edge("a", "b"), edge("a", "b")];
    const result = enforceAcyclicEdges(input);
    expect(result.edges).toEqual(input);
    expect(result.merged).toBe(0);
    expect(result.dropped).toBe(0);
  });

  test("folds a third pair edge into the merged bidirectional edge", () => {
    const input = [edge("a", "b"), edge("b", "a"), edge("b", "a")];
    const result = enforceAcyclicEdges(input);
    expect(result.edges).toEqual([{ from: "a", to: "b", bidirectional: true }]);
    expect(result.merged).toBe(2);
    expect(result.dropped).toBe(0);
  });

  test("treats bidirectional edges as two-way for cycle detection", () => {
    const input = [
      { from: "a", to: "b", bidirectional: true },
      edge("b", "c"),
      edge("c", "a"),
    ];
    const result = enforceAcyclicEdges(input);
    expect(result.edges).toEqual([
      { from: "a", to: "b", bidirectional: true },
      edge("b", "c"),
    ]);
    expect(result.dropped).toBe(1);
  });
});

describe("ArchitecturePatchSchema", () => {
  test("accepts every op kind", () => {
    const patch = [
      {
        op: "addNode",
        node: {
          id: "cache",
          label: "Result cache",
          group: "storage",
          description: "Caches model answers.",
          paths: [],
          status: "proposed",
        },
      },
      { op: "updateNode", id: "cache", patch: { label: "Answer cache" } },
      { op: "removeNode", id: "cache" },
      { op: "addEdge", edge: { from: "reader", to: "tape", label: "appends" } },
      { op: "removeEdge", from: "reader", to: "tape" },
      { op: "addGroup", group: { id: "serving", label: "Serving" } },
    ];
    expect(ArchitecturePatchSchema.safeParse(patch).success).toBe(true);
  });

  test("rejects unknown ops and empty patches", () => {
    expect(ArchitecturePatchSchema.safeParse([{ op: "renameAll" }]).success).toBe(false);
    expect(ArchitecturePatchSchema.safeParse([]).success).toBe(false);
  });
});
