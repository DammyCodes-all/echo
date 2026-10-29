import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EchoDb } from "@echo/db";
import {
  getProjectArtifactRef,
  openEchoDb,
  replaceProjectCodeIndex,
  upsertProject,
} from "@echo/db";
import { describe, expect, it } from "vitest";
import {
  buildSkeletonStack,
  createProjectTechStackService,
  curateStackItems,
  type DetectedSignals,
} from "./project-tech-stack";

const PROJECT_ID = "prj_stack";
const ISO = "2026-10-29T00:00:00.000Z";
const OFF_ENV = { ...process.env, ECHO_MODEL: "off" } as NodeJS.ProcessEnv;
const MODEL_ENV = {
  ...process.env,
  META_API_KEY: "test-key",
  META_MODEL_ID: "test-model",
} as NodeJS.ProcessEnv;
const silentLog = { info: () => {}, error: () => {} };

function seedDb(): { db: EchoDb; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-stack-data-"));
  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  upsertProject(db, { id: PROJECT_ID, root: "/repo/echo", name: "echo" });
  return { db, dataDir };
}

function seedIndex(db: EchoDb, filesHash = "hash1"): void {
  replaceProjectCodeIndex(db, PROJECT_ID, {
    files: [
      {
        file: { path: "src/app.tsx", language: "tsx", size: 10, sha256: "aaa", parsed: true },
        symbols: [],
        edges: [
          {
            fromFile: "src/app.tsx",
            toFile: null,
            externalModule: "react",
            kind: "imports",
            names: [],
            resolved: true,
          },
          {
            fromFile: "src/app.tsx",
            toFile: null,
            externalModule: "vite",
            kind: "imports",
            names: [],
            resolved: true,
          },
        ],
      },
      {
        file: { path: "src/api.ts", language: "ts", size: 8, sha256: "bbb", parsed: true },
        symbols: [],
        edges: [],
      },
    ],
    state: {
      filesHash,
      fileCount: 2,
      symbolCount: 0,
      edgeCount: 2,
      stackJson: JSON.stringify({
        frameworks: ["React", "Vite", "TypeScript"],
        languages: { tsx: 1, ts: 1 },
        fileCount: 2,
      }),
      indexedAt: ISO,
      parser: "test",
    },
  });
}

function stubFetchQueue(replies: unknown[]) {
  let calls = 0;
  const fetchImpl = (async () => {
    const reply = replies[Math.min(calls, replies.length - 1)];
    calls += 1;
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const SIGNALS: DetectedSignals = {
  frameworks: ["React", "Next.js"],
  languages: [{ language: "tsx", files: 4 }],
  modules: [{ module: "next", fileCount: 4 }],
};

describe("project tech stack", () => {
  it("reports unknown projects without touching the model", () => {
    const { db, dataDir } = seedDb();
    try {
      const service = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV },
      );
      const throwing = (() => {
        throw new Error("network used");
      }) as unknown as typeof fetch;
      const netService = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl: throwing },
      );
      return netService.maybeGetTechStack("prj_missing").then((outcome) => {
        expect(outcome.outcome).toBe("unknown_project");
        expect(outcome.stack).toBeNull();
      });
    } finally {
      db.close();
    }
  });

  it("reports a missing code index without generating", () => {
    const { db, dataDir } = seedDb();
    try {
      const service = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV },
      );
      return service.maybeGetTechStack(PROJECT_ID).then((outcome) => {
        expect(outcome.outcome).toBe("index_missing");
        expect(outcome.stack).toBeNull();
      });
    } finally {
      db.close();
    }
  });

  it("writes a deterministic skeleton with the model off, then serves it fresh", async () => {
    const { db, dataDir } = seedDb();
    try {
      seedIndex(db);
      const service = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV },
      );
      const first = await service.maybeGetTechStack(PROJECT_ID);
      expect(first.outcome).toBe("skeleton");
      expect(first.stack?.generator).toBe("skeleton");
      expect(first.stack?.purpose).toContain("echo");
      expect(first.stack?.items.map((item) => item.name)).toEqual(
        expect.arrayContaining(["React", "TypeScript"]),
      );
      const ref = getProjectArtifactRef(db, PROJECT_ID, "tech-stack");
      expect(ref?.watermark).toMatch(/^[0-9a-f]{64}$/);
      const second = await service.maybeGetTechStack(PROJECT_ID);
      expect(second.outcome).toBe("fresh");
      expect(second.stack).toEqual(first.stack);
    } finally {
      db.close();
    }
  });

  it("generates with the model and drops invented stack", async () => {
    const { db, dataDir } = seedDb();
    try {
      seedIndex(db);
      const { fetchImpl, calls } = stubFetchQueue([
        {
          purpose: "Agent workspace for code review.",
          items: [
            { name: "React", kind: "framework" },
            { name: "react", kind: "framework" },
            { name: "CobolOS", kind: "framework" },
            { name: "Vite", kind: "build" },
            { name: "TypeScript", kind: "language" },
          ],
        },
      ]);
      const service = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const outcome = await service.maybeGetTechStack(PROJECT_ID);
      expect(outcome.outcome).toBe("generated");
      expect(calls()).toBe(1);
      const names = outcome.stack?.items.map((item) => item.name) ?? [];
      expect(names).toContain("React");
      expect(names).toContain("Vite");
      expect(names).not.toContain("CobolOS");
      expect(names.filter((name) => name.toLowerCase() === "react")).toHaveLength(1);
      expect(outcome.stack?.purpose).toBe("Agent workspace for code review.");
    } finally {
      db.close();
    }
  });

  it("regenerates when the code index watermark moves", async () => {
    const { db, dataDir } = seedDb();
    try {
      seedIndex(db, "hash1");
      const service = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV },
      );
      expect((await service.maybeGetTechStack(PROJECT_ID)).outcome).toBe("skeleton");
      seedIndex(db, "hash2");
      const next = await service.maybeGetTechStack(PROJECT_ID);
      expect(next.outcome).toBe("skeleton");
      expect(getProjectArtifactRef(db, PROJECT_ID, "tech-stack")?.watermark).not.toBeNull();
      expect((await service.maybeGetTechStack(PROJECT_ID)).outcome).toBe("fresh");
    } finally {
      db.close();
    }
  });

  it("matches display names to package signals by prefix", () => {
    const items = curateStackItems(
      [
        { name: "Next.js", kind: "framework" },
        { name: "Go", kind: "language" },
      ],
      SIGNALS,
    );
    expect(items.map((item) => item.name)).toEqual(["Next.js"]);
  });

  it("skeleton falls back to an honest empty shape without signals", () => {
    const stack = buildSkeletonStack({
      project: {
        id: PROJECT_ID,
        root: "/repo/empty",
        remoteUrl: null,
        name: null,
        sessionCount: 0,
        lastActivity: null,
      },
      signals: { frameworks: [], languages: [], modules: [] },
      generatedAt: ISO,
    });
    expect(stack.items).toEqual([]);
    expect(stack.purpose).toContain("empty");
  });
});
