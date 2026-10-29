import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CodeLanguage } from "@echo/contracts";
import { type WalkResult, walkWorkingTree } from "@echo/snapshots";

export const MAX_INDEX_FILES = 20_000;
export const MAX_INDEX_FILE_BYTES = 1_000_000;

export interface InventoryFile {
  path: string;
  language: CodeLanguage;
  size: number;
  sha256: string;
}

export interface InventorySkip {
  path: string;
  reason: string;
}

export interface RepoInventory {
  files: InventoryFile[];
  filesHash: string;
  skipped: InventorySkip[];
  truncated: boolean;
}

export interface WalkInput {
  walk: WalkResult;
  readFile: (absPath: string) => Buffer;
}

const EXTENSION_LANGUAGE: Record<string, CodeLanguage> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "mjs",
  ".cjs": "cjs",
  ".mts": "ts",
  ".cts": "cjs",
  ".json": "json",
  ".md": "md",
  ".mdx": "md",
};

export function languageForPath(path: string): CodeLanguage {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "other";
  return EXTENSION_LANGUAGE[path.slice(dot).toLowerCase()] ?? "other";
}

function isBinarySample(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Pure inventory builder over an injected walk: hashing, language, caps. */
export function buildInventory(input: WalkInput): RepoInventory {
  const files: InventoryFile[] = [];
  const skipped: InventorySkip[] = [];
  let truncated = false;
  const candidates = [...input.walk.files]
    .filter((file) => !file.symlink)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of input.walk.metadata) {
    skipped.push({ path: file.path, reason: "not-captured" });
  }
  for (const file of candidates) {
    if (files.length >= MAX_INDEX_FILES) {
      truncated = true;
      break;
    }
    if (file.size > MAX_INDEX_FILE_BYTES) {
      skipped.push({ path: file.path, reason: "oversized" });
      continue;
    }
    let buffer: Buffer;
    try {
      buffer = input.readFile(file.absPath);
    } catch {
      skipped.push({ path: file.path, reason: "unreadable" });
      continue;
    }
    if (isBinarySample(buffer)) {
      skipped.push({ path: file.path, reason: "binary" });
      continue;
    }
    files.push({
      path: file.path,
      language: languageForPath(file.path),
      size: buffer.byteLength,
      sha256: sha256Hex(buffer),
    });
  }
  const filesHash = createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.sha256}\n`).join(""))
    .digest("hex");
  return { files, filesHash, skipped, truncated };
}

/** Live inventory of a working tree, honoring .gitignore + snapshot ignores. */
export function inventoryRepo(root: string): RepoInventory {
  const walk = walkWorkingTree({ root });
  return buildInventory({ walk, readFile: (absPath) => readFileSync(absPath) });
}

const FRAMEWORK_MARKERS: Record<string, string> = {
  next: "Next.js",
  react: "React",
  vue: "Vue",
  svelte: "Svelte",
  express: "Express",
  fastify: "Fastify",
  hono: "Hono",
  "drizzle-orm": "Drizzle",
  prisma: "@prisma/client",
  "better-auth": "Better Auth",
  tailwindcss: "Tailwind",
  vite: "Vite",
  vitest: "Vitest",
  typescript: "TypeScript",
};

export interface StackSummary {
  frameworks: string[];
  languages: Partial<Record<CodeLanguage, number>>;
  fileCount: number;
}

/** Best-effort stack detection from inventory + package.json contents. */
export function detectStack(inventory: RepoInventory, packageJsonBodies: string[]): StackSummary {
  const languages: Partial<Record<CodeLanguage, number>> = {};
  for (const file of inventory.files) {
    languages[file.language] = (languages[file.language] ?? 0) + 1;
  }
  const frameworks = new Set<string>();
  for (const body of packageJsonBodies) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const deps = {
      ...((parsed as Record<string, unknown>).dependencies as Record<string, string> | undefined),
      ...((parsed as Record<string, unknown>).devDependencies as
        | Record<string, string>
        | undefined),
    };
    for (const name of Object.keys(deps)) {
      // Scoped subpaths (e.g. next/font) still signal the framework.
      const base = name.startsWith("@") ? name : (name.split("/")[0] ?? name);
      const label = FRAMEWORK_MARKERS[base];
      if (label !== undefined) frameworks.add(label);
    }
  }
  return {
    frameworks: [...frameworks].sort(),
    languages,
    fileCount: inventory.files.length,
  };
}
