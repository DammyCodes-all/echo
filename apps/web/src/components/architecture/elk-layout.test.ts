import type { Architecture } from "@echo/contracts";
import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import { describe, expect, test } from "vitest";
import {
  ARCH_NODE_HEIGHT,
  ARCH_NODE_WIDTH,
  type ArchitectureLayout,
  collectRoutedEdges,
  layoutArchitecture,
  rankGroups,
} from "./elk-layout";

type ArchNode = Architecture["nodes"][number];

function node(id: string, label: string, group: string): ArchNode {
  return {
    id,
    label,
    group,
    description: "Does things.",
    paths: ["src/**"],
    status: "existing",
  };
}

/** Array order scrambles flow order on purpose: ranking must recover it. */
function fixture(): Architecture {
  return {
    version: 1,
    generatedAt: "2026-10-30T00:00:00.000Z",
    groups: [
      { id: "storage", label: "Storage", order: 2 },
      { id: "capture", label: "Capture", order: 0 },
      { id: "processing", label: "Processing", order: 1 },
    ],
    nodes: [
      node("cap1", "Cap one", "capture"),
      node("cap2", "Cap two", "capture"),
      node("proc1", "Proc one", "processing"),
      node("proc2", "Proc two", "processing"),
      node("store1", "Store one", "storage"),
    ],
    edges: [
      { from: "cap1", to: "proc1" },
      { from: "cap2", to: "proc1" },
      { from: "proc1", to: "proc2" },
      { from: "proc2", to: "store1" },
      { from: "cap1", to: "store1" },
    ],
  };
}

function absRect(layout: ArchitectureLayout, nodeId: string) {
  const placed = layout.nodes.find((candidate) => candidate.id === nodeId);
  const group = layout.groups.find((candidate) => candidate.id === placed?.group);
  if (!placed || !group) throw new Error(`missing node in layout: ${nodeId}`);
  return {
    x: group.x + placed.x,
    y: group.y + placed.y,
    width: ARCH_NODE_WIDTH,
    height: ARCH_NODE_HEIGHT,
  };
}

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("rankGroups", () => {
  test("orders by explicit order, dense ranks", () => {
    const ranks = rankGroups(fixture().groups);
    expect(ranks.get("capture")).toBe(0);
    expect(ranks.get("processing")).toBe(1);
    expect(ranks.get("storage")).toBe(2);
  });

  test("falls back to array position when order is missing", () => {
    const ranks = rankGroups([
      { id: "b", label: "B" },
      { id: "a", label: "A" },
    ]);
    expect(ranks.get("b")).toBe(0);
    expect(ranks.get("a")).toBe(1);
  });

  test("breaks duplicate orders by array position", () => {
    const ranks = rankGroups([
      { id: "a", label: "A", order: 1 },
      { id: "b", label: "B", order: 1 },
      { id: "c", label: "C", order: 0 },
    ]);
    expect(ranks.get("c")).toBe(0);
    expect(ranks.get("a")).toBe(1);
    expect(ranks.get("b")).toBe(2);
  });

  test("accepts 1-based numbering", () => {
    const ranks = rankGroups([
      { id: "a", label: "A", order: 1 },
      { id: "b", label: "B", order: 2 },
      { id: "c", label: "C", order: 3 },
    ]);
    expect(ranks.get("a")).toBe(0);
    expect(ranks.get("b")).toBe(1);
    expect(ranks.get("c")).toBe(2);
  });
});

describe("layoutArchitecture", () => {
  const laid = layoutArchitecture(fixture());

  test("places children inside their group below the label band", async () => {
    const layout = await laid;
    // Keyed padding is [top=36,left=20,bottom=20,right=20]; tolerances catch
    // the 12px silent default while allowing float dust.
    for (const placed of layout.nodes) {
      const group = layout.groups.find((candidate) => candidate.id === placed.group);
      expect(group).toBeDefined();
      expect(placed.x).toBeGreaterThanOrEqual(19);
      expect(placed.y).toBeGreaterThanOrEqual(35);
      expect(placed.x + ARCH_NODE_WIDTH).toBeLessThanOrEqual((group?.width ?? 0) - 19);
      expect(placed.y + ARCH_NODE_HEIGHT).toBeLessThanOrEqual((group?.height ?? 0) - 19);
    }
  });

  test("never overlaps groups", async () => {
    const layout = await laid;
    for (let i = 0; i < layout.groups.length; i++) {
      for (let j = i + 1; j < layout.groups.length; j++) {
        const a = layout.groups[i] as (typeof layout.groups)[number];
        const b = layout.groups[j] as (typeof layout.groups)[number];
        expect(rectsOverlap(a, b)).toBe(false);
      }
    }
  });

  test("stacks groups top to bottom in rank order", async () => {
    const layout = await laid;
    const centerY = (id: string): number => {
      const group = layout.groups.find((candidate) => candidate.id === id);
      if (!group) throw new Error(`missing group: ${id}`);
      return group.y + group.height / 2;
    };
    expect(centerY("capture")).toBeLessThan(centerY("processing"));
    expect(centerY("processing")).toBeLessThan(centerY("storage"));
  });

  test("routes every edge from source bottom to target top", async () => {
    const layout = await laid;
    expect(layout.edges).toHaveLength(fixture().edges.length);
    for (const edge of layout.edges) {
      expect(edge.points.length).toBeGreaterThanOrEqual(2);
      const source = absRect(layout, edge.from);
      const target = absRect(layout, edge.to);
      const start = edge.points[0] as (typeof edge.points)[number];
      const end = edge.points[edge.points.length - 1] as (typeof edge.points)[number];
      expect(Math.abs(start.y - (source.y + source.height))).toBeLessThanOrEqual(3);
      expect(start.x).toBeGreaterThanOrEqual(source.x - 1);
      expect(start.x).toBeLessThanOrEqual(source.x + source.width + 1);
      expect(Math.abs(end.y - target.y)).toBeLessThanOrEqual(3);
      expect(end.x).toBeGreaterThanOrEqual(target.x - 1);
      expect(end.x).toBeLessThanOrEqual(target.x + target.width + 1);
    }
  });

  test("draws axis-aligned polylines that never cross a node", async () => {
    const layout = await laid;
    const rects = layout.nodes.map((placed) => absRect(layout, placed.id));
    const insideAny = (x: number, y: number): boolean =>
      rects.some(
        (rect) =>
          x > rect.x + 0.5 &&
          x < rect.x + rect.width - 0.5 &&
          y > rect.y + 0.5 &&
          y < rect.y + rect.height - 0.5,
      );
    for (const edge of layout.edges) {
      for (let i = 1; i < edge.points.length; i++) {
        const prev = edge.points[i - 1] as (typeof edge.points)[number];
        const curr = edge.points[i] as (typeof edge.points)[number];
        expect(Math.min(Math.abs(curr.x - prev.x), Math.abs(curr.y - prev.y))).toBeLessThan(1e-6);
        // Sample the segment every 2px; endpoints sit on borders (excluded
        // by the strict interior test), everything else must stay outside.
        const length = Math.hypot(curr.x - prev.x, curr.y - prev.y);
        const steps = Math.max(1, Math.ceil(length / 2));
        for (let s = 0; s <= steps; s++) {
          const x = prev.x + ((curr.x - prev.x) * s) / steps;
          const y = prev.y + ((curr.y - prev.y) * s) / steps;
          expect(insideAny(x, y)).toBe(false);
        }
      }
    }
  });

  test("is deterministic", async () => {
    const layout = await laid;
    const again = await layoutArchitecture(fixture());
    expect(again).toEqual(layout);
  });

  test("returns one route per input edge, in input order", async () => {
    const layout = await laid;
    const input = fixture().edges;
    expect(layout.edges.map((edge) => `${edge.from}→${edge.to}`)).toEqual(
      input.map((edge) => `${edge.from}→${edge.to}`),
    );
  });
});

describe("collectRoutedEdges", () => {
  function laidTree(): ElkNode {
    return {
      id: "root",
      children: [
        {
          id: "g",
          x: 100,
          y: 50,
          children: [{ id: "g/a" }, { id: "g/b" }],
          edges: [
            {
              id: "e0",
              sources: ["g/a"],
              targets: ["g/b"],
              sections: [
                {
                  id: "e0s0",
                  startPoint: { x: 10, y: 10 },
                  bendPoints: [],
                  endPoint: { x: 20, y: 30 },
                },
              ],
            },
          ],
        },
        { id: "h", x: 400, y: 50, children: [{ id: "h/c" }] },
      ],
      edges: [
        {
          id: "e1",
          sources: ["g/a"],
          targets: ["h/c"],
          sections: [
            {
              id: "e1s0",
              startPoint: { x: 200, y: 200 },
              bendPoints: [],
              endPoint: { x: 300, y: 300 },
            },
          ],
        },
        { id: "e2", sources: ["g/b"], targets: ["h/c"] },
      ],
    };
  }

  test("finds nested edges and frames same-group routes by the group", () => {
    const { edges, unrouted } = collectRoutedEdges(laidTree(), [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ]);
    expect(edges).toHaveLength(3);
    // e0 nests under g and both endpoints live in g: group offset applies.
    expect(edges[0]).toEqual({
      id: "e0",
      from: "a",
      to: "b",
      points: [
        { x: 110, y: 60 },
        { x: 120, y: 80 },
      ],
    });
    // e1 sits at the root across groups: root frame, no offset.
    expect(edges[1]?.points).toEqual([
      { x: 200, y: 200 },
      { x: 300, y: 300 },
    ]);
    // e2 has no sections: identity kept, empty points, reported unrouted.
    expect(edges[2]).toEqual({ id: "e2", from: "b", to: "c", points: [] });
    expect(unrouted).toEqual([2]);
  });

  test("reports input edges ELK never returned", () => {
    const { edges, unrouted } = collectRoutedEdges({ id: "root" }, [{ from: "a", to: "b" }]);
    expect(edges).toEqual([{ id: "e0", from: "a", to: "b", points: [] }]);
    expect(unrouted).toEqual([0]);
  });

  test("ignores non-edge ids and out-of-range routes", () => {
    const laid: ElkNode = {
      id: "root",
      children: [{ id: "g", children: [{ id: "g/a" }, { id: "g/b" }] }],
      edges: [
        { id: "ports", sources: [], targets: [] },
        {
          id: "e7",
          sources: ["g/a"],
          targets: ["g/b"],
          sections: [
            { id: "e7s0", startPoint: { x: 1, y: 1 }, bendPoints: [], endPoint: { x: 2, y: 2 } },
          ],
        },
      ],
    };
    const { edges, unrouted } = collectRoutedEdges(laid, [{ from: "a", to: "b" }]);
    expect(edges).toEqual([{ id: "e0", from: "a", to: "b", points: [] }]);
    expect(unrouted).toEqual([0]);
  });
});
