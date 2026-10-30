import { describe, expect, test } from "vitest";
import {
  type ArchitectureModelOutput,
  ArchitectureModelOutputSchema,
  ArchitecturePatchSchema,
  ArchitectureSchema,
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
