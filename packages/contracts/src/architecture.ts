import { z } from "zod";

/** Max words in a node label: one idea per box, readable at a glance. */
export const ARCHITECTURE_LABEL_WORD_LIMIT = 3;
/** Node budget: fewer is vague, more is unreadable. */
export const ARCHITECTURE_MAX_NODES = 15;
/** Edge budget scales with nodes: about 1.3 edges per node keeps the graph readable. */
export const ARCHITECTURE_EDGE_CAP_RATIO = 1.3;

export const ArchitectureGroupSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(40),
  // Flow rank, upstream first. Optional so stored versions from before the
  // ordering work keep parsing; the layout falls back to array position.
  // Relative only — never range-checked, so 1-based model output still works.
  order: z.number().int().optional(),
});
export type ArchitectureGroup = z.infer<typeof ArchitectureGroupSchema>;

function countWords(label: string): number {
  return label
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

export const ArchitectureNodeSchema = z.object({
  id: z.string().min(1).max(64),
  label: z
    .string()
    .min(1)
    .max(60)
    .refine((value) => countWords(value) <= ARCHITECTURE_LABEL_WORD_LIMIT, {
      message: "label must be 3 words or fewer",
    }),
  group: z.string().min(1).max(64),
  description: z
    .string()
    .min(1)
    .max(140)
    .refine((value) => !value.includes("\n"), { message: "description must be one line" }),
  paths: z.array(z.string().min(1).max(256)).max(20),
  status: z.enum(["existing", "proposed"]),
});
export type ArchitectureNode = z.infer<typeof ArchitectureNodeSchema>;

export const ArchitectureEdgeSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  label: z.string().min(1).max(40).optional(),
  // Both-ends arrowhead for a genuinely two-way flow (e.g. a read the pair
  // edge already covers). Optional so stored pre-v3 versions keep parsing.
  bidirectional: z.boolean().optional(),
});
export type ArchitectureEdge = z.infer<typeof ArchitectureEdgeSchema>;

export interface AcyclicEdges {
  edges: ArchitectureEdge[];
  /** Input edges folded into an opposite pair (drawn as one edge, both heads). */
  merged: number;
  /** Input edges dropped for closing a longer cycle. */
  dropped: number;
}

function reaches(
  edges: ArchitectureEdge[],
  from: string,
  target: string,
): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of edges) {
      const next =
        edge.from === current
          ? edge.to
          : edge.bidirectional === true && edge.to === current
            ? edge.from
            : null;
      if (next === null || seen.has(next)) continue;
      if (next === target) return true;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/** One edge per node pair, acyclic, order-stable: first occurrence wins
 *  direction, opposite pairs merge into one bidirectional edge, longer-cycle
 *  closers drop. Same-direction duplicates are kept (the generate-path trim
 *  dedupes; display overlaps are invisible). Runs on every write path and at
 *  display time so stored pre-v3 cyclic graphs draw clean without migration.
 *  Deliberately a normalizer, not a zod refine: a hard reject would break
 *  reading already-stored cyclic versions. */
export function enforceAcyclicEdges(edges: ArchitectureEdge[]): AcyclicEdges {
  const kept: ArchitectureEdge[] = [];
  let merged = 0;
  let dropped = 0;
  for (const edge of edges) {
    if (edge.from === edge.to) {
      kept.push({ ...edge });
      continue;
    }
    if (kept.some((keptEdge) => keptEdge.from === edge.from && keptEdge.to === edge.to)) {
      kept.push({ ...edge });
      continue;
    }
    const reverseIndex = kept.findIndex(
      (keptEdge) => keptEdge.from === edge.to && keptEdge.to === edge.from,
    );
    if (reverseIndex >= 0) {
      const first = kept[reverseIndex] as ArchitectureEdge;
      if (first.bidirectional !== true) {
        kept[reverseIndex] = { ...first, bidirectional: true };
      }
      merged += 1;
      continue;
    }
    if (reaches(kept, edge.to, edge.from)) {
      dropped += 1;
      continue;
    }
    kept.push({ ...edge });
  }
  return { edges: kept, merged, dropped };
}

const ArchitectureStructureSchema = z.object({
  groups: z.array(ArchitectureGroupSchema).min(1).max(12),
  nodes: z.array(ArchitectureNodeSchema).min(1).max(ARCHITECTURE_MAX_NODES),
  edges: z.array(ArchitectureEdgeSchema).max(40),
});
type ArchitectureStructure = z.infer<typeof ArchitectureStructureSchema>;

// Cross-reference checks shared by model output and stored versions: no
// dangling edges, no duplicate ids, no nodes outside a known group.
function checkStructure(value: ArchitectureStructure, ctx: z.RefinementCtx): void {
  const groupIds = new Set<string>();
  for (const group of value.groups) {
    if (groupIds.has(group.id)) {
      ctx.addIssue({ code: "custom", message: `duplicate group id: ${group.id}` });
    }
    groupIds.add(group.id);
  }
  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (nodeIds.has(node.id)) {
      ctx.addIssue({ code: "custom", message: `duplicate node id: ${node.id}` });
    }
    nodeIds.add(node.id);
    if (!groupIds.has(node.group)) {
      ctx.addIssue({ code: "custom", message: `unknown group: ${node.group}` });
    }
  }
  for (const edge of value.edges) {
    if (!nodeIds.has(edge.from)) {
      ctx.addIssue({ code: "custom", message: `edge from missing node: ${edge.from}` });
    }
    if (!nodeIds.has(edge.to)) {
      ctx.addIssue({ code: "custom", message: `edge to missing node: ${edge.to}` });
    }
  }
}

/** What the model returns: structure only, no coordinates, no version. */
export const ArchitectureModelOutputSchema =
  ArchitectureStructureSchema.superRefine(checkStructure);
export type ArchitectureModelOutput = z.infer<typeof ArchitectureModelOutputSchema>;

/** Stored version: server stamps version + generatedAt, never the model. */
export const ArchitectureSchema = ArchitectureStructureSchema.extend({
  version: z.number().int().positive(),
  generatedAt: z.string().min(1),
}).superRefine(checkStructure);
export type Architecture = z.infer<typeof ArchitectureSchema>;

export const AddNodeOpSchema = z.object({
  op: z.literal("addNode"),
  node: ArchitectureNodeSchema,
});
export const UpdateNodeOpSchema = z.object({
  op: z.literal("updateNode"),
  id: z.string().min(1).max(64),
  patch: ArchitectureNodeSchema.omit({ id: true }).partial(),
});
export const RemoveNodeOpSchema = z.object({
  op: z.literal("removeNode"),
  id: z.string().min(1).max(64),
});
export const AddEdgeOpSchema = z.object({
  op: z.literal("addEdge"),
  edge: ArchitectureEdgeSchema,
});
export const RemoveEdgeOpSchema = z.object({
  op: z.literal("removeEdge"),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
});
export const AddGroupOpSchema = z.object({
  op: z.literal("addGroup"),
  group: ArchitectureGroupSchema,
});
export const ArchitecturePatchOpSchema = z.discriminatedUnion("op", [
  AddNodeOpSchema,
  UpdateNodeOpSchema,
  RemoveNodeOpSchema,
  AddEdgeOpSchema,
  RemoveEdgeOpSchema,
  AddGroupOpSchema,
]);
export type ArchitecturePatchOp = z.infer<typeof ArchitecturePatchOpSchema>;

export const ArchitecturePatchSchema = z.array(ArchitecturePatchOpSchema).min(1).max(20);
export type ArchitecturePatch = z.infer<typeof ArchitecturePatchSchema>;

/** Structured model answer for one chat turn. */
export const ArchitectureChatModelOutputSchema = z.object({
  answer: z.string().min(1).max(4000),
  patch: ArchitecturePatchSchema.optional(),
  autoApply: z.boolean(),
  relatedNodeIds: z.array(z.string().min(1).max(64)).max(15).default([]),
});
export type ArchitectureChatModelOutput = z.infer<typeof ArchitectureChatModelOutputSchema>;

export const ArchitectureChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  pinnedNodeId: z.string().min(1).max(64).nullable().default(null),
});
export type ArchitectureChatRequest = z.infer<typeof ArchitectureChatRequestSchema>;

export const ArchitectureChatResponseSchema = z.object({
  answer: z.string().min(1),
  patch: ArchitecturePatchSchema.nullable(),
  applied: z.boolean(),
  version: z.number().int().positive(),
  relatedNodeIds: z.array(z.string().min(1)),
});
export type ArchitectureChatResponse = z.infer<typeof ArchitectureChatResponseSchema>;

export const ArchitectureApplyRequestSchema = z.object({
  patch: ArchitecturePatchSchema,
});
export type ArchitectureApplyRequest = z.infer<typeof ArchitectureApplyRequestSchema>;

export const ArchitectureNodeEvidenceSchema = z.object({
  sessions: z.number().int().nonnegative(),
  totalSessions: z.number().int().nonnegative(),
  lastTouched: z.string().nullable(),
});
export type ArchitectureNodeEvidence = z.infer<typeof ArchitectureNodeEvidenceSchema>;

export const ArchitectureGetResponseSchema = z.object({
  projectId: z.string().min(1),
  architecture: ArchitectureSchema.nullable(),
  evidence: z.record(z.string(), ArchitectureNodeEvidenceSchema),
  evidenceTruncated: z.boolean(),
});
export type ArchitectureGetResponse = z.infer<typeof ArchitectureGetResponseSchema>;
