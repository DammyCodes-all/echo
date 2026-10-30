import type { Architecture } from "@echo/contracts";
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";

export const ARCH_NODE_WIDTH = 188;
export const ARCH_NODE_HEIGHT = 76;

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

export interface ArchitectureLayout {
  groups: PositionedGroup[];
  nodes: PositionedNode[];
}

const elk = new ELK();

/** Client-side ELK compound layout: groups are containers, flow is top-down.
 *  The model outputs structure only; all coordinates come from here. */
export async function layoutArchitecture(architecture: Architecture): Promise<ArchitectureLayout> {
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.layered.spacing.edgeNodeBetweenLayers": "32",
    },
    children: architecture.groups.map((group) => ({
      id: group.id,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.padding": "[36, 16, 16, 16]",
        "elk.spacing.nodeNode": "24",
        "elk.layered.spacing.nodeNodeBetweenLayers": "48",
      },
      children: architecture.nodes
        .filter((node) => node.group === group.id)
        .map((node) => ({
          id: `${group.id}/${node.id}`,
          width: ARCH_NODE_WIDTH,
          height: ARCH_NODE_HEIGHT,
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
  return { groups, nodes };
}
