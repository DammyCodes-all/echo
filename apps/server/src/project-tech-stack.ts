import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ProjectTechStack,
  type ProjectTechStackItem,
  type ProjectTechStackKind,
  ProjectTechStackSchema,
} from "@echo/contracts";
import {
  type EchoDb,
  getCodeIndexState,
  getProject,
  getProjectArtifactRef,
  getStackRegenState,
  listExternalModules,
  type ProjectSummary,
  saveStackRegenState,
  upsertProjectArtifactRef,
} from "@echo/db";
import { type ChatMessage, type ModelConfig, modelConfigFromEnv, requestJson } from "@echo/model";
import { redactJson } from "@echo/redaction";

export type TechStackOutcomeKind =
  | "fresh"
  | "stale"
  | "generated"
  | "skeleton"
  | "unavailable"
  | "unknown_project"
  | "index_missing";

export interface TechStackOutcome {
  outcome: TechStackOutcomeKind;
  stack: ProjectTechStack | null;
}

interface StackServiceDeps {
  db: EchoDb;
  dataDir: string;
  log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

interface StackServiceOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  redactJsonImpl?: typeof redactJson;
  clock?: () => Date;
  /** Rebuild the code index when missing/stale; sync no-op when fresh. */
  ensureIndex?: (projectId: string) => void;
  /** Serve the previous artifact and regenerate in the background (default
   *  true). False regenerates inline — deterministic, for tests. */
  backgroundRegen?: boolean;
}

const TECH_STACK_KIND = "tech-stack";
const MAX_ITEMS = 8;
const MAX_README_CHARS = 1500;
const MAX_PACKAGE_DESCRIPTION_CHARS = 500;
// Regen gate: only rewrite the summary/stack after this many code-index
// changes AND this much age on the current artifact. Every save moves the
// files hash, so an ungated watermark regenerates (and bills a model call)
// on each keystroke; the gate batches that churn.
export const STACK_REGEN_MIN_CHANGES = 3;
export const STACK_REGEN_MIN_INTERVAL_MS = 10 * 60 * 1000;

const LANGUAGE_DISPLAY: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
};

export interface DetectedSignals {
  frameworks: string[];
  languages: Array<{ language: string; files: number }>;
  modules: Array<{ module: string; fileCount: number }>;
}

/** Genuinely helpful repo-authored context for the purpose/stack draft. */
export interface RepoDocs {
  readmeExcerpt: string | null;
  packageDescription: string | null;
}

/** Bounded, best-effort read of repo-authored docs. Missing or unreadable
 *  files are not a signal — never an error, never fabricated. */
export function readRepoDocs(root: string): RepoDocs {
  let readmeExcerpt: string | null = null;
  for (const name of ["README.md", "readme.md"]) {
    try {
      const text = readFileSync(join(root, name), "utf8").trim();
      if (text.length > 0) {
        readmeExcerpt = text.slice(0, MAX_README_CHARS);
        break;
      }
    } catch {
      // Missing or unreadable README: no docs signal.
    }
  }
  let packageDescription: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      description?: unknown;
    };
    if (typeof pkg.description === "string" && pkg.description.trim().length > 0) {
      packageDescription = pkg.description.trim().slice(0, MAX_PACKAGE_DESCRIPTION_CHARS);
    }
  } catch {
    // Not a node repo, or unreadable: no docs signal.
  }
  return { readmeExcerpt, packageDescription };
}

function parseStackSummary(raw: string): {
  frameworks: string[];
  languages: Record<string, number>;
} {
  try {
    const value = JSON.parse(raw) as {
      frameworks?: unknown;
      languages?: unknown;
    };
    const frameworks = Array.isArray(value.frameworks)
      ? value.frameworks.filter((f): f is string => typeof f === "string")
      : [];
    const languages: Record<string, number> = {};
    if (value.languages !== null && typeof value.languages === "object") {
      for (const [key, count] of Object.entries(value.languages as Record<string, unknown>)) {
        if (typeof count === "number" && Number.isFinite(count) && count > 0)
          languages[key] = count;
      }
    }
    return { frameworks, languages };
  } catch {
    return { frameworks: [], languages: {} };
  }
}

/** Canonical form for matching model-proposed names against detected signals. */
export function normalizeStackName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function moduleSignalNames(module: string): string[] {
  const names = [normalizeStackName(module)];
  const last = module.split("/").pop();
  if (last && last !== module) names.push(normalizeStackName(last));
  return names;
}

function allowedSignalNames(signals: DetectedSignals): Set<string> {
  const allowed = new Set<string>();
  for (const framework of signals.frameworks) allowed.add(normalizeStackName(framework));
  for (const { language } of signals.languages) {
    allowed.add(normalizeStackName(language));
    const display = LANGUAGE_DISPLAY[language];
    if (display) allowed.add(normalizeStackName(display));
  }
  for (const { module } of signals.modules) {
    for (const name of moduleSignalNames(module)) allowed.add(name);
  }
  return allowed;
}

function nameMatchesSignals(name: string, allowed: Set<string>): boolean {
  const n = normalizeStackName(name);
  if (n.length === 0) return false;
  if (allowed.has(n)) return true;
  // Short display names ("Next.js" vs the "next" package) still trace to a
  // detected signal via prefix match; exact match only for tiny names.
  if (n.length < 4) return false;
  for (const candidate of allowed) {
    if (candidate.length >= 4 && (candidate.startsWith(n) || n.startsWith(candidate))) return true;
  }
  return false;
}

/** Drop invented stack: every item must trace to a detected signal. */
export function curateStackItems(
  proposed: ProjectTechStackItem[],
  signals: DetectedSignals,
): ProjectTechStackItem[] {
  const allowed = allowedSignalNames(signals);
  const seen = new Set<string>();
  const items: ProjectTechStackItem[] = [];
  for (const item of proposed) {
    const key = normalizeStackName(item.name);
    if (seen.has(key) || !nameMatchesSignals(item.name, allowed)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export function computeStackWatermark(input: {
  filesHash: string;
  stackJson: string;
  modules: Array<{ module: string; fileCount: number }>;
}): string {
  return createHash("sha256")
    .update([input.filesHash, input.stackJson, JSON.stringify(input.modules)].join("\n"))
    .digest("hex");
}

function basename(path: string): string {
  const parts = path.split(/[/\\]+/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

export function buildSkeletonStack(input: {
  project: ProjectSummary;
  signals: DetectedSignals;
  generatedAt: string;
}): ProjectTechStack {
  const base = input.project.name ?? basename(input.project.root);
  const seen = new Set<string>();
  const items: ProjectTechStackItem[] = [];
  const push = (name: string, kind: ProjectTechStackKind) => {
    const key = normalizeStackName(name);
    if (seen.has(key) || items.length >= MAX_ITEMS) return;
    seen.add(key);
    items.push({ name, kind });
  };
  for (const framework of input.signals.frameworks) {
    push(framework, normalizeStackName(framework) === "typescript" ? "language" : "framework");
  }
  for (const { language } of input.signals.languages) {
    const display = LANGUAGE_DISPLAY[language];
    if (display) push(display, "language");
  }
  for (const { module } of input.signals.modules) {
    const last = module.split("/").pop() ?? module;
    push(last.startsWith("@") ? module : last, "framework");
  }
  // Skeleton stays honest and plain: just the codebase name. The tech
  // names live in items, and the model writes the real outcome line.
  return {
    projectId: input.project.id,
    purpose: `${base} codebase`,
    items,
    generator: "skeleton",
    generatedAt: input.generatedAt,
  };
}

function stackArtifactPath(dataDir: string, projectId: string): string {
  return join(dataDir, "projects", projectId, "tech-stack.json");
}

const STACK_PROMPT_VERSION = "stack-v1";

export function createProjectTechStackService(
  deps: StackServiceDeps,
  options: StackServiceOptions = {},
) {
  const { db, dataDir, log } = deps;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const redactJsonImpl = options.redactJsonImpl ?? redactJson;
  const clock = options.clock ?? (() => new Date());
  const ensureIndex = options.ensureIndex;

  function modelOff(): boolean {
    return env.ECHO_MODEL === "off";
  }

  function persistStack(input: {
    projectId: string;
    stack: ProjectTechStack;
    generator: string;
    watermark: string;
  }): boolean {
    let scanned: unknown;
    try {
      scanned = redactJsonImpl(input.stack).value;
    } catch (error) {
      log.error({ project_id: input.projectId, err: String(error) }, "tech stack redaction failed");
      return false;
    }
    const stack = ProjectTechStackSchema.parse(scanned);
    const path = stackArtifactPath(dataDir, input.projectId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(stack, null, 2)}\n`);
    upsertProjectArtifactRef(db, {
      projectId: input.projectId,
      kind: TECH_STACK_KIND,
      path,
      watermark: input.watermark,
      generator: input.generator,
      generatedAt: stack.generatedAt,
    });
    return true;
  }

  async function narrate(
    config: ModelConfig,
    project: ProjectSummary,
    signals: DetectedSignals,
    docs: RepoDocs,
  ): Promise<ProjectTechStack | null> {
    const languages = signals.languages
      .map(({ language, files }) => `${LANGUAGE_DISPLAY[language] ?? language} (${files} files)`)
      .join(", ");
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You describe a code repository for a project sidebar.",
          'Return ONLY JSON: {"purpose": string, "items": [{"name": string, "kind": "language"|"framework"|"build"|"data"|"infra"}]}.',
          "Rules: at most 8 items, most significant first; merge duplicates (react + react-dom = React);",
          "drop one-off mentions and transitive-only noise; every name MUST come from the SIGNALS below, never invent;",
          "purpose is one plain-words line (<=140 chars) saying what someone GETS from this repo — the outcome, not the mechanism;",
          "no jargon in purpose: no stack names, no acronyms, no words like calibrate/snapshot/tape/artifact/pipeline;",
          "use the REPO DOCS below to ground the purpose in what the repo claims to do; never copy stack names into purpose;",
          "bad: 'TypeScript-first capture with local daemon persistence';",
          "good: 'A workspace that turns coding sessions into short stories you can review.'",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Project: ${project.name ?? basename(project.root)}`,
          `Languages: ${languages || "none detected"}`,
          `Detected frameworks/tools: ${signals.frameworks.join(", ") || "none"}`,
          `Most imported external modules: ${signals.modules.map((m) => `${m.module} (${m.fileCount})`).join(", ") || "none"}`,
          ...(docs.packageDescription
            ? [`Repo description (package.json): ${docs.packageDescription}`]
            : []),
          ...(docs.readmeExcerpt ? [`README excerpt:\n${docs.readmeExcerpt}`] : []),
        ].join("\n"),
      },
    ];
    const redacted = redactJsonImpl(messages).value as ChatMessage[];
    const retryMaxTokens = Math.max(config.maxTokens * 2, 8000);
    const reasoningEffort = env.META_REASONING_EFFORT ?? "low";
    try {
      const { value } = await requestJson(
        config,
        redacted,
        (unparsed: unknown) =>
          ProjectTechStackSchema.omit({
            projectId: true,
            generator: true,
            generatedAt: true,
          }).parse(unparsed),
        { fetchImpl, retryMaxTokens, reasoningEffort },
      );
      const items = curateStackItems(value.items, signals);
      if (items.length === 0 && signals.frameworks.length + signals.languages.length > 0)
        return null;
      return {
        projectId: project.id,
        purpose: value.purpose,
        items,
        generator: "model",
        generatedAt: clock().toISOString(),
      };
    } catch {
      return null;
    }
  }

  const backgroundRegen = options.backgroundRegen ?? true;
  const inflight = new Map<string, Promise<void>>();

  function syncRegenBaseline(projectId: string, filesHash: string): void {
    const prev = getStackRegenState(db, projectId);
    if (!prev || prev.lastFilesHash !== filesHash || prev.pendingChanges !== 0) {
      saveStackRegenState(db, { projectId, lastFilesHash: filesHash, pendingChanges: 0 });
    }
  }

  function noteIndexChange(projectId: string, filesHash: string): number {
    const prev = getStackRegenState(db, projectId) ?? { lastFilesHash: "", pendingChanges: 0 };
    const next =
      prev.lastFilesHash === filesHash
        ? prev
        : {
            lastFilesHash: filesHash,
            pendingChanges: prev.pendingChanges + 1,
          };
    if (next !== prev) {
      saveStackRegenState(db, { projectId, ...next });
    }
    return next.pendingChanges;
  }

  function backOff(projectId: string, filesHash: string): void {
    // A failed regen must not retry on every visit: baseline the current
    // hash so only genuinely new changes re-arm the gate.
    saveStackRegenState(db, { projectId, lastFilesHash: filesHash, pendingChanges: 0 });
  }

  function persistFresh(input: {
    projectId: string;
    stack: ProjectTechStack;
    generator: string;
    watermark: string;
    filesHash: string;
  }): boolean {
    if (
      !persistStack({
        projectId: input.projectId,
        stack: input.stack,
        generator: input.generator,
        watermark: input.watermark,
      })
    ) {
      return false;
    }
    saveStackRegenState(db, {
      projectId: input.projectId,
      lastFilesHash: input.filesHash,
      pendingChanges: 0,
    });
    return true;
  }

  // Model pipeline shared by first-gen, blocking regen and background regen.
  // Returns null when there is nothing worth persisting (model off, draft
  // rejected, persist failed) — the caller decides between skeleton (first
  // view, nothing to show) and stale (keep the previous artifact).
  async function draftFresh(input: {
    project: ProjectSummary;
    signals: DetectedSignals;
    filesHash: string;
    watermark: string;
    generatedAt: string;
  }): Promise<ProjectTechStack | null> {
    if (modelOff()) return null;
    let config: ModelConfig;
    try {
      config = modelConfigFromEnv(env);
    } catch {
      return null;
    }
    const draft = await narrate(
      config,
      input.project,
      input.signals,
      readRepoDocs(input.project.root),
    );
    if (!draft) return null;
    if (
      !persistFresh({
        projectId: input.project.id,
        stack: draft,
        generator: config.model,
        watermark: input.watermark,
        filesHash: input.filesHash,
      })
    ) {
      return null;
    }
    return draft;
  }

  function kickBackgroundRegen(input: {
    project: ProjectSummary;
    signals: DetectedSignals;
    filesHash: string;
    watermark: string;
  }): void {
    if (inflight.has(input.project.id)) return;
    const run = (async (): Promise<void> => {
      try {
        const fresh = await draftFresh({
          ...input,
          generatedAt: clock().toISOString(),
        });
        if (!fresh) backOff(input.project.id, input.filesHash);
      } catch (error) {
        log.error(
          { project_id: input.project.id, err: String(error) },
          "tech stack background regen failed",
        );
        backOff(input.project.id, input.filesHash);
      }
    })();
    inflight.set(input.project.id, run);
    void run.finally(() => {
      if (inflight.get(input.project.id) === run) inflight.delete(input.project.id);
    });
  }

  function readCachedStack(projectId: string): {
    ref: { path: string; watermark: string; generatedAt: string };
    stack: ProjectTechStack;
  } | null {
    const ref = getProjectArtifactRef(db, projectId, TECH_STACK_KIND);
    if (!ref || !existsSync(ref.path)) return null;
    try {
      const stack = ProjectTechStackSchema.parse(
        JSON.parse(readFileSync(ref.path, "utf8")) as unknown,
      );
      return { ref, stack };
    } catch {
      return null;
    }
  }

  async function maybeGetTechStack(projectId: string): Promise<TechStackOutcome> {
    const project = getProject(db, projectId);
    if (!project) return { outcome: "unknown_project", stack: null };
    // First view backfills: indexing is a local tree walk and a no-op when
    // the stored hash still matches, so existing projects "just work".
    if (ensureIndex) {
      try {
        ensureIndex(projectId);
      } catch {
        return { outcome: "index_missing", stack: null };
      }
    }
    const state = getCodeIndexState(db, projectId);
    if (!state) return { outcome: "index_missing", stack: null };

    const summary = parseStackSummary(state.stackJson);
    const languages = Object.entries(summary.languages)
      .map(([language, files]) => ({ language, files }))
      .sort((a, b) => b.files - a.files);
    const modules = listExternalModules(db, projectId).slice(0, 30);
    const signals: DetectedSignals = { frameworks: summary.frameworks, languages, modules };
    const watermark = computeStackWatermark({
      filesHash: state.filesHash,
      stackJson: state.stackJson,
      modules,
    });

    const existing = readCachedStack(projectId);
    if (existing && existing.ref.watermark === watermark) {
      syncRegenBaseline(projectId, state.filesHash);
      return { outcome: "fresh", stack: existing.stack };
    }

    const generatedAt = clock().toISOString();
    if (!existing) {
      // First view: nothing to show yet, so generate inline. Skeleton is
      // the honest fallback — it only ever appears when no artifact exists.
      const writeSkeleton = (): TechStackOutcome => {
        const stack = buildSkeletonStack({ project, signals, generatedAt });
        if (
          !persistFresh({
            projectId,
            stack,
            generator: `${STACK_PROMPT_VERSION}-skeleton`,
            watermark,
            filesHash: state.filesHash,
          })
        ) {
          return { outcome: "unavailable", stack: null };
        }
        log.info({ project_id: projectId }, "tech stack skeleton");
        return { outcome: "skeleton", stack };
      };

      const fresh = await draftFresh({
        project,
        signals,
        filesHash: state.filesHash,
        watermark,
        generatedAt,
      });
      if (fresh) return { outcome: "generated", stack: fresh };
      return writeSkeleton();
    }

    // Stale-while-revalidate: the previous artifact stays visible while the
    // gate decides. Regen only after enough detected changes AND enough age.
    const pending = noteIndexChange(projectId, state.filesHash);
    const ageMs = clock().getTime() - Date.parse(existing.ref.generatedAt);
    const ageDue = !Number.isFinite(ageMs) || ageMs >= STACK_REGEN_MIN_INTERVAL_MS;
    if (pending < STACK_REGEN_MIN_CHANGES || !ageDue) {
      return { outcome: "stale", stack: existing.stack };
    }
    if (backgroundRegen) {
      kickBackgroundRegen({ project, signals, filesHash: state.filesHash, watermark });
      return { outcome: "stale", stack: existing.stack };
    }
    const fresh = await draftFresh({
      project,
      signals,
      filesHash: state.filesHash,
      watermark,
      generatedAt,
    });
    if (fresh) return { outcome: "generated", stack: fresh };
    return { outcome: "stale", stack: existing.stack };
  }

  return { maybeGetTechStack };
}
