import { z } from "zod";

/** Max words in a node label: one idea per box, readable at a glance. */
export const ARCHITECTURE_LABEL_WORD_LIMIT = 3;
/** Node budget: fewer is vague, more is unreadable. */
export const ARCHITECTURE_MAX_NODES = 15;

export const ArchitectureGroupSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(40),
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
});
export type ArchitectureEdge = z.infer<typeof ArchitectureEdgeSchema>;

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
