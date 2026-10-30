import type { Architecture } from "@echo/contracts";
import ELK, { type ElkEdgeSection, type ElkNode } from "elkjs/lib/elk.bundled.js";

export const ARCH_NODE_WIDTH = 160;
export const ARCH_NODE_HEIGHT = 48;

export interface PositionedGroup {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionedNode {
  id: string;
  group: string;
  x: number;
  y: number;
}

export interface RoutedPoint {
  x: number;
  y: number;
}

export interface RoutedEdge {
  id: string;
  from: string;
  to: string;
  /** Root-frame polyline: start, bend points, end, sections joined. */
  points: RoutedPoint[];
}

export interface ArchitectureLayout {
  groups: PositionedGroup[];
  nodes: PositionedNode[];
  edges: RoutedEdge[];
}

/** Flow rank per group id: explicit order wins, array position breaks ties
 *  and fills gaps. Dense 0..G-1 ranks — robust to 1-based, gapped, or
 *  duplicated model output. */
export function rankGroups(groups: Architecture["groups"]): Map<string, number> {
  const indexed = groups.map((group, index) => ({ group, index }));
  indexed.sort(
    (a, b) => (a.group.order ?? a.index) - (b.group.order ?? b.index) || a.index - b.index,
  );
  return new Map(indexed.map((entry, rank) => [entry.group.id, rank]));
}

const elk = new ELK();

/** Client-side ELK compound layout: one run over the whole hierarchy, flow
 *  top-down in group-rank order, orthogonal edge routes with shared
 *  fan-in/fan-out touch points. The model outputs structure only; all
 *  coordinates and edge routes come from here. */
export async function layoutArchitecture(architecture: Architecture): Promise<ArchitectureLayout> {
  const ranks = rankGroups(architecture.groups);
  const orderedGroups = [...architecture.groups].sort(
    (a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0),
  );
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      // Single run over the whole hierarchy: cross-group edges route together
      // with in-group edges. (The default SEPARATE_CHILDREN lays each group
      // out in isolation and leaves the flow order arbitrary.)
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.partitioning.activate": "true",
      "elk.edgeRouting": "ORTHOGONAL",
      // Safety net only: the pipeline enforces acyclic edges before layout,
      // so this decides nothing on well-formed input.
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      // Port-less fan-in/fan-out within one level shares touch points.
      // Observed: cross-group edges keep separate touch points (hierarchical
      // ports) — hub hiding, not merging, covers those hairballs.
      "elk.layered.mergeEdges": "true",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "60",
      "elk.layered.spacing.edgeNodeBetweenLayers": "32",
      "elk.spacing.edgeEdge": "20",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
    },
    children: orderedGroups.map((group) => ({
      id: group.id,
      layoutOptions: {
        // Key=value form only: positional "[36, 20, 20, 20]" throws inside
        // ELK and silently falls back to the 12px default, which lets nodes
        // overlap the group label. The label lives in the 36px top band.
        "elk.padding": "[top=36,left=20,bottom=20,right=20]",
        "elk.partitioning.partition": String(ranks.get(group.id) ?? 0),
      },
      children: architecture.nodes
        .filter((node) => node.group === group.id)
        .map((node) => ({
          id: `${group.id}/${node.id}`,
          width: ARCH_NODE_WIDTH,
          height: ARCH_NODE_HEIGHT,
          layoutOptions: {
            "elk.partitioning.partition": String(ranks.get(group.id) ?? 0),
          },
        })),
    })),
    edges: architecture.edges.map((edge, index) => {
      const from = architecture.nodes.find((node) => node.id === edge.from);
      const to = architecture.nodes.find((node) => node.id === edge.to);
      return {
        id: `e${index}`,
        sources: [`${from?.group ?? ""}/${edge.from}`],
        targets: [`${to?.group ?? ""}/${edge.to}`],
      };
    }),
  };

  const laid = await elk.layout(graph);
  const groups: PositionedGroup[] = [];
  const nodes: PositionedNode[] = [];
  for (const group of laid.children ?? []) {
    groups.push({
      id: group.id,
      x: group.x ?? 0,
      y: group.y ?? 0,
      width: group.width ?? ARCH_NODE_WIDTH,
      height: group.height ?? ARCH_NODE_HEIGHT,
    });
    for (const child of group.children ?? []) {
      // ELK positions are parent-relative, matching React Flow's parentId
      // coordinates, so they transfer without conversion.
      const slash = child.id.indexOf("/");
      nodes.push({
        id: slash < 0 ? child.id : child.id.slice(slash + 1),
        group: group.id,
        x: child.x ?? 0,
        y: child.y ?? 0,
      });
    }
  }
  const { edges: routed, unrouted } = collectRoutedEdges(laid, architecture.edges);
  if (unrouted.length > 0) {
    console.warn(
      `[architecture] ELK returned no route for ${unrouted.length} edge(s) ` +
        `(${unrouted.map((index) => `e${index}`).join(", ")}); falling back to smoothstep`,
    );
  }
  return { groups, nodes, edges: routed };
}

export interface CollectedRoutes {
  edges: RoutedEdge[];
  /** Input edge indices ELK returned no sections for (smoothstep fallback). */
  unrouted: number[];
}

/** Collect one route per input edge from wherever ELK placed it: edges are
 *  defined at the root but may nest under a group container in the result.
 *  Sections are framed by the endpoints' lowest common ancestor — group
 *  offset for same-group edges, root frame otherwise (proven by the endpoint
 *  tests: a wrong frame here fails them loudly). Section-less edges keep
 *  their identity with empty points so the count always matches the input. */
export function collectRoutedEdges(
  laid: ElkNode,
  edges: Array<{ from: string; to: string }>,
): CollectedRoutes {
  const sectionsByIndex = new Map<number, ElkEdgeSection[]>();
  const visit = (node: ElkNode): void => {
    for (const edge of node.edges ?? []) {
      const match = /^e(\d+)$/.exec(edge.id);
      if (!match || sectionsByIndex.has(Number(match[1]))) continue;
      sectionsByIndex.set(Number(match[1]), edge.sections ?? []);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(laid);
  // Container frames from the laid tree itself: group ids carry absolute
  // positions, leaf ids carry the "group/node" convention from the request.
  const groupOffset = new Map<string, RoutedPoint>();
  const nodeGroup = new Map<string, string>();
  for (const group of laid.children ?? []) {
    groupOffset.set(group.id, { x: group.x ?? 0, y: group.y ?? 0 });
    for (const child of group.children ?? []) {
      const slash = child.id.indexOf("/");
      nodeGroup.set(slash < 0 ? child.id : child.id.slice(slash + 1), group.id);
    }
  }
  const collected: RoutedEdge[] = [];
  const unrouted: number[] = [];
  edges.forEach((edge, index) => {
    const fromGroup = nodeGroup.get(edge.from);
    const offset =
      fromGroup !== undefined && fromGroup === nodeGroup.get(edge.to)
        ? (groupOffset.get(fromGroup) ?? { x: 0, y: 0 })
        : { x: 0, y: 0 };
    const points = joinSections(sectionsByIndex.get(index) ?? []).map((point) => ({
      x: point.x + offset.x,
      y: point.y + offset.y,
    }));
    if (points.length === 0) unrouted.push(index);
    collected.push({ id: `e${index}`, from: edge.from, to: edge.to, points });
  });
  return { edges: collected, unrouted };
}

function joinSections(sections: ElkEdgeSection[]): RoutedPoint[] {
  const points: RoutedPoint[] = [];
  const push = (point: { x: number; y: number }): void => {
    const last = points[points.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) {
      points.push({ x: point.x, y: point.y });
    }
  };
  for (const section of sections) {
    push(section.startPoint);
    for (const bend of section.bendPoints ?? []) push(bend);
    push(section.endPoint);
  }
  return points;
}
