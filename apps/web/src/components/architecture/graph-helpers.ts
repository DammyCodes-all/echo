import type { Architecture } from "@echo/contracts";
import type { RoutedPoint } from "./elk-layout";

/** A node with more incident edges than this is a shared service: its edges
 *  render lighter at rest and it carries a "used by N" hint badge. Every edge
 *  still draws — hubs dim, never hide. */
export const HUB_DEGREE_THRESHOLD = 4;

/** Corner radius for routed edge polylines. */
export const EDGE_CORNER_RADIUS = 8;

/** Arrowhead size: length back from the tip, half-width across. */
export const ARROWHEAD_LENGTH = 9;
export const ARROWHEAD_HALF_WIDTH = 4;

export function computeHubs(architecture: Architecture): Set<string> {
  const degree = new Map<string, number>();
  for (const edge of architecture.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    if (edge.to !== edge.from) {
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
  }
  return new Set(
    [...degree.entries()].filter(([, count]) => count > HUB_DEGREE_THRESHOLD).map(([id]) => id),
  );
}

/** Distinct other nodes connected to the given node. */
export function neighborCount(architecture: Architecture, nodeId: string): number {
  const neighbors = new Set<string>();
  for (const edge of architecture.edges) {
    if (edge.from === nodeId && edge.to !== nodeId) neighbors.add(edge.to);
    if (edge.to === nodeId && edge.from !== nodeId) neighbors.add(edge.from);
  }
  return neighbors.size;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** SVG path for an orthogonal polyline with rounded corners. Null for
 *  degenerate input — the caller falls back to smoothstep. */
export function routedPath(
  points: RoutedPoint[],
  radius: number = EDGE_CORNER_RADIUS,
): string | null {
  const clean = points.filter(
    (point, index) =>
      index === 0 || point.x !== points[index - 1]?.x || point.y !== points[index - 1]?.y,
  );
  if (clean.length < 2) return null;
  const first = clean[0] as RoutedPoint;
  let path = `M ${round2(first.x)} ${round2(first.y)}`;
  for (let i = 1; i < clean.length - 1; i++) {
    const prev = clean[i - 1] as RoutedPoint;
    const curr = clean[i] as RoutedPoint;
    const next = clean[i + 1] as RoutedPoint;
    const inX = curr.x - prev.x;
    const inY = curr.y - prev.y;
    const outX = next.x - curr.x;
    const outY = next.y - curr.y;
    const inLen = Math.hypot(inX, inY);
    const outLen = Math.hypot(outX, outY);
    if (inLen === 0 || outLen === 0 || inX * outY - inY * outX === 0) {
      path += ` L ${round2(curr.x)} ${round2(curr.y)}`;
      continue;
    }
    const corner = Math.min(radius, inLen / 2, outLen / 2);
    const ax = curr.x - (inX / inLen) * corner;
    const ay = curr.y - (inY / inLen) * corner;
    const bx = curr.x + (outX / outLen) * corner;
    const by = curr.y + (outY / outLen) * corner;
    path += ` L ${round2(ax)} ${round2(ay)} Q ${round2(curr.x)} ${round2(curr.y)} ${round2(bx)} ${round2(by)}`;
  }
  const last = clean[clean.length - 1] as RoutedPoint;
  path += ` L ${round2(last.x)} ${round2(last.y)}`;
  return path;
}

/** SVG polygon points for an arrowhead: tip at `tip`, opening toward `from`.
 *  Null when the two coincide (no direction to point). */
export function arrowheadPoints(
  tip: RoutedPoint,
  from: RoutedPoint,
  length: number = ARROWHEAD_LENGTH,
  halfWidth: number = ARROWHEAD_HALF_WIDTH,
): string | null {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const span = Math.hypot(dx, dy);
  if (span === 0) return null;
  const ux = dx / span;
  const uy = dy / span;
  const bx = tip.x - ux * length;
  const by = tip.y - uy * length;
  const px = -uy * halfWidth;
  const py = ux * halfWidth;
  return (
    `${round2(tip.x)},${round2(tip.y)} ` +
    `${round2(bx + px)},${round2(by + py)} ` +
    `${round2(bx - px)},${round2(by - py)}`
  );
}

/** Arrowhead at the start or end of a polyline, walking past duplicate
 *  points for a real direction. Null for degenerate input (caller skips). */
export function polylineArrowhead(points: RoutedPoint[], which: "start" | "end"): string | null {
  const ordered = which === "end" ? [...points].reverse() : points;
  const tip = ordered[0];
  if (!tip) return null;
  const from = ordered.slice(1).find((point) => point.x !== tip.x || point.y !== tip.y);
  if (!from) return null;
  return arrowheadPoints(tip, from);
}

/** Point halfway along the polyline, for the hover label. Null when empty. */
export function polylineMidpoint(points: RoutedPoint[]): RoutedPoint | null {
  if (points.length === 0) return null;
  if (points.length === 1) return { ...(points[0] as RoutedPoint) };
  let total = 0;
  const lengths: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1] as RoutedPoint;
    const curr = points[i] as RoutedPoint;
    const length = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    lengths.push(length);
    total += length;
  }
  let target = total / 2;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1] as RoutedPoint;
    const curr = points[i] as RoutedPoint;
    const length = lengths[i - 1] as number;
    if (target <= length || i === points.length - 1) {
      const ratio = length === 0 ? 0 : target / length;
      return { x: prev.x + (curr.x - prev.x) * ratio, y: prev.y + (curr.y - prev.y) * ratio };
    }
    target -= length;
  }
  const last = points[points.length - 1] as RoutedPoint;
  return { x: last.x, y: last.y };
}
