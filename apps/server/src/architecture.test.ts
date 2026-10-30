import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Architecture, ArchitecturePatch } from "@echo/contracts";
import {
  type EchoDb,
  getLatestArchitectureVersion,
  insertArchitectureVersion,
  insertSnapshot,
  openEchoDb,
  replaceProjectCodeIndex,
  upsertProject,
  upsertSession,
} from "@echo/db";
import { describe, expect, test } from "vitest";
import {
  ArchitecturePatchError,
  applyPatch,
  computeEvidence,
  createArchitectureService,
  edgeCapFor,
  findTransitiveEdges,
  mergeRegenerate,
  trimEdgesToCap,
} from "./architecture";

const silentLog = { info: () => {}, error: () => {} };
const ENV = { META_API_KEY: "test-key", META_MODEL_ID: "test-model" } as NodeJS.ProcessEnv;
const OFF_ENV = { ...ENV, ECHO_MODEL: "off" } as NodeJS.ProcessEnv;

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

function seedDb(): { db: EchoDb; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "echo-arch-svc-"));
  const db = openEchoDb(join(dir, "echo.sqlite"));
  upsertProject(db, { id: "prj_1", root: join(dir, "repo"), name: "repo" });
  return { db, dir };
}

function seedSession(db: EchoDb, sessionId: string) {
  upsertSession(db, {
    id: sessionId,
    projectId: "prj_1",
    agent: "muse",
    model: null,
    directory: "/repo",
    title: null,
    startedAt: "2026-10-28T10:00:00.000Z",
    tapePath: `/tmp/${sessionId}.jsonl`,
    captureQuality: "full",
  });
}

function seedCodeIndex(db: EchoDb) {
  replaceProjectCodeIndex(db, "prj_1", {
    files: [
      {
        file: { path: "src/a.ts", language: "ts", size: 10, sha256: "aaa", parsed: true },
        symbols: [],
        edges: [],
      },
    ],
    state: {
      filesHash: "hash1",
      fileCount: 1,
      symbolCount: 0,
      edgeCount: 0,
      stackJson: "{}",
      indexedAt: "2026-10-29T00:00:00.000Z",
      parser: "test",
    },
  });
}

function archFixture(): Architecture {
  return {
    version: 1,
    generatedAt: "2026-10-29T00:00:00.000Z",
    groups: [
      { id: "capture", label: "Capture" },
      { id: "storage", label: "Storage" },
    ],
    nodes: [
      {
        id: "reader",
        label: "Native reader",
        group: "capture",
        description: "Tails logs.",
        paths: ["packages/capture-*/**"],
        status: "existing",
      },
      {
        id: "tape",
        label: "Tape store",
        group: "storage",
        description: "Event log.",
        paths: ["packages/tape/**"],
        status: "existing",
      },
    ],
    edges: [{ from: "reader", to: "tape" }],
  };
}

function saveFixture(db: EchoDb, arch: Architecture = archFixture()) {
  insertArchitectureVersion(db, {
    projectId: "prj_1",
    version: arch.version,
    payloadJson: JSON.stringify(arch),
    generator: "test",
  });
}

describe("applyPatch", () => {
  test("applies a mixed valid patch", () => {
    const patch: ArchitecturePatch = [
      { op: "addGroup", group: { id: "serving", label: "Serving" } },
      {
        op: "addNode",
        node: {
          id: "cache",
          label: "Answer cache",
          group: "serving",
          description: "Caches answers.",
          paths: ["apps/server/src/cache/**"],
          status: "proposed",
        },
      },
      { op: "addEdge", edge: { from: "tape", to: "cache" } },
      { op: "updateNode", id: "cache", patch: { label: "Result cache" } },
    ];
    const { structure, droppedEdges } = applyPatch(archFixture(), patch);
    expect(droppedEdges).toEqual([]);
    expect(structure.groups.map((group) => group.id)).toContain("serving");
    expect(structure.nodes.find((node) => node.id === "cache")?.label).toBe("Result cache");
    expect(structure.edges).toContainEqual({ from: "tape", to: "cache" });
  });

  test("removeNode drops attached edges and reports them", () => {
    const { structure, droppedEdges } = applyPatch(archFixture(), [
      { op: "removeNode", id: "reader" },
    ]);
    expect(structure.nodes.map((node) => node.id)).toEqual(["tape"]);
    expect(structure.edges).toEqual([]);
    expect(droppedEdges).toEqual([{ from: "reader", to: "tape" }]);
  });

  test("addEdge on an existing pair updates the label", () => {
    const { structure } = applyPatch(archFixture(), [
      { op: "addEdge", edge: { from: "reader", to: "tape", label: "appends" } },
    ]);
    expect(structure.edges).toEqual([{ from: "reader", to: "tape", label: "appends" }]);
  });

  test("addEdge on an existing pair updates bidirectional when set", () => {
    const { structure } = applyPatch(archFixture(), [
      { op: "addEdge", edge: { from: "reader", to: "tape", bidirectional: true } },
    ]);
    expect(structure.edges).toEqual([{ from: "reader", to: "tape", bidirectional: true }]);
  });

  test("addEdge reversing an existing pair merges into one bidirectional edge", () => {
    const { structure, droppedEdges } = applyPatch(archFixture(), [
      { op: "addEdge", edge: { from: "tape", to: "reader", label: "reads" } },
    ]);
    expect(droppedEdges).toEqual([]);
    expect(structure.edges).toEqual([{ from: "reader", to: "tape", bidirectional: true }]);
  });

  test.each([
    ["duplicate node", [{ op: "addNode", node: { ...archFixture().nodes[0] } }]],
    [
      "unknown group for new node",
      [
        {
          op: "addNode",
          node: { ...archFixture().nodes[0], id: "new", group: "ghost" },
        },
      ],
    ],
    ["duplicate group", [{ op: "addGroup", group: { id: "capture", label: "Other" } }]],
    ["update missing node", [{ op: "updateNode", id: "ghost", patch: { label: "X" } }]],
    ["remove missing node", [{ op: "removeNode", id: "ghost" }]],
    ["edge from missing node", [{ op: "addEdge", edge: { from: "ghost", to: "tape" } }]],
    ["edge to missing node", [{ op: "addEdge", edge: { from: "reader", to: "ghost" } }]],
    ["remove missing edge", [{ op: "removeEdge", from: "tape", to: "reader" }]],
    ["update to unknown group", [{ op: "updateNode", id: "reader", patch: { group: "ghost" } }]],
    [
      "patch emptying the graph",
      [
        { op: "removeNode", id: "reader" },
        { op: "removeNode", id: "tape" },
      ],
    ],
  ])(`rejects %s`, (_label, patch) => {
    expect(() => applyPatch(archFixture(), patch as ArchitecturePatch)).toThrow(
      ArchitecturePatchError,
    );
  });
});

describe("mergeRegenerate", () => {
  test("preserves proposed nodes, their groups and surviving edges", () => {
    const current = archFixture();
    current.groups.push({ id: "serving", label: "Serving" });
    current.nodes.push({
      id: "cache",
      label: "Answer cache",
      group: "serving",
      description: "Caches answers.",
      paths: ["apps/server/src/cache/**"],
      status: "proposed",
    });
    current.edges.push({ from: "tape", to: "cache" });
    current.edges.push({ from: "cache", to: "reader" });

    const fresh = archFixture();
    fresh.nodes = fresh.nodes.filter((node) => node.id === "tape");
    fresh.edges = [];
    const merged = mergeRegenerate(current, fresh);

    expect(merged.nodes.map((node) => node.id).sort()).toEqual(["cache", "tape"]);
    expect(merged.nodes.find((node) => node.id === "cache")?.status).toBe("proposed");
    expect(merged.groups.map((group) => group.id)).toContain("serving");
    expect(merged.edges).toEqual([{ from: "tape", to: "cache" }]);
  });

  test("a regenerated node with a proposed id graduates to existing", () => {
    const current = archFixture();
    current.nodes.push({
      id: "cache",
      label: "Answer cache",
      group: "storage",
      description: "Caches answers.",
      paths: [],
      status: "proposed",
    });
    const fresh = archFixture();
    fresh.nodes.push({
      id: "cache",
      label: "Answer cache",
      group: "storage",
      description: "Found in code.",
      paths: ["apps/server/src/cache.ts"],
      status: "existing",
    });
    const merged = mergeRegenerate(current, fresh);
    expect(merged.nodes.filter((node) => node.id === "cache")).toHaveLength(1);
    expect(merged.nodes.find((node) => node.id === "cache")?.status).toBe("existing");
  });
});

describe("edgeCapFor", () => {
  test("scales at ~1.3 edges per node, rounded up", () => {
    expect(edgeCapFor(1)).toBe(2);
    expect(edgeCapFor(8)).toBe(11);
    expect(edgeCapFor(10)).toBe(13);
    expect(edgeCapFor(12)).toBe(16);
    expect(edgeCapFor(15)).toBe(20);
  });
});

describe("findTransitiveEdges", () => {
  test("flags the shortcut in a triangle, keeps the path", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "c" },
    ];
    expect(findTransitiveEdges(edges)).toEqual([2]);
  });

  test("flags only the full-span edge in a diamond", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
      { from: "a", to: "d" },
    ];
    expect(findTransitiveEdges(edges)).toEqual([4]);
  });

  test("keeps cycles, forks, and lone self-loops", () => {
    expect(
      findTransitiveEdges([
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ]),
    ).toEqual([]);
    expect(
      findTransitiveEdges([
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ]),
    ).toEqual([]);
    expect(findTransitiveEdges([{ from: "a", to: "a" }])).toEqual([]);
  });

  test("keeps a self-loop even when a return cycle exists", () => {
    expect(
      findTransitiveEdges([
        { from: "a", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ]),
    ).toEqual([]);
  });
});

describe("trimEdgesToCap", () => {
  test("leaves an under-cap graph untouched", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    const trimmed = trimEdgesToCap(edges, 4);
    expect(trimmed.edges).toEqual(edges);
    expect(trimmed.droppedDuplicates).toBe(0);
    expect(trimmed.droppedTransitive).toBe(0);
    expect(trimmed.droppedOverflow).toBe(0);
  });

  test("drops duplicates and transitive edges before the cap bites", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "c" },
    ];
    const trimmed = trimEdgesToCap(edges, 4);
    expect(trimmed.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    expect(trimmed.droppedDuplicates).toBe(1);
    expect(trimmed.droppedTransitive).toBe(1);
    expect(trimmed.droppedOverflow).toBe(0);
  });

  test("keeps the head when still over after transitive removal", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
      { from: "a", to: "d" },
    ];
    const trimmed = trimEdgesToCap(edges, 2);
    expect(trimmed.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    expect(trimmed.droppedTransitive).toBe(0);
    expect(trimmed.droppedOverflow).toBe(2);
  });
});

describe("computeEvidence", () => {
  test("unions sessions across globs with the latest touch", () => {
    const evidence = computeEvidence(
      [
        { id: "reader", paths: ["packages/capture-*/**", "apps/cli/**"] },
        { id: "tape", paths: ["packages/tape/**"] },
        { id: "empty", paths: [] },
        { id: "bad", paths: ["["] },
      ],
      [
        {
          sessionId: "s1",
          path: "packages/capture-muse/index.ts",
          takenAt: "2026-10-28T10:00:00Z",
        },
        { sessionId: "s1", path: "apps/cli/main.ts", takenAt: "2026-10-28T11:00:00Z" },
        { sessionId: "s2", path: "packages/tape/writer.ts", takenAt: "2026-10-28T12:00:00Z" },
        { sessionId: "s2", path: "unrelated/x.ts", takenAt: "2026-10-28T13:00:00Z" },
      ],
      3,
    );
    expect(evidence.reader).toEqual({
      sessions: 1,
      totalSessions: 3,
      lastTouched: "2026-10-28T11:00:00Z",
    });
    expect(evidence.tape).toEqual({
      sessions: 1,
      totalSessions: 3,
      lastTouched: "2026-10-28T12:00:00Z",
    });
    expect(evidence.empty).toEqual({ sessions: 0, totalSessions: 3, lastTouched: null });
    expect(evidence.bad).toEqual({ sessions: 0, totalSessions: 3, lastTouched: null });
  });
});

function graphFixture(nodeIds: string[], edges: Array<[string, string]>) {
  return {
    groups: [{ id: "core", label: "Core", order: 0 }],
    nodes: nodeIds.map((id) => ({
      id,
      label: `Node ${id}`,
      group: "core",
      description: "Does things.",
      paths: ["src/**"],
      status: "existing",
    })),
    edges: edges.map(([from, to]) => ({ from, to })),
  };
}

function seedRepo(dir: string): void {
  mkdirSync(join(dir, "repo"), { recursive: true });
  writeFileSync(join(dir, "repo", "README.md"), "# Test repo");
}

describe("service", () => {
  test("get: 404, empty state, and evidence", () => {
    const { db } = seedDb();
    try {
      const service = createArchitectureService({ db, log: silentLog }, { env: ENV });
      expect(service.get("missing").status).toBe(404);
      const empty = service.get("prj_1");
      expect(empty.status).toBe(200);
      expect((empty.body as { architecture: unknown }).architecture).toBeNull();

      saveFixture(db);
      seedSession(db, "s1");
      seedSession(db, "s2");
      const file = (path: string) => ({
        path,
        mode: null,
        blobOid: null,
        size: null,
        sha256: null,
        captured: true,
        reason: null,
      });
      insertSnapshot(db, {
        id: "snap_1",
        sessionId: "s1",
        commitOid: "a",
        parentOid: null,
        trigger: "final",
        eventId: null,
        takenAt: "2026-10-28T10:00:00.000Z",
        fileCount: 1,
        totalBytes: 1,
        status: "ok",
        diagnostics: [],
        files: [file("packages/capture-muse/a.ts")],
      });
      const full = service.get("prj_1");
      const body = full.body as {
        architecture: Architecture;
        evidence: Record<string, { sessions: number; totalSessions: number }>;
      };
      expect(body.architecture.version).toBe(1);
      expect(body.evidence.reader).toMatchObject({ sessions: 1, totalSessions: 2 });
      expect(body.evidence.tape).toMatchObject({ sessions: 0, totalSessions: 2 });
    } finally {
      db.close();
    }
  });

  test("chat: guards and model-off with zero calls", async () => {
    const { db } = seedDb();
    try {
      const throwing = () => {
        throw new Error("must not call the model");
      };
      const service = createArchitectureService(
        { db, log: silentLog },
        { env: ENV, fetchImpl: throwing as typeof fetch },
      );
      expect((await service.chat("missing", "hi", null)).status).toBe(404);
      expect((await service.chat("prj_1", "hi", null)).status).toBe(400);
      saveFixture(db);
      expect((await service.chat("prj_1", "hi", "ghost")).status).toBe(400);

      const off = createArchitectureService(
        { db, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwing as typeof fetch },
      );
      const refused = await off.chat("prj_1", "hi", null);
      expect(refused.status).toBe(503);
    } finally {
      db.close();
    }
  });

  test("chat auto-apply saves a version and broadcasts; ambiguous does not", async () => {
    const { db } = seedDb();
    try {
      const patch: ArchitecturePatch = [
        {
          op: "addNode",
          node: {
            id: "cache",
            label: "Answer cache",
            group: "storage",
            description: "Caches answers.",
            paths: [],
            status: "proposed",
          },
        },
      ];
      const maybePatch: ArchitecturePatch = [
        {
          op: "addNode",
          node: {
            id: "queue",
            label: "Retry queue",
            group: "storage",
            description: "Retries writes.",
            paths: [],
            status: "proposed",
          },
        },
      ];
      const { fetchImpl } = stubFetchQueue([
        { answer: "Added.", patch, autoApply: true, relatedNodeIds: ["tape", "ghost"] },
        { answer: "Maybe.", patch: maybePatch, autoApply: false, relatedNodeIds: [] },
      ]);
      const service = createArchitectureService({ db, log: silentLog }, { env: ENV, fetchImpl });
      saveFixture(db);
      const seen: Array<{ type: string; version?: number }> = [];
      service.subscribe("prj_1", (event) => {
        seen.push(event);
      });

      const applied = await service.chat("prj_1", "add a cache", "tape");
      expect(applied.status).toBe(200);
      const appliedBody = applied.body as {
        applied: boolean;
        version: number;
        relatedNodeIds: string[];
      };
      expect(appliedBody.applied).toBe(true);
      expect(appliedBody.version).toBe(2);
      expect(appliedBody.relatedNodeIds).toEqual(["tape"]);
      expect(getLatestArchitectureVersion(db, "prj_1")?.version).toBe(2);
      expect(seen).toContainEqual({ type: "architecture.updated", version: 2 });

      const held = await service.chat("prj_1", "maybe add it", null);
      const heldBody = held.body as { applied: boolean; version: number; patch: unknown };
      expect(heldBody.applied).toBe(false);
      expect(heldBody.version).toBe(2);
      expect(heldBody.patch).toEqual(maybePatch);
      expect(getLatestArchitectureVersion(db, "prj_1")?.version).toBe(2);
    } finally {
      db.close();
    }
  });

  test("chat rejects an invalid patch with the answer attached", async () => {
    const { db } = seedDb();
    try {
      const { fetchImpl } = stubFetchQueue([
        {
          answer: "Broken.",
          patch: [{ op: "removeNode", id: "ghost" }],
          autoApply: true,
          relatedNodeIds: [],
        },
      ]);
      const service = createArchitectureService({ db, log: silentLog }, { env: ENV, fetchImpl });
      saveFixture(db);
      const outcome = await service.chat("prj_1", "remove it", null);
      expect(outcome.status).toBe(400);
      const body = outcome.body as {
        error: { code: string; details: { answer: string } };
      };
      expect(body.error.code).toBe("invalid_patch");
      expect(body.error.details.answer).toBe("Broken.");
      expect(getLatestArchitectureVersion(db, "prj_1")?.version).toBe(1);
    } finally {
      db.close();
    }
  });

  test("apply saves explicitly; undo restores the previous version", () => {
    const { db } = seedDb();
    try {
      const service = createArchitectureService({ db, log: silentLog }, { env: ENV });
      expect(service.undo("missing").status).toBe(404);
      saveFixture(db);
      expect(service.undo("prj_1").status).toBe(409);

      const bad = service.applyPatch("prj_1", [{ op: "removeNode", id: "ghost" }]);
      expect(bad.status).toBe(400);

      const good = service.applyPatch("prj_1", [
        { op: "updateNode", id: "tape", patch: { label: "Tape log" } },
      ]);
      expect(good.status).toBe(200);
      expect(getLatestArchitectureVersion(db, "prj_1")?.version).toBe(2);

      const undone = service.undo("prj_1");
      expect(undone.status).toBe(200);
      const latest = getLatestArchitectureVersion(db, "prj_1");
      expect(latest?.version).toBe(3);
      const restored = JSON.parse(latest?.payloadJson ?? "{}") as Architecture;
      expect(restored.nodes.find((node) => node.id === "tape")?.label).toBe("Tape store");
      expect(restored.version).toBe(3);
    } finally {
      db.close();
    }
  });

  test("generate runs inline and preserves proposed nodes on regenerate", async () => {
    const { db, dir } = seedDb();
    try {
      mkdirSync(join(dir, "repo"), { recursive: true });
      writeFileSync(join(dir, "repo", "README.md"), "# Test repo");
      seedCodeIndex(db);
      const fresh = {
        groups: [{ id: "core", label: "Core" }],
        nodes: [
          {
            id: "main",
            label: "Main loop",
            group: "core",
            description: "Runs things.",
            paths: ["src/**"],
            status: "existing",
          },
        ],
        edges: [],
      };
      const { fetchImpl } = stubFetchQueue([fresh, fresh]);
      const service = createArchitectureService(
        { db, log: silentLog },
        { env: ENV, fetchImpl, background: false },
      );
      const first = await service.generate("prj_1");
      expect(first.status).toBe(200);
      service.applyPatch("prj_1", [
        {
          op: "addNode",
          node: {
            id: "cache",
            label: "Answer cache",
            group: "core",
            description: "Caches answers.",
            paths: [],
            status: "proposed",
          },
        },
      ]);
      const second = await service.generate("prj_1");
      expect(second.status).toBe(200);
      const latest = getLatestArchitectureVersion(db, "prj_1");
      const merged = JSON.parse(latest?.payloadJson ?? "{}") as Architecture;
      expect(merged.nodes.map((node) => node.id).sort()).toEqual(["cache", "main"]);
      expect(merged.nodes.find((node) => node.id === "cache")?.status).toBe("proposed");
    } finally {
      db.close();
    }
  });

  test("generate streams progress events in background mode", async () => {
    const { db, dir } = seedDb();
    try {
      mkdirSync(join(dir, "repo"), { recursive: true });
      seedCodeIndex(db);
      const fresh = {
        groups: [{ id: "core", label: "Core" }],
        nodes: [
          {
            id: "main",
            label: "Main loop",
            group: "core",
            description: "Runs things.",
            paths: ["src/**"],
            status: "existing",
          },
        ],
        edges: [],
      };
      const { fetchImpl } = stubFetchQueue([fresh]);
      const service = createArchitectureService({ db, log: silentLog }, { env: ENV, fetchImpl });
      const events: Array<{ type: string }> = [];
      const done = new Promise<void>((resolve) => {
        service.subscribe("prj_1", (event) => {
          events.push(event);
          if (event.type === "generation.done") resolve();
        });
      });
      const outcome = service.generate("prj_1");
      expect((outcome as { status: number }).status).toBe(202);
      await done;
      expect(events.map((event) => event.type)).toContain("generation.progress");
      expect(events).toContainEqual({ type: "generation.done", version: 1, warnings: [] });
      expect(events).toContainEqual({ type: "architecture.updated", version: 1 });
    } finally {
      db.close();
    }
  });

  test("generate repairs an over-cap draft once and saves the repair", async () => {
    const { db, dir } = seedDb();
    try {
      seedRepo(dir);
      seedCodeIndex(db);
      // Acyclic: 4 nodes cap at 6 but a DAG on 4 nodes holds at most 6,
      // so over-cap drafts need 5 nodes (cap 7).
      const over = graphFixture(
        ["a", "b", "c", "d", "e"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "d"],
          ["d", "e"],
          ["a", "c"],
          ["a", "d"],
          ["a", "e"],
          ["b", "d"],
          ["b", "e"],
        ],
      );
      // Plain path: 4 edges, acyclic, none transitive, under the cap.
      const repaired = graphFixture(
        ["a", "b", "c", "d", "e"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "d"],
          ["d", "e"],
        ],
      );
      const { fetchImpl, calls } = stubFetchQueue([over, repaired]);
      const service = createArchitectureService(
        { db, log: silentLog },
        { env: ENV, fetchImpl, background: false },
      );
      const outcome = await service.generate("prj_1");
      expect(outcome.status).toBe(200);
      expect(calls()).toBe(2);
      expect(outcome.body).toEqual({ version: 1, warnings: [] });
      const latest = getLatestArchitectureVersion(db, "prj_1");
      const saved = JSON.parse(latest?.payloadJson ?? "{}") as Architecture;
      expect(saved.edges).toHaveLength(4);
    } finally {
      db.close();
    }
  });

  test("generate trims with a warning when the repair still exceeds the cap", async () => {
    const { db, dir } = seedDb();
    try {
      seedRepo(dir);
      seedCodeIndex(db);
      const over = graphFixture(
        ["a", "b", "c", "d", "e"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "d"],
          ["d", "e"],
          ["a", "c"],
          ["a", "d"],
          ["a", "e"],
          ["b", "d"],
          ["b", "e"],
        ],
      );
      const stillOver = graphFixture(
        ["a", "b", "c", "d", "e"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "d"],
          ["d", "e"],
          ["a", "c"],
          ["a", "d"],
          ["a", "e"],
          ["b", "e"],
        ],
      );
      const { fetchImpl, calls } = stubFetchQueue([over, stillOver]);
      const service = createArchitectureService(
        { db, log: silentLog },
        { env: ENV, fetchImpl, background: false },
      );
      const outcome = await service.generate("prj_1");
      expect(outcome.status).toBe(200);
      expect(calls()).toBe(2);
      const body = outcome.body as { version: number; warnings: string[] };
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0]).toMatch(/kept \d+ of 8 edges \(cap 7 for 5 nodes\)/);
      const latest = getLatestArchitectureVersion(db, "prj_1");
      const saved = JSON.parse(latest?.payloadJson ?? "{}") as Architecture;
      expect(saved.edges.length).toBeLessThanOrEqual(7);
      expect(saved.edges.length).toBeLessThan(8);
      for (const edge of saved.edges) {
        expect(stillOver.edges).toContainEqual(edge);
      }
      expect(findTransitiveEdges(saved.edges)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("generate trims the fresh draft when the repair is invalid", async () => {
    const { db, dir } = seedDb();
    try {
      seedRepo(dir);
      seedCodeIndex(db);
      const over = graphFixture(
        ["a", "b", "c", "d", "e"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "d"],
          ["d", "e"],
          ["a", "c"],
          ["a", "d"],
          ["a", "e"],
          ["b", "d"],
          ["b", "e"],
        ],
      );
      const { fetchImpl, calls } = stubFetchQueue([over, "NOT-AN-ARCHITECTURE"]);
      const service = createArchitectureService(
        { db, log: silentLog },
        { env: ENV, fetchImpl, background: false },
      );
      const outcome = await service.generate("prj_1");
      expect(outcome.status).toBe(200);
      expect(calls()).toBe(2);
      const body = outcome.body as { version: number; warnings: string[] };
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0]).toMatch(/kept \d+ of 9 edges \(cap 7 for 5 nodes\)/);
      const latest = getLatestArchitectureVersion(db, "prj_1");
      const saved = JSON.parse(latest?.payloadJson ?? "{}") as Architecture;
      expect(saved.edges.length).toBeLessThanOrEqual(7);
      expect(saved.edges.length).toBeLessThan(9);
      expect(findTransitiveEdges(saved.edges)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("generate streams trim warnings on generation.done", async () => {
    const { db, dir } = seedDb();
    try {
      mkdirSync(join(dir, "repo"), { recursive: true });
      seedCodeIndex(db);
      const over = graphFixture(
        ["a", "b"],
        [
          ["a", "b"],
          ["a", "b"],
          ["a", "b"],
          ["a", "b"],
        ],
      );
      const { fetchImpl } = stubFetchQueue([over, over]);
      const service = createArchitectureService({ db, log: silentLog }, { env: ENV, fetchImpl });
      const events: Array<{ type: string }> = [];
      const done = new Promise<void>((resolve) => {
        service.subscribe("prj_1", (event) => {
          events.push(event);
          if (event.type === "generation.done") resolve();
        });
      });
      const outcome = service.generate("prj_1");
      expect((outcome as { status: number }).status).toBe(202);
      await done;
      const doneEvent = events.find((event) => event.type === "generation.done") as unknown as {
        version: number;
        warnings: string[];
      };
      expect(doneEvent.version).toBe(1);
      expect(doneEvent.warnings).toHaveLength(1);
      expect(doneEvent.warnings[0]).toMatch(
        /kept 1 of 4 edges \(cap 3 for 2 nodes\); dropped 3 duplicates/,
      );
    } finally {
      db.close();
    }
  });

  test("generate merges an opposite pair with an acyclic warning, no repair", async () => {
    const { db, dir } = seedDb();
    try {
      seedRepo(dir);
      seedCodeIndex(db);
      const fresh = graphFixture(
        ["a", "b", "c", "d"],
        [
          ["a", "b"],
          ["b", "a"],
          ["c", "d"],
        ],
      );
      const { fetchImpl, calls } = stubFetchQueue([fresh]);
      const service = createArchitectureService(
        { db, log: silentLog },
        { env: ENV, fetchImpl, background: false },
      );
      const outcome = await service.generate("prj_1");
      expect(outcome.status).toBe(200);
      expect(calls()).toBe(1);
      const body = outcome.body as { version: number; warnings: string[] };
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0]).toMatch(
        /kept the graph acyclic \(merged 1 opposite pair into bidirectional edges\)/,
      );
      const latest = getLatestArchitectureVersion(db, "prj_1");
      const saved = JSON.parse(latest?.payloadJson ?? "{}") as Architecture;
      expect(saved.edges).toEqual([
        { from: "a", to: "b", bidirectional: true },
        { from: "c", to: "d" },
      ]);
    } finally {
      db.close();
    }
  });

  test("generate trims after carrying proposed parts over the cap", async () => {
    const { db, dir } = seedDb();
    try {
      seedRepo(dir);
      seedCodeIndex(db);
      insertArchitectureVersion(db, {
        projectId: "prj_1",
        version: 1,
        payloadJson: JSON.stringify({
          version: 1,
          generatedAt: "2026-10-29T00:00:00.000Z",
          groups: [{ id: "core", label: "Core", order: 0 }],
          nodes: ["a", "b", "c", "d"]
            .map((id) => ({
              id,
              label: `Node ${id}`,
              group: "core",
              description: "Does things.",
              paths: ["src/**"],
              status: "existing",
            }))
            .concat(
              ["p", "q"].map((id) => ({
                id,
                label: `Node ${id}`,
                group: "core",
                description: "Does things.",
                paths: [],
                status: "proposed",
              })),
            ),
          // Proposed cross edges only: every carried edge touches p or q, so
          // all five survive the merge.
          edges: [
            { from: "p", to: "c" },
            { from: "p", to: "d" },
            { from: "a", to: "q" },
            { from: "b", to: "q" },
            { from: "p", to: "q" },
          ],
        }),
        generator: "test",
      });
      // K_{2,2} across {a,b} -> {c,d}: acyclic, nothing transitive.
      const fresh = graphFixture(
        ["a", "b", "c", "d"],
        [
          ["a", "c"],
          ["a", "d"],
          ["b", "c"],
          ["b", "d"],
        ],
      );
      const { fetchImpl } = stubFetchQueue([fresh]);
      const service = createArchitectureService(
        { db, log: silentLog },
        { env: ENV, fetchImpl, background: false },
      );
      const outcome = await service.generate("prj_1");
      expect(outcome.status).toBe(200);
      const body = outcome.body as { version: number; warnings: string[] };
      // Fresh is under cap (4 edges, cap 6, nothing transitive): no fresh
      // warning. Merged is a 9-edge K_{3,3} across {a,b,p} -> {c,d,q} over an
      // 8 cap with no length-2 path anywhere (nothing transitive): the
      // carried-over tail edge drops with a warning.
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0]).toMatch(/kept 8 of 9 edges \(cap 8 for 6 nodes\)/);
      const latest = getLatestArchitectureVersion(db, "prj_1");
      const saved = JSON.parse(latest?.payloadJson ?? "{}") as Architecture;
      expect(saved.edges).toHaveLength(8);
      expect(saved.edges).not.toContainEqual({ from: "p", to: "q" });
    } finally {
      db.close();
    }
  });
});
