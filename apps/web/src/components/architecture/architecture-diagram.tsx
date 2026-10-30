import type { Architecture, ArchitectureNode, ArchitectureNodeEvidence } from "@echo/contracts";
import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react";
import {
  Background,
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
import { type ArchitectureLayout, layoutArchitecture } from "./elk-layout";

type ArchNodeData = {
  label: string;
  status: "existing" | "proposed";
  tint: number;
  dimmed: boolean;
  highlighted: boolean;
  pulsing: boolean;
  pinned: boolean;
};

type ArchGroupData = {
  label: string;
};

function ArchNode({ data }: NodeProps<Node<ArchNodeData, "arch">>) {
  const tintStrength = 0.05 + Math.min(Math.max(data.tint, 0), 1) * 0.22;
  return (
    <div
      className={`h-full w-full rounded-dusk-code px-3 py-2 ${data.pulsing ? "arch-pulse" : ""}`}
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

  const nodes = useMemo(() => {
    if (!layout) return [];
    const highlighted = new Set(highlightedIds);
    const pulsing = new Set(pulseIds);
    const groupNodes: Node[] = layout.groups.map((group) => ({
      id: group.id,
      type: "archGroup",
      position: { x: group.x, y: group.y },
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
        data: {
          label: node?.label ?? placed.id,
          status: node?.status ?? "existing",
          tint: total > 0 ? sessions / total : 0,
          dimmed: !near,
          highlighted: highlighted.has(placed.id),
          pulsing: pulsing.has(placed.id),
          pinned: pinnedId === placed.id,
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
  ]);

  const edges = useMemo(
    () =>
      architecture.edges.map((edge, index) => {
        const lit = hoveredId !== null && (edge.from === hoveredId || edge.to === hoveredId);
        return {
          id: `e${index}-${edge.from}-${edge.to}`,
          source: edge.from,
          target: edge.to,
          label: edge.label,
          style: {
            stroke: lit ? duskDarkTokens.color.accent : duskDarkTokens.color.deadEnd,
            strokeWidth: lit ? 2 : 1.25,
            opacity: hoveredId === null || lit ? 1 : 0.15,
            transition: "opacity 120ms ease",
          },
        };
      }),
    [architecture, hoveredId],
  );

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
