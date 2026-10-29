import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EchoDb } from "@echo/db";
import {
  getProjectArtifactRef,
  getStackRegenState,
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
  readRepoDocs,
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
      const _service = createProjectTechStackService(
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

  it("serves the previous skeleton as stale when the model is off", async () => {
    const { db, dataDir } = seedDb();
    try {
      seedIndex(db, "hash1");
      const service = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV },
      );
      const first = await service.maybeGetTechStack(PROJECT_ID);
      expect(first.outcome).toBe("skeleton");
      const ref = getProjectArtifactRef(db, PROJECT_ID, "tech-stack");
      expect(ref?.watermark).toMatch(/^[0-9a-f]{64}$/);
      // A moved watermark with the model off never rewrites: the previous
      // artifact stays visible instead of churning skeletons.
      seedIndex(db, "hash2");
      const next = await service.maybeGetTechStack(PROJECT_ID);
      expect(next.outcome).toBe("stale");
      expect(next.stack).toEqual(first.stack);
      expect(getProjectArtifactRef(db, PROJECT_ID, "tech-stack")?.watermark).toBe(ref?.watermark);
      expect(getStackRegenState(db, PROJECT_ID)?.pendingChanges).toBe(1);
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

describe("project tech stack repo docs", () => {
  it("returns nulls when docs are missing", () => {
    expect(readRepoDocs(join(tmpdir(), "echo-no-such-docs"))).toEqual({
      readmeExcerpt: null,
      packageDescription: null,
    });
  });

  it("bounds long READMEs and descriptions", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-docs-"));
    writeFileSync(join(root, "README.md"), `${"x".repeat(5000)}\n`);
    writeFileSync(join(root, "package.json"), JSON.stringify({ description: "y".repeat(900) }));
    const docs = readRepoDocs(root);
    expect(docs.readmeExcerpt).toHaveLength(1500);
    expect(docs.packageDescription).toHaveLength(500);
  });

  it("grounds the model prompt in README and package.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-docs-repo-"));
    writeFileSync(
      join(root, "README.md"),
      "# reviews\n\nTurns coding sessions into short stories you can review.\n",
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ description: "Agent review workspace" }),
    );
    const dataDir = mkdtempSync(join(tmpdir(), "echo-stack-docs-data-"));
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    try {
      upsertProject(db, { id: PROJECT_ID, root, name: "echo" });
      seedIndex(db);
      let capturedBody = "";
      const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
        capturedBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    purpose: "A workspace that turns coding sessions into short stories.",
                    items: [{ name: "React", kind: "framework" }],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch;
      const service = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const outcome = await service.maybeGetTechStack(PROJECT_ID);
      expect(outcome.outcome).toBe("generated");
      expect(capturedBody).toContain("Turns coding sessions into short stories");
      expect(capturedBody).toContain("Agent review workspace");
    } finally {
      db.close();
    }
  });
});

describe("project tech stack change gate", () => {
  const T0 = Date.parse("2026-10-29T00:00:00.000Z");

  function modelReply(purpose: string) {
    return {
      purpose,
      items: [{ name: "React", kind: "framework" }],
    };
  }

  function setup() {
    const { db, dataDir } = seedDb();
    let now = T0;
    const clock = () => new Date(now);
    const advance = (ms: number) => {
      now += ms;
    };
    return { db, dataDir, clock, advance };
  }

  async function waitForGeneratedAt(
    db: EchoDb,
    generatedAt: string,
    timeoutMs = 5000,
  ): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (getProjectArtifactRef(db, PROJECT_ID, "tech-stack")?.generatedAt === generatedAt) return;
      if (Date.now() - start > timeoutMs)
        throw new Error(`timed out waiting for tech-stack refresh to ${generatedAt}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("holds the previous stack until enough changes accumulate, then regenerates inline", async () => {
    const { db, dataDir, clock, advance } = setup();
    try {
      seedIndex(db, "hash1");
      const { fetchImpl, calls } = stubFetchQueue([modelReply("First purpose.")]);
      const service = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl, clock, backgroundRegen: false },
      );
      const first = await service.maybeGetTechStack(PROJECT_ID);
      expect(first.outcome).toBe("generated");
      advance(11 * 60 * 1000);
      // Changes 1 and 2: still stale, no new model call.
      seedIndex(db, "hash2");
      const stale1 = await service.maybeGetTechStack(PROJECT_ID);
      expect(stale1.outcome).toBe("stale");
      expect(stale1.stack).toEqual(first.stack);
      seedIndex(db, "hash3");
      expect((await service.maybeGetTechStack(PROJECT_ID)).outcome).toBe("stale");
      expect(calls()).toBe(1);
      // Third change trips the gate: inline regen.
      seedIndex(db, "hash4");
      const regen = await service.maybeGetTechStack(PROJECT_ID);
      expect(regen.outcome).toBe("generated");
      expect(regen.stack?.purpose).toBe("First purpose.");
      expect(calls()).toBe(2);
      expect(getStackRegenState(db, PROJECT_ID)?.pendingChanges).toBe(0);
      expect((await service.maybeGetTechStack(PROJECT_ID)).outcome).toBe("fresh");
    } finally {
      db.close();
    }
  });

  it("waits out the interval even when changes pile up", async () => {
    const { db, dataDir, clock } = setup();
    try {
      seedIndex(db, "hash1");
      const { fetchImpl, calls } = stubFetchQueue([modelReply("First purpose.")]);
      const service = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl, clock, backgroundRegen: false },
      );
      expect((await service.maybeGetTechStack(PROJECT_ID)).outcome).toBe("generated");
      // Three detected changes but no clock advance: every visit stays
      // stale and the model is never called again.
      for (const hash of ["hash2", "hash3", "hash4"] as const) {
        seedIndex(db, hash);
        const outcome = await service.maybeGetTechStack(PROJECT_ID);
        expect(outcome.outcome).toBe("stale");
      }
      expect(calls()).toBe(1);
      expect(getStackRegenState(db, PROJECT_ID)?.pendingChanges).toBe(3);
    } finally {
      db.close();
    }
  });

  it("serves stale immediately and refreshes in the background, once", async () => {
    const { db, dataDir, clock, advance } = setup();
    try {
      seedIndex(db, "hash1");
      const { fetchImpl, calls } = stubFetchQueue([
        modelReply("First purpose."),
        modelReply("Second purpose after changes."),
      ]);
      const service = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl, clock },
      );
      const first = await service.maybeGetTechStack(PROJECT_ID);
      expect(first.outcome).toBe("generated");
      advance(11 * 60 * 1000);
      seedIndex(db, "hash2");
      expect((await service.maybeGetTechStack(PROJECT_ID)).outcome).toBe("stale");
      seedIndex(db, "hash3");
      expect((await service.maybeGetTechStack(PROJECT_ID)).outcome).toBe("stale");
      // Two concurrent visits on the third change kick exactly one
      // background regen; both serve the previous stack immediately.
      seedIndex(db, "hash4");
      const [a, b] = await Promise.all([
        service.maybeGetTechStack(PROJECT_ID),
        service.maybeGetTechStack(PROJECT_ID),
      ]);
      expect(a.outcome).toBe("stale");
      expect(b.outcome).toBe("stale");
      expect(a.stack).toEqual(first.stack);
      await waitForGeneratedAt(db, new Date(T0 + 11 * 60 * 1000).toISOString());
      expect(calls()).toBe(2);
      const fresh = await service.maybeGetTechStack(PROJECT_ID);
      expect(fresh.outcome).toBe("fresh");
      expect(fresh.stack?.purpose).toBe("Second purpose after changes.");
    } finally {
      db.close();
    }
  });

  it("keeps the previous artifact when background regen fails", async () => {
    const { db, dataDir, clock, advance } = setup();
    try {
      seedIndex(db, "hash1");
      const good = stubFetchQueue([modelReply("Good purpose.")]);
      const firstService = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl: good.fetchImpl, clock },
      );
      const first = await firstService.maybeGetTechStack(PROJECT_ID);
      expect(first.outcome).toBe("generated");
      let attempts = 0;
      const throwing = (async () => {
        attempts += 1;
        throw new Error("model down");
      }) as unknown as typeof fetch;
      const failingService = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl: throwing, clock },
      );
      advance(11 * 60 * 1000);
      for (const hash of ["hash2", "hash3", "hash4"] as const) {
        seedIndex(db, hash);
        const outcome = await failingService.maybeGetTechStack(PROJECT_ID);
        expect(outcome.outcome).toBe("stale");
        expect(outcome.stack?.purpose).toBe("Good purpose.");
      }
      // Failure backs off instead of retrying every visit or writing a
      // skeleton over the good artifact.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(attempts).toBe(1);
      expect(getStackRegenState(db, PROJECT_ID)?.pendingChanges).toBe(0);
      const ref = getProjectArtifactRef(db, PROJECT_ID, "tech-stack");
      expect(ref?.generator).toBe("test-model");
      expect((await failingService.maybeGetTechStack(PROJECT_ID)).outcome).toBe("stale");
      expect(attempts).toBe(1);
    } finally {
      db.close();
    }
  });

  it("never downgrades an existing artifact to skeleton when the model is off", async () => {
    const { db, dataDir, clock, advance } = setup();
    try {
      seedIndex(db, "hash1");
      const good = stubFetchQueue([modelReply("Good purpose.")]);
      const modelService = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl: good.fetchImpl, clock },
      );
      expect((await modelService.maybeGetTechStack(PROJECT_ID)).outcome).toBe("generated");
      const offService = createProjectTechStackService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, clock },
      );
      advance(11 * 60 * 1000);
      for (const hash of ["hash2", "hash3", "hash4"] as const) {
        seedIndex(db, hash);
        const outcome = await offService.maybeGetTechStack(PROJECT_ID);
        expect(outcome.outcome).toBe("stale");
        expect(outcome.stack?.generator).toBe("model");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(getProjectArtifactRef(db, PROJECT_ID, "tech-stack")?.generator).toBe("test-model");
    } finally {
      db.close();
    }
  });
});
