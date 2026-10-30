import type { Architecture, ArchitectureNode, ArchitectureNodeEvidence } from "@echo/contracts";
import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react";
import {
  Background,
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useEffect, useMemo, useState } from "react";
import { formatTime } from "../../api";
import { duskDarkTokens } from "../../design-tokens";
import {
  ARCH_NODE_HEIGHT,
  ARCH_NODE_WIDTH,
  type ArchitectureLayout,
  layoutArchitecture,
  type RoutedPoint,
} from "./elk-layout";
import {
  computeHubs,
  isEdgeVisible,
  neighborCount,
  polylineMidpoint,
  revealedHubs,
  routedPath,
} from "./graph-helpers";

type ArchNodeData = {
  label: string;
  status: "existing" | "proposed";
  tint: number;
  dimmed: boolean;
  highlighted: boolean;
  pulsing: boolean;
  pinned: boolean;
  /** Distinct neighbors, shown as a "used by N" chip while a hub's edges hide. */
  hubUsers: number | null;
};

type ArchGroupData = {
  label: string;
};

type ArchEdgeData = {
  /** Root-frame ELK polyline; empty when the edge has no routed counterpart. */
  points: RoutedPoint[];
};

type ArchEdgeType = Edge<ArchEdgeData, "archEdge">;

function ArchEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  data,
  style,
}: EdgeProps<ArchEdgeType>) {
  const points = data?.points ?? [];
  const [fallbackPath, fallbackLabelX, fallbackLabelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const midpoint = points.length > 0 ? polylineMidpoint(points) : null;
  return (
    <>
      <BaseEdge
        id={id}
        path={points.length >= 2 ? (routedPath(points) ?? fallbackPath) : fallbackPath}
        style={style}
      />
      {typeof label === "string" && label.length > 0 ? (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${midpoint?.x ?? fallbackLabelX}px,${midpoint?.y ?? fallbackLabelY}px)`,
              fontSize: 10,
              pointerEvents: "all",
            }}
            className="react-flow__edge-label nodrag nopan"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

function ArchNode({ data }: NodeProps<Node<ArchNodeData, "arch">>) {
  const tintStrength = 0.05 + Math.min(Math.max(data.tint, 0), 1) * 0.22;
  return (
    <div
      className={`relative h-full w-full rounded-dusk-code px-3 py-2 ${data.pulsing ? "arch-pulse" : ""}`}
      style={{
        backgroundColor: `rgba(140, 155, 255, ${tintStrength.toFixed(2)})`,
        backgroundBlendMode: "screen",
        border:
          data.status === "proposed"
            ? `1.5px dashed ${duskDarkTokens.color.peach}`
            : `1px solid ${duskDarkTokens.color.hairlineStrong}`,
        outline: data.pinned
          ? `2px solid ${duskDarkTokens.color.accent}`
          : data.highlighted
            ? `2px solid ${duskDarkTokens.color.accentSoft}`
            : "none",
        outlineOffset: 2,
        opacity: data.dimmed ? 0.25 : 1,
        transition: "opacity 120ms ease",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: duskDarkTokens.color.dashedBorder,
          border: "none",
          width: 6,
          height: 6,
        }}
      />
      <p className="truncate text-[13px] font-semibold leading-5 text-dusk-ink">{data.label}</p>
      {data.status === "proposed" ? (
        <span className="mt-1 inline-block rounded-dusk-pill bg-dusk-peach-wash px-2 py-px font-mono text-[10px] uppercase tracking-widest text-dusk-peach">
          proposed
        </span>
      ) : null}
      {data.hubUsers !== null ? (
        <span className="absolute -right-2 -top-2 rounded-dusk-pill bg-dusk-pill px-1.5 py-px font-mono text-[10px] text-dusk-muted shadow">
          used by {data.hubUsers}
        </span>
      ) : null}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: duskDarkTokens.color.dashedBorder,
          border: "none",
          width: 6,
          height: 6,
        }}
      />
    </div>
  );
}

function ArchGroupNode({ data }: NodeProps<Node<ArchGroupData, "archGroup">>) {
  return (
    <div
      className="h-full w-full rounded-dusk-swatch"
      style={{ border: `1.5px dashed ${duskDarkTokens.color.dashedBorder}` }}
    >
      <span className="absolute left-3 top-2 font-mono text-[11px] uppercase tracking-widest text-dusk-muted">
        {data.label}
      </span>
    </div>
  );
}

const nodeTypes = { arch: ArchNode, archGroup: ArchGroupNode };
const edgeTypes = { archEdge: ArchEdge };

export interface PinnedNode {
  id: string;
  label: string;
}

interface ArchitectureDiagramProps {
  architecture: Architecture;
  evidence: Record<string, ArchitectureNodeEvidence>;
  highlightedIds: string[];
  pulseIds: string[];
  pinnedId: string | null;
  onPin: (node: PinnedNode) => void;
}

function NeighborList({ title, names }: { title: string; names: string[] }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-dusk-muted">{title}</p>
      <p className="mt-0.5 text-[13px] leading-5 text-dusk-ink">
        {names.length > 0 ? names.join(", ") : "—"}
      </p>
    </div>
  );
}

export const ArchitectureDiagram = memo(function ArchitectureDiagram({
  architecture,
  evidence,
  highlightedIds,
  pulseIds,
  pinnedId,
  onPin,
}: ArchitectureDiagramProps) {
  const [layout, setLayout] = useState<ArchitectureLayout | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<Element | null>(null);

  useEffect(() => {
    let live = true;
    setLayout(null);
    void layoutArchitecture(architecture).then((result) => {
      if (live) setLayout(result);
    });
    return () => {
      live = false;
    };
  }, [architecture]);

  const { refs, floatingStyles } = useFloating({
    placement: "top",
    middleware: [offset(10), flip(), shift({ padding: 8 })],
    whileElementsMounted: (reference, floating, update) =>
      autoUpdate(reference, floating, update, { animationFrame: true }),
  });

  useEffect(() => {
    refs.setReference(anchor);
  }, [anchor, refs]);

  const byId = useMemo(
    () => new Map(architecture.nodes.map((node) => [node.id, node])),
    [architecture],
  );
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of architecture.edges) {
      if (!map.has(edge.from)) map.set(edge.from, new Set());
      if (!map.has(edge.to)) map.set(edge.to, new Set());
      map.get(edge.from)?.add(edge.to);
      map.get(edge.to)?.add(edge.from);
    }
    return map;
  }, [architecture]);

  const hovered: ArchitectureNode | null = hoveredId ? (byId.get(hoveredId) ?? null) : null;

  const hubs = useMemo(() => computeHubs(architecture), [architecture]);
  const revealed = useMemo(
    () => revealedHubs(architecture, hubs, hoveredId),
    [architecture, hubs, hoveredId],
  );
  // Occurrence queues per from→to pair: ELK returns one route per input edge
  // in order, so the nth same-pair edge takes the nth route. Chat-applied
  // duplicates (the apply path never trims) still map deterministically.
  const routedByKey = useMemo(() => {
    const map = new Map<string, RoutedPoint[][]>();
    for (const edge of layout?.edges ?? []) {
      const key = `${edge.from}→${edge.to}`;
      const list = map.get(key) ?? [];
      list.push(edge.points);
      map.set(key, list);
    }
    return map;
  }, [layout]);

  const nodes = useMemo(() => {
    if (!layout) return [];
    const highlighted = new Set(highlightedIds);
    const pulsing = new Set(pulseIds);
    const groupNodes: Node[] = layout.groups.map((group) => ({
      id: group.id,
      type: "archGroup",
      position: { x: group.x, y: group.y },
      // Explicit fields, not just style: React Flow reads node.width/height
      // when clamping extent:"parent" children, before measurement lands.
      width: group.width,
      height: group.height,
      style: { width: group.width, height: group.height },
      data: {
        label:
          architecture.groups.find((candidate) => candidate.id === group.id)?.label ?? group.id,
      },
      draggable: false,
      selectable: false,
    }));
    const childNodes: Node[] = layout.nodes.map((placed) => {
      const node = byId.get(placed.id);
      const sessions = evidence[placed.id]?.sessions ?? 0;
      const total = evidence[placed.id]?.totalSessions ?? 0;
      const near =
        hoveredId === null || placed.id === hoveredId || neighbors.get(hoveredId)?.has(placed.id);
      return {
        id: placed.id,
        type: "arch",
        parentId: placed.group,
        extent: "parent" as const,
        position: { x: placed.x, y: placed.y },
        // Fixed size equal to the ELK input: without it React Flow measures
        // the content (much smaller), and every nodes-array rebuild resets
        // measured dims to 0x0, flipping the parent clamp and jumping the
        // node out from under the cursor (hover enter/leave flash loop).
        width: ARCH_NODE_WIDTH,
        height: ARCH_NODE_HEIGHT,
        style: { width: ARCH_NODE_WIDTH, height: ARCH_NODE_HEIGHT },
        data: {
          label: node?.label ?? placed.id,
          status: node?.status ?? "existing",
          tint: total > 0 ? sessions / total : 0,
          dimmed: !near,
          highlighted: highlighted.has(placed.id),
          pulsing: pulsing.has(placed.id),
          pinned: pinnedId === placed.id,
          hubUsers:
            hubs.has(placed.id) && !revealed.has(placed.id)
              ? neighborCount(architecture, placed.id)
              : null,
        } satisfies ArchNodeData,
        draggable: false,
      };
    });
    return [...groupNodes, ...childNodes];
  }, [
    layout,
    architecture,
    byId,
    evidence,
    hoveredId,
    neighbors,
    highlightedIds,
    pulseIds,
    pinnedId,
    hubs,
    revealed,
  ]);

  const edges = useMemo(() => {
    const used = new Map<string, number>();
    return architecture.edges
      .map((edge, index) => ({ edge, index }))
      .filter(({ edge }) => isEdgeVisible(edge, hubs, revealed))
      .map(({ edge, index }) => {
        const lit = hoveredId !== null && (edge.from === hoveredId || edge.to === hoveredId);
        const key = `${edge.from}→${edge.to}`;
        const occurrence = used.get(key) ?? 0;
        used.set(key, occurrence + 1);
        return {
          id: `e${index}-${edge.from}-${edge.to}`,
          type: "archEdge",
          source: edge.from,
          target: edge.to,
          label: edge.label,
          data: { points: routedByKey.get(key)?.[occurrence] ?? [] },
          style: {
            stroke: lit ? duskDarkTokens.color.accent : duskDarkTokens.color.deadEnd,
            strokeWidth: lit ? 2 : 1.25,
            opacity: hoveredId === null || lit ? 1 : 0.15,
            transition: "opacity 120ms ease",
          },
        };
      });
  }, [architecture, hoveredId, hubs, revealed, routedByKey]);

  const onNodeMouseEnter: NodeMouseHandler = (event, node) => {
    if (node.type !== "arch") return;
    setHoveredId(node.id);
    setAnchor((event.target as HTMLElement).closest(".react-flow__node"));
  };
  const onNodeMouseLeave: NodeMouseHandler = (_event, node) => {
    if (node.type !== "arch") return;
    setHoveredId((current) => (current === node.id ? null : current));
    setAnchor(null);
  };

  const popoverEvidence = hovered ? evidence[hovered.id] : undefined;
  const receivesFrom = hovered
    ? architecture.edges
        .filter((edge) => edge.to === hovered.id)
        .map((edge) => byId.get(edge.from)?.label ?? edge.from)
    : [];
  const sendsTo = hovered
    ? architecture.edges
        .filter((edge) => edge.from === hovered.id)
        .map((edge) => byId.get(edge.to)?.label ?? edge.to)
    : [];

  return (
    <div className="relative h-[520px] overflow-hidden rounded-dusk-card bg-dusk-surface">
      {layout === null ? (
        <p
          role="status"
          className="absolute inset-0 grid place-items-center text-sm text-dusk-muted"
        >
          Laying out the diagram…
        </p>
      ) : null}
      <ReactFlow
        key={architecture.version}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onNodeClick={(_event, node) => {
          if (node.type !== "arch") return;
          const target = byId.get(node.id);
          if (target) onPin({ id: target.id, label: target.label });
        }}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.4}
        maxZoom={1.5}
        proOptions={{ hideAttribution: false }}
      >
        <Background color={duskDarkTokens.color.hairlineStrong} gap={28} size={1} />
      </ReactFlow>
      {hovered ? (
        <div
          ref={refs.setFloating}
          style={{ ...floatingStyles, zIndex: 20 }}
          className="w-64 space-y-2 rounded-dusk-code border border-dusk-hairline-strong bg-dusk-pill p-3 shadow-xl"
        >
          <p className="text-sm font-semibold text-dusk-ink">{hovered.label}</p>
          <p className="text-[13px] leading-5 text-dusk-muted">{hovered.description}</p>
          <NeighborList title="Receives from" names={receivesFrom} />
          <NeighborList title="Sends to" names={sendsTo} />
          <p className="text-[13px] text-dusk-ink">
            Agent worked here:{" "}
            <span className="font-semibold">
              {popoverEvidence ? popoverEvidence.sessions : 0} of{" "}
              {popoverEvidence ? popoverEvidence.totalSessions : 0} sessions
            </span>
          </p>
          <p className="font-mono text-[11px] text-dusk-muted">
            Last touched:{" "}
            {popoverEvidence?.lastTouched ? formatTime(popoverEvidence.lastTouched) : "never"}
          </p>
        </div>
      ) : null}
    </div>
  );
});
