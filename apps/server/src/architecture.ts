import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARCHITECTURE_EDGE_CAP_RATIO,
  type Architecture,
  type ArchitectureChatModelOutput,
  ArchitectureChatModelOutputSchema,
  type ArchitectureEdge,
  type ArchitectureModelOutput,
  ArchitectureModelOutputSchema,
  type ArchitectureNodeEvidence,
  type ArchitecturePatch,
  type ArchitecturePatchOp,
  ArchitectureSchema,
  enforceAcyclicEdges,
} from "@echo/contracts";
import {
  type EchoDb,
  getArchitectureVersion,
  getCodeIndexState,
  getLatestArchitectureVersion,
  getProject,
  insertArchitectureVersion,
  listCodeFiles,
  listProjectSessionFiles,
  type ProjectSessionFile,
} from "@echo/db";
import {
  type ChatMessage,
  type ModelConfig,
  ModelError,
  modelConfigFromEnv,
  requestJson,
} from "@echo/model";
import { redactJson } from "@echo/redaction";
import { Minimatch } from "minimatch";

export const ARCHITECTURE_PROMPT_VERSION = "architecture-v3";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOKENS = 16_000;
const DEFAULT_REASONING_EFFORT = "low";
const MAX_CONTEXT_FILES = 500;
const README_CHARS = 2000;
const AGENTS_CHARS = 2000;
const DOCS_FILE_CHARS = 1000;
const DOCS_FILE_LIMIT = 6;

export class ArchitecturePatchError extends Error {}

export interface AppliedPatch {
  structure: ArchitectureModelOutput;
  droppedEdges: Array<{ from: string; to: string }>;
}

/**
 * Atomic patch application: every op is checked, then the merged structure
 * is re-validated against the same schema the model output must satisfy. Any
 * failure throws and nothing is saved. Removing a node drops its edges and
 * reports them; removing a missing edge or node is an error, not a no-op, so
 * model confusion surfaces instead of silently doing nothing.
 */
export function applyPatch(current: Architecture, patch: ArchitecturePatch): AppliedPatch {
  const groups = current.groups.map((group) => ({ ...group }));
  const nodes = current.nodes.map((node) => ({ ...node, paths: [...node.paths] }));
  const edges = current.edges.map((edge) => ({ ...edge }));
  const droppedEdges: Array<{ from: string; to: string }> = [];

  const groupById = new Map(groups.map((group) => [group.id, group]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const op of patch) {
    applyOp(op);
  }

  const parsed = ArchitectureModelOutputSchema.safeParse({ groups, nodes, edges });
  if (!parsed.success) {
    throw new ArchitecturePatchError(`patched architecture is invalid: ${parsed.error.message}`);
  }
  // Same invariant as generation: opposite pairs merge visibly (the diagram
  // draws both arrowheads), longer cycles lose their closer. No warnings
  // channel on this path — the drawn graph shows the result.
  const acyclic = enforceAcyclicEdges(parsed.data.edges);
  return { structure: { ...parsed.data, edges: acyclic.edges }, droppedEdges };

  function applyOp(op: ArchitecturePatchOp): void {
    switch (op.op) {
      case "addGroup": {
        if (groupById.has(op.group.id)) {
          throw new ArchitecturePatchError(`group already exists: ${op.group.id}`);
        }
        const group = { ...op.group };
        groups.push(group);
        groupById.set(group.id, group);
        return;
      }
      case "addNode": {
        if (nodeById.has(op.node.id)) {
          throw new ArchitecturePatchError(`node already exists: ${op.node.id}`);
        }
        if (!groupById.has(op.node.group)) {
          throw new ArchitecturePatchError(`unknown group for new node: ${op.node.group}`);
        }
        const node = { ...op.node, paths: [...op.node.paths] };
        nodes.push(node);
        nodeById.set(node.id, node);
        return;
      }
      case "updateNode": {
        const node = nodeById.get(op.id);
        if (!node) throw new ArchitecturePatchError(`unknown node: ${op.id}`);
        if (op.patch.group !== undefined && !groupById.has(op.patch.group)) {
          throw new ArchitecturePatchError(`unknown group: ${op.patch.group}`);
        }
        Object.assign(node, op.patch);
        return;
      }
      case "removeNode": {
        const node = nodeById.get(op.id);
        if (!node) throw new ArchitecturePatchError(`unknown node: ${op.id}`);
        nodeById.delete(op.id);
        nodes.splice(nodes.indexOf(node), 1);
        for (let i = edges.length - 1; i >= 0; i--) {
          const edge = edges[i] as (typeof edges)[number];
          if (edge.from === op.id || edge.to === op.id) {
            droppedEdges.push({ from: edge.from, to: edge.to });
            edges.splice(i, 1);
          }
        }
        return;
      }
      case "addEdge": {
        if (!nodeById.has(op.edge.from)) {
          throw new ArchitecturePatchError(`edge from missing node: ${op.edge.from}`);
        }
        if (!nodeById.has(op.edge.to)) {
          throw new ArchitecturePatchError(`edge to missing node: ${op.edge.to}`);
        }
        const existing = edges.find((edge) => edge.from === op.edge.from && edge.to === op.edge.to);
        if (existing) {
          existing.label = op.edge.label;
          if (op.edge.bidirectional !== undefined) {
            existing.bidirectional = op.edge.bidirectional;
          }
          return;
        }
        edges.push({ ...op.edge });
        return;
      }
      case "removeEdge": {
        const index = edges.findIndex((edge) => edge.from === op.from && edge.to === op.to);
        if (index < 0) {
          throw new ArchitecturePatchError(`unknown edge: ${op.from} -> ${op.to}`);
        }
        edges.splice(index, 1);
        return;
      }
    }
  }
}

/**
 * Regenerate rewrites the "existing" world and keeps every "proposed" node
 * verbatim, with its group and any edges whose other endpoint still exists. A
 * regenerated node that reuses a proposed id wins: the model found it in the
 * code, so it graduates to "existing".
 */
export function mergeRegenerate(
  current: Architecture | null,
  fresh: ArchitectureModelOutput,
): ArchitectureModelOutput {
  if (!current) return fresh;
  const groups = fresh.groups.map((group) => ({ ...group }));
  const nodes = fresh.nodes.map((node) => ({ ...node, paths: [...node.paths] }));
  const edges = fresh.edges.map((edge) => ({ ...edge }));
  const groupIds = new Set(groups.map((group) => group.id));
  const nodeIds = new Set(nodes.map((node) => node.id));

  for (const node of current.nodes) {
    if (node.status !== "proposed" || nodeIds.has(node.id)) continue;
    if (!groupIds.has(node.group)) {
      const group = current.groups.find((candidate) => candidate.id === node.group);
      if (group) {
        groups.push({ ...group });
        groupIds.add(group.id);
      } else {
        continue;
      }
    }
    nodes.push({ ...node, paths: [...node.paths] });
    nodeIds.add(node.id);
    for (const edge of current.edges) {
      if (edge.from !== node.id && edge.to !== node.id) continue;
      const other = edge.from === node.id ? edge.to : edge.from;
      if (!nodeIds.has(other)) continue;
      if (edges.some((kept) => kept.from === edge.from && kept.to === edge.to)) continue;
      edges.push({ ...edge });
    }
  }
  return ArchitectureModelOutputSchema.parse({ groups, nodes, edges });
}

export function edgeCapFor(nodeCount: number): number {
  return Math.max(1, Math.ceil(nodeCount * ARCHITECTURE_EDGE_CAP_RATIO));
}

/** Indices of transitive edges: A -> C is transitive when a path A -> ... -> C
 *  exists without it. Computed against the full set, removed all at once, so
 *  diamonds and triangles resolve in one pass. Cycles are never flagged, and
 *  neither are self-loops: a part's direct self-dependence is not implied by
 *  a longer return cycle, so dropping it would lose meaning. */
export function findTransitiveEdges(edges: ArchitectureEdge[]): number[] {
  const dropped: number[] = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i] as ArchitectureEdge;
    if (edge.from === edge.to) continue;
    const seen = new Set<string>([edge.from]);
    const queue = [edge.from];
    let found = false;
    while (queue.length > 0 && !found) {
      const current = queue.shift() as string;
      for (let j = 0; j < edges.length; j++) {
        if (j === i) continue;
        const candidate = edges[j] as ArchitectureEdge;
        if (candidate.from !== current || seen.has(candidate.to)) continue;
        if (candidate.to === edge.to) {
          found = true;
          break;
        }
        seen.add(candidate.to);
        queue.push(candidate.to);
      }
    }
    if (found) dropped.push(i);
  }
  return dropped;
}

export interface TrimmedEdges {
  edges: ArchitectureEdge[];
  droppedDuplicates: number;
  droppedTransitive: number;
  droppedOverflow: number;
}

/** Deterministic trim: exact duplicates first, then transitive edges, then the
 *  tail (the model lists important edges first, so the head is kept). */
export function trimEdgesToCap(edges: ArchitectureEdge[], cap: number): TrimmedEdges {
  const seen = new Set<string>();
  const deduped = edges.filter((edge) => {
    const key = `${edge.from}→${edge.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const transitive = new Set(findTransitiveEdges(deduped));
  const kept = deduped.filter((_, index) => !transitive.has(index));
  if (kept.length <= cap) {
    return {
      edges: kept,
      droppedDuplicates: edges.length - deduped.length,
      droppedTransitive: deduped.length - kept.length,
      droppedOverflow: 0,
    };
  }
  return {
    edges: kept.slice(0, cap),
    droppedDuplicates: edges.length - deduped.length,
    droppedTransitive: deduped.length - kept.length,
    droppedOverflow: kept.length - cap,
  };
}

/** Counts only — safe to log and to send over the wire unredacted. */
function trimWarning(had: number, trimmed: TrimmedEdges, cap: number, nodeCount: number): string {
  const parts = [
    `kept ${trimmed.edges.length} of ${had} edges (cap ${cap} for ${nodeCount} nodes)`,
  ];
  if (trimmed.droppedDuplicates > 0) parts.push(`dropped ${trimmed.droppedDuplicates} duplicates`);
  if (trimmed.droppedTransitive > 0) parts.push(`dropped ${trimmed.droppedTransitive} transitive`);
  if (trimmed.droppedOverflow > 0) parts.push(`dropped ${trimmed.droppedOverflow} more to fit`);
  return parts.join("; ");
}

export function computeEvidence(
  nodes: Array<{ id: string; paths: string[] }>,
  sessionFiles: ProjectSessionFile[],
  totalSessions: number,
): Record<string, ArchitectureNodeEvidence> {
  // One compiled matcher set per node, one pass over the files: a bad glob
  // matches nothing (evidence gap, not an error).
  const matchers = nodes.map((node) => ({
    id: node.id,
    match: node.paths.map((pattern) => {
      try {
        return new Minimatch(pattern, { dot: true });
      } catch {
        return null;
      }
    }),
  }));
  const sessionsByNode = new Map(nodes.map((node) => [node.id, new Set<string>([])]));
  const touchedByNode = new Map<string, string | null>(nodes.map((node) => [node.id, null]));
  for (const file of sessionFiles) {
    for (const { id, match } of matchers) {
      if (!match.some((matcher) => matcher?.match(file.path) === true)) continue;
      sessionsByNode.get(id)?.add(file.sessionId);
      const seen = touchedByNode.get(id);
      if (seen === null || seen === undefined || file.takenAt > seen) {
        touchedByNode.set(id, file.takenAt);
      }
    }
  }
  return Object.fromEntries(
    nodes.map((node) => [
      node.id,
      {
        sessions: sessionsByNode.get(node.id)?.size ?? 0,
        totalSessions,
        lastTouched: touchedByNode.get(node.id) ?? null,
      } satisfies ArchitectureNodeEvidence,
    ]),
  );
}

export interface ArchitectureDocs {
  readme: string | null;
  agents: string | null;
  claude: string | null;
  docs: Array<{ name: string; excerpt: string }>;
  packageName: string | null;
  packageDescription: string | null;
}

/** Bounded, best-effort read of repo-authored docs. Missing or unreadable
 *  files are not a signal — never an error, never fabricated. */
export function readArchitectureDocs(root: string): ArchitectureDocs {
  const readBounded = (path: string, chars: number): string | null => {
    try {
      const text = readFileSync(path, "utf8").trim();
      return text.length > 0 ? text.slice(0, chars) : null;
    } catch {
      return null;
    }
  };
  let readme: string | null = null;
  for (const name of ["README.md", "readme.md"]) {
    readme = readBounded(join(root, name), README_CHARS);
    if (readme) break;
  }
  const docs: Array<{ name: string; excerpt: string }> = [];
  try {
    for (const name of readdirSync(join(root, "docs"))) {
      if (docs.length >= DOCS_FILE_LIMIT) break;
      if (!name.endsWith(".md")) continue;
      const excerpt = readBounded(join(root, "docs", name), DOCS_FILE_CHARS);
      if (excerpt) docs.push({ name: `docs/${name}`, excerpt });
    }
  } catch {
    // No docs dir, or unreadable: no docs signal.
  }
  let packageName: string | null = null;
  let packageDescription: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: unknown;
      description?: unknown;
    };
    if (typeof pkg.name === "string" && pkg.name.trim().length > 0) packageName = pkg.name.trim();
    if (typeof pkg.description === "string" && pkg.description.trim().length > 0) {
      packageDescription = pkg.description.trim().slice(0, 500);
    }
  } catch {
    // Not a node repo, or unreadable: no package signal.
  }
  return {
    readme,
    agents: readBounded(join(root, "AGENTS.md"), AGENTS_CHARS),
    claude: readBounded(join(root, "CLAUDE.md"), AGENTS_CHARS),
    docs,
    packageName,
    packageDescription,
  };
}

export type ArchitectureStreamEvent =
  | { type: "generation.progress"; stage: string; progress: number }
  | { type: "generation.done"; version: number; warnings: string[] }
  | { type: "generation.error"; message: string }
  | { type: "architecture.updated"; version: number };

export interface ArchitectureLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export interface ArchitectureServiceDeps {
  db: EchoDb;
  log: ArchitectureLogger;
}

export interface ArchitectureServiceOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  timeoutMs?: number;
  /** Rebuild the code index when missing; sync no-op when fresh. */
  ensureIndex?: (projectId: string) => void;
  /**
   * Run generation in the background (default true). False runs inline and
   * returns the outcome — deterministic, for tests.
   */
  background?: boolean;
}

export interface ArchitectureOutcome {
  status: number;
  body: unknown;
}

const GENERATION_SYSTEM = `You describe a codebase's FUNCTIONAL architecture: what the system does, grouped by purpose (capture, processing, storage, interfaces). NOT a file tree, NOT an import graph.
Return ONLY JSON: {"groups":[{"id","label","order"}],"nodes":[{"id","label","group","description","paths","status":"existing"}],"edges":[{"from","to","label?","bidirectional?"}]}.
Rules: 8 to 15 nodes; labels of 3 words or fewer; one-line descriptions; every node in a known group; every edge between known nodes; paths are repo-relative globs (e.g. "packages/capture-*/**") mapping the part to the code it owns. Groups carry order (0-based flow rank, upstream first: capture before processing before storage before interfaces). Edges are primary data or control flow only — not uses/imports, no transitive edges (if A -> B -> C, never add A -> C). One edge per node pair, directed by write/data flow and never forming a cycle: a read from storage goes in the reader's description, never as a backward edge — set bidirectional true only when the return flow is important enough to draw. Keep edges under ~1.3 per node (e.g. at most 15 edges for 12 nodes). No coordinates, no markdown.`;

const CHAT_SYSTEM = `You answer questions about a project's functional architecture and optionally change it.
The current architecture JSON, the pinned node (if any), and conversation context are in the user message.
Return ONLY JSON: {"answer": string, "patch"?: Op[], "autoApply": boolean, "relatedNodeIds": string[]}.
Op is one of: {"op":"addNode","node":{...,"status":"proposed"}} | {"op":"updateNode","id","patch"} | {"op":"removeNode","id"} | {"op":"addEdge","edge":{"from","to","label?","bidirectional?"}} | {"op":"removeEdge","from","to"} | {"op":"addGroup","group":{"id","label","order?"}}.
New nodes keep within the same constraints (label 3 words max, known group, one-line description, globs for paths). Added nodes use status "proposed" unless you verified the part exists in the code. Added edges must be primary data or control flow, never transitive; never add the reverse of an existing edge — one edge per pair, directed by write/data flow (reads live in descriptions), bidirectional true only when the return flow matters; added groups include order (flow rank, upstream first).
Set autoApply true ONLY when the user message is a clear, specific architecture change. When the request is ambiguous, exploratory, or a question, return the patch you would apply with autoApply false (the UI shows an Apply button) or no patch at all for pure questions.
relatedNodeIds lists the node ids your answer refers to.`;

export interface ArchitectureService {
  get(projectId: string): ArchitectureOutcome;
  generate(projectId: string): ArchitectureOutcome | Promise<ArchitectureOutcome>;
  subscribe(projectId: string, listener: (event: ArchitectureStreamEvent) => void): () => void;
  chat(
    projectId: string,
    message: string,
    pinnedNodeId: string | null,
  ): Promise<ArchitectureOutcome>;
  applyPatch(projectId: string, patch: ArchitecturePatch): ArchitectureOutcome;
  undo(projectId: string): ArchitectureOutcome;
}

export function createArchitectureService(
  deps: ArchitectureServiceDeps,
  options: ArchitectureServiceOptions = {},
): ArchitectureService {
  const { db, log } = deps;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const background = options.background ?? true;

  const subscribers = new Map<string, Set<(event: ArchitectureStreamEvent) => void>>();
  const generating = new Set<string>([]);

  function publish(projectId: string, event: ArchitectureStreamEvent): void {
    for (const listener of subscribers.get(projectId) ?? []) {
      try {
        listener(event);
      } catch (error) {
        log.error({ err: String(error) }, "architecture subscriber failed");
      }
    }
  }

  function resolveConfig(): ModelConfig {
    if (env.ECHO_MODEL === "off") {
      throw new ModelError("model_error", "ECHO_MODEL=off");
    }
    const config = modelConfigFromEnv(env);
    const explicitMax = Number.parseInt(env.META_MAX_TOKENS ?? "", 10);
    return {
      ...config,
      maxTokens:
        Number.isFinite(explicitMax) && explicitMax > 0 ? config.maxTokens : DEFAULT_MAX_TOKENS,
      reasoningEffort: config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    };
  }

  async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const label = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ModelError("model_error", `architecture timed out after ${label}`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([run(controller.signal), expired]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function unavailable(error: unknown): ArchitectureOutcome {
    const message = error instanceof Error ? error.message : "model unavailable";
    return { status: 503, body: { error: { code: "architecture_unavailable", message } } };
  }

  /** Every architecture write passes the redaction gate; a failure drops the
   *  content and the caller reports a content-free diagnostic. */
  function saveVersion(
    projectId: string,
    structure: ArchitectureModelOutput,
    generator: string,
  ): Architecture {
    const latest = getLatestArchitectureVersion(db, projectId);
    const stamped = ArchitectureSchema.parse({
      ...structure,
      version: (latest?.version ?? 0) + 1,
      generatedAt: clock().toISOString(),
    });
    let scanned: unknown;
    try {
      scanned = redactJson(stamped).value;
    } catch (error) {
      throw new ArchitecturePatchError(
        `redaction failed; content dropped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const checked = ArchitectureSchema.safeParse(scanned);
    if (!checked.success) {
      throw new ArchitecturePatchError("redacted architecture failed validation; content dropped");
    }
    insertArchitectureVersion(db, {
      projectId,
      version: checked.data.version,
      payloadJson: JSON.stringify(checked.data),
      generator,
    });
    return checked.data;
  }

  function currentArchitecture(projectId: string): Architecture | null {
    const row = getLatestArchitectureVersion(db, projectId);
    if (!row) return null;
    const parsed = ArchitectureSchema.safeParse(JSON.parse(row.payloadJson) as unknown);
    if (!parsed.success) {
      throw new ArchitecturePatchError("stored architecture failed validation");
    }
    return parsed.data;
  }

  function evidenceFor(projectId: string, architecture: Architecture | null) {
    if (!architecture) return { evidence: {}, evidenceTruncated: false };
    const project = getProject(db, projectId);
    const { rows, truncated } = listProjectSessionFiles(db, projectId);
    return {
      evidence: computeEvidence(architecture.nodes, rows, project?.sessionCount ?? 0),
      evidenceTruncated: truncated,
    };
  }

  function buildGenerationContext(projectId: string, root: string): string {
    let state = getCodeIndexState(db, projectId);
    if (!state && options.ensureIndex) {
      options.ensureIndex(projectId);
      state = getCodeIndexState(db, projectId);
    }
    if (!state) {
      throw new ModelError("model_error", "code_index_missing");
    }
    const { files, truncated } = listCodeFiles(db, projectId, MAX_CONTEXT_FILES);
    const fileLines = files.map((file) => `${file.path} (${file.language}, ${file.size}b)`);
    if (truncated) fileLines.push(`… and more (list capped at ${MAX_CONTEXT_FILES} files)`);
    const docs = readArchitectureDocs(root);
    const sections = [
      `Project files (${state.fileCount} total, showing ${files.length}):\n${fileLines.join("\n")}`,
    ];
    if (docs.packageName || docs.packageDescription) {
      sections.push(
        `Package: ${docs.packageName ?? "unknown"}${docs.packageDescription ? ` — ${docs.packageDescription}` : ""}`,
      );
    }
    if (docs.readme) sections.push(`README.md:\n${docs.readme}`);
    if (docs.agents) sections.push(`AGENTS.md:\n${docs.agents}`);
    if (docs.claude) sections.push(`CLAUDE.md:\n${docs.claude}`);
    for (const doc of docs.docs) sections.push(`${doc.name}:\n${doc.excerpt}`);
    return sections.join("\n\n");
  }

  function repairPrompt(fresh: ArchitectureModelOutput, cap: number): string {
    return [
      `Your graph has ${fresh.edges.length} edges for ${fresh.nodes.length} nodes, over the cap of ${cap}.`,
      `Return the SAME groups and nodes with at most ${cap} edges: keep only primary data or control flow, drop every transitive edge (A -> C whenever A -> B -> C exists), then drop the least important until under the cap.`,
      `Return ONLY the same JSON shape, no markdown.`,
      `Previous output:`,
      JSON.stringify(fresh),
    ].join("\n");
  }

  function trimmedWithWarning(
    structure: ArchitectureModelOutput,
    warnings: string[],
  ): ArchitectureModelOutput {
    const cap = edgeCapFor(structure.nodes.length);
    const trimmed = trimEdgesToCap(structure.edges, cap);
    const dropped = trimmed.droppedDuplicates + trimmed.droppedTransitive + trimmed.droppedOverflow;
    if (dropped === 0) return structure;
    warnings.push(trimWarning(structure.edges.length, trimmed, cap, structure.nodes.length));
    return { ...structure, edges: trimmed.edges };
  }

  function acyclicWithWarning(
    structure: ArchitectureModelOutput,
    warnings: string[],
  ): ArchitectureModelOutput {
    const acyclic = enforceAcyclicEdges(structure.edges);
    if (acyclic.merged === 0 && acyclic.dropped === 0) return structure;
    const parts = [];
    if (acyclic.merged > 0) {
      const pair = acyclic.merged === 1 ? "pair" : "pairs";
      parts.push(`merged ${acyclic.merged} opposite ${pair} into bidirectional edges`);
    }
    if (acyclic.dropped > 0) {
      const edge = acyclic.dropped === 1 ? "edge" : "edges";
      parts.push(`dropped ${acyclic.dropped} cycle-closing ${edge}`);
    }
    warnings.push(`kept the graph acyclic (${parts.join("; ")})`);
    return { ...structure, edges: acyclic.edges };
  }

  async function runGeneration(projectId: string, root: string): Promise<string[]> {
    const progress = (stage: string, value: number) =>
      publish(projectId, { type: "generation.progress", stage, progress: value });
    const warnings: string[] = [];
    const parseArchitecture = (raw: unknown): ArchitectureModelOutput =>
      ArchitectureModelOutputSchema.parse(raw);
    try {
      progress("reading", 0.1);
      const context = buildGenerationContext(projectId, root);
      const config = resolveConfig();
      const messages: ChatMessage[] = [
        { role: "system", content: GENERATION_SYSTEM },
        { role: "user", content: `Describe this project's functional architecture:\n\n${context}` },
      ];
      const redacted = redactJson(messages).value as ChatMessage[];
      progress("drafting", 0.3);
      const fresh = (
        await withDeadline((signal) =>
          requestJson(config, redacted, parseArchitecture, {
            fetchImpl,
            retryMaxTokens: Math.max(config.maxTokens * 2, 8192),
            reasoningEffort: config.reasoningEffort,
            signal,
          }),
        )
      ).value;
      // Normalize before the cap check: merges and cycle drops shrink the
      // count, so an over-cap draft can settle without a repair round-trip.
      let candidate = acyclicWithWarning(fresh, warnings);
      if (candidate.edges.length > edgeCapFor(candidate.nodes.length)) {
        // One repair attempt, best-effort: anything short of a valid,
        // under-cap output falls through to the deterministic trim below.
        progress("trimming", 0.6);
        try {
          const repairMessages: ChatMessage[] = [
            { role: "system", content: GENERATION_SYSTEM },
            {
              role: "user",
              content: repairPrompt(candidate, edgeCapFor(candidate.nodes.length)),
            },
          ];
          const repairRedacted = redactJson(repairMessages).value as ChatMessage[];
          const repaired = (
            await withDeadline((signal) =>
              requestJson(config, repairRedacted, parseArchitecture, {
                fetchImpl,
                retryMaxTokens: Math.max(config.maxTokens * 2, 8192),
                reasoningEffort: config.reasoningEffort,
                signal,
              }),
            )
          ).value;
          candidate = acyclicWithWarning(repaired, warnings);
        } catch (error) {
          log.info(
            { project_id: projectId, err: String(error) },
            "architecture repair skipped; trimming fresh output",
          );
        }
      }
      progress("saving", 0.85);
      const merged = mergeRegenerate(
        currentArchitecture(projectId),
        trimmedWithWarning(candidate, warnings),
      );
      const saved = saveVersion(
        projectId,
        trimmedWithWarning(acyclicWithWarning(merged, warnings), warnings),
        `model/${ARCHITECTURE_PROMPT_VERSION}`,
      );
      if (warnings.length > 0) {
        log.info({ project_id: projectId, warnings }, "architecture generation adjusted edges");
      }
      progress("done", 1);
      publish(projectId, { type: "generation.done", version: saved.version, warnings });
      publish(projectId, { type: "architecture.updated", version: saved.version });
      return warnings;
    } catch (error) {
      // Content-free over the wire: the detail stays in the daemon log.
      const message =
        error instanceof ModelError && error.message === "code_index_missing"
          ? "code index not ready"
          : error instanceof ArchitecturePatchError && error.message.startsWith("redaction")
            ? "redaction failed; content dropped"
            : error instanceof Error
              ? error.message
              : "generation failed";
      log.error({ err: String(error), project_id: projectId }, "architecture generation failed");
      publish(projectId, { type: "generation.error", message });
      return warnings;
    } finally {
      generating.delete(projectId);
    }
  }

  return {
    get(projectId) {
      const project = getProject(db, projectId);
      if (!project) {
        return { status: 404, body: { error: { code: "not_found", message: "unknown project" } } };
      }
      let architecture: Architecture | null;
      try {
        architecture = currentArchitecture(projectId);
      } catch {
        return {
          status: 500,
          body: { error: { code: "architecture_unavailable", message: "stored data invalid" } },
        };
      }
      return {
        status: 200,
        body: {
          projectId: project.id,
          architecture,
          ...evidenceFor(projectId, architecture),
        },
      };
    },

    generate(projectId) {
      const project = getProject(db, projectId);
      if (!project) {
        return { status: 404, body: { error: { code: "not_found", message: "unknown project" } } };
      }
      if (generating.has(projectId)) {
        return {
          status: 409,
          body: {
            error: { code: "generation_in_progress", message: "generation already running" },
          },
        };
      }
      if (!background) {
        return (async () => {
          generating.add(projectId);
          const warnings = await runGeneration(projectId, project.root);
          const latest = getLatestArchitectureVersion(db, projectId);
          if (!latest) {
            return {
              status: 500,
              body: {
                error: { code: "architecture_unavailable", message: "generation failed" },
              },
            } satisfies ArchitectureOutcome;
          }
          return {
            status: 200,
            body: { version: latest.version, warnings },
          } satisfies ArchitectureOutcome;
        })();
      }
      generating.add(projectId);
      void runGeneration(projectId, project.root);
      return { status: 202, body: { started: true } };
    },

    subscribe(projectId, listener) {
      let set = subscribers.get(projectId);
      if (!set) {
        set = new Set();
        subscribers.set(projectId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) subscribers.delete(projectId);
      };
    },

    async chat(projectId, message, pinnedNodeId) {
      const project = getProject(db, projectId);
      if (!project) {
        return { status: 404, body: { error: { code: "not_found", message: "unknown project" } } };
      }
      let architecture: Architecture | null;
      try {
        architecture = currentArchitecture(projectId);
      } catch {
        return {
          status: 500,
          body: { error: { code: "architecture_unavailable", message: "stored data invalid" } },
        };
      }
      if (!architecture) {
        return {
          status: 400,
          body: {
            error: { code: "invalid_request", message: "generate the architecture first" },
          },
        };
      }
      const pinned = pinnedNodeId
        ? architecture.nodes.find((node) => node.id === pinnedNodeId)
        : undefined;
      if (pinnedNodeId && !pinned) {
        return {
          status: 400,
          body: { error: { code: "invalid_request", message: "unknown pinned node" } },
        };
      }
      let config: ModelConfig;
      try {
        config = resolveConfig();
      } catch (error) {
        return unavailable(error);
      }
      const messages: ChatMessage[] = [
        { role: "system", content: CHAT_SYSTEM },
        {
          role: "user",
          content: [
            `Current architecture:\n${JSON.stringify(architecture)}`,
            pinned ? `Pinned node context:\n${JSON.stringify(pinned)}` : null,
            `User message:\n${message}`,
          ]
            .filter((part): part is string => part !== null)
            .join("\n\n"),
        },
      ];
      let redacted: ChatMessage[];
      try {
        redacted = redactJson(messages).value as ChatMessage[];
      } catch {
        return {
          status: 500,
          body: { error: { code: "redaction_failed", message: "request dropped by redaction" } },
        };
      }
      let answer: ArchitectureChatModelOutput;
      try {
        answer = (
          await withDeadline((signal) =>
            requestJson(config, redacted, (raw) => ArchitectureChatModelOutputSchema.parse(raw), {
              fetchImpl,
              retryMaxTokens: Math.max(config.maxTokens * 2, 8192),
              reasoningEffort: config.reasoningEffort,
              signal,
            }),
          )
        ).value;
      } catch (error) {
        return unavailable(error);
      }
      const knownIds = new Set(architecture.nodes.map((node) => node.id));
      const relatedNodeIds = answer.relatedNodeIds.filter((id) => knownIds.has(id));
      if (!answer.patch) {
        return {
          status: 200,
          body: {
            answer: answer.answer,
            patch: null,
            applied: false,
            version: architecture.version,
            relatedNodeIds,
          },
        };
      }
      let applied: AppliedPatch;
      try {
        applied = applyPatch(architecture, answer.patch);
      } catch (error) {
        return {
          status: 400,
          body: {
            error: {
              code: "invalid_patch",
              message: error instanceof Error ? error.message : "patch rejected",
              details: { answer: answer.answer },
            },
          },
        };
      }
      if (!answer.autoApply) {
        return {
          status: 200,
          body: {
            answer: answer.answer,
            patch: answer.patch,
            applied: false,
            version: architecture.version,
            relatedNodeIds,
          },
        };
      }
      try {
        const saved = saveVersion(projectId, applied.structure, "model/chat");
        publish(projectId, { type: "architecture.updated", version: saved.version });
        return {
          status: 200,
          body: {
            answer: answer.answer,
            patch: answer.patch,
            applied: true,
            version: saved.version,
            relatedNodeIds,
          },
        };
      } catch (error) {
        return {
          status: 500,
          body: {
            error: {
              code: "redaction_failed",
              message: error instanceof Error ? error.message : "content dropped",
            },
          },
        };
      }
    },

    applyPatch(projectId, patch) {
      const project = getProject(db, projectId);
      if (!project) {
        return { status: 404, body: { error: { code: "not_found", message: "unknown project" } } };
      }
      let architecture: Architecture | null;
      try {
        architecture = currentArchitecture(projectId);
      } catch {
        return {
          status: 500,
          body: { error: { code: "architecture_unavailable", message: "stored data invalid" } },
        };
      }
      if (!architecture) {
        return {
          status: 400,
          body: { error: { code: "invalid_request", message: "generate the architecture first" } },
        };
      }
      let applied: AppliedPatch;
      try {
        applied = applyPatch(architecture, patch);
      } catch (error) {
        return {
          status: 400,
          body: {
            error: {
              code: "invalid_patch",
              message: error instanceof Error ? error.message : "patch rejected",
            },
          },
        };
      }
      try {
        const saved = saveVersion(projectId, applied.structure, "model/chat");
        publish(projectId, { type: "architecture.updated", version: saved.version });
        return {
          status: 200,
          body: { version: saved.version, droppedEdges: applied.droppedEdges },
        };
      } catch (error) {
        return {
          status: 500,
          body: {
            error: {
              code: "redaction_failed",
              message: error instanceof Error ? error.message : "content dropped",
            },
          },
        };
      }
    },

    undo(projectId) {
      const project = getProject(db, projectId);
      if (!project) {
        return { status: 404, body: { error: { code: "not_found", message: "unknown project" } } };
      }
      const latest = getLatestArchitectureVersion(db, projectId);
      if (!latest || latest.version <= 1) {
        return {
          status: 409,
          body: { error: { code: "nothing_to_undo", message: "no earlier version" } },
        };
      }
      let previous: Architecture;
      try {
        previous = currentArchitectureAt(projectId, latest.version - 1);
      } catch {
        return {
          status: 500,
          body: { error: { code: "architecture_unavailable", message: "stored data invalid" } },
        };
      }
      try {
        const saved = saveVersion(
          projectId,
          {
            groups: previous.groups,
            nodes: previous.nodes,
            edges: previous.edges,
          },
          "undo",
        );
        publish(projectId, { type: "architecture.updated", version: saved.version });
        return { status: 200, body: { version: saved.version } };
      } catch (error) {
        return {
          status: 500,
          body: {
            error: {
              code: "redaction_failed",
              message: error instanceof Error ? error.message : "content dropped",
            },
          },
        };
      }
    },
  };

  function currentArchitectureAt(projectId: string, version: number): Architecture {
    const row = getArchitectureVersion(db, projectId, version);
    if (!row) throw new ArchitecturePatchError("missing version");
    const parsed = ArchitectureSchema.safeParse(JSON.parse(row.payloadJson) as unknown);
    if (!parsed.success) throw new ArchitecturePatchError("stored architecture failed validation");
    return parsed.data;
  }
}
