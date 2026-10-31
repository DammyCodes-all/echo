import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANGE_MODEL_GENERATOR } from "@echo/chapters";
import { ChangeSchema } from "@echo/contracts";
import { type EchoDb, insertSnapshot, openEchoDb, upsertProject, upsertSession } from "@echo/db";
import type { SnapshotResult } from "@echo/snapshots";
import { snapshotWorkingTree } from "@echo/snapshots";
import { describe, expect, it } from "vitest";
import { CHANGES_GENERATOR, createChangesService } from "./changes";

const TAKEN_AT = new Date("2026-10-28T10:00:00.000Z");
const silentLog = { info: () => {}, error: () => {} };
// Ambient-proof envs: ECHO_MODEL/META_API_KEY survive via spread in other
// suites, so these pin the exact branch under test.
const OFF_ENV = { ...process.env, ECHO_MODEL: "off" } as NodeJS.ProcessEnv;
const MODEL_ENV = {
  ...process.env,
  ECHO_MODEL: "",
  META_API_KEY: "test-key",
  META_MODEL_ID: "test-model",
} as NodeJS.ProcessEnv;
const KEYLESS_ENV = { ...process.env, ECHO_MODEL: "", META_API_KEY: "" } as NodeJS.ProcessEnv;
const throwingFetch = (() => {
  throw new Error("network used");
}) as unknown as typeof fetch;

function stubFetchSequence(answers: unknown[]) {
  let calls = 0;
  const bodies: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ""));
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls, bodies: () => bodies };
}

function failingFetch() {
  let calls = 0;
  // HTTP 500 (not a rejection): the client's IPv4 fallback only retries
  // transport rejections, so this is exactly one call with a model error.
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("err", { status: 500 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function validDraft(paths: string[]) {
  return {
    title: "Add project notes file",
    summary:
      "This change adds the project notes file. The new lines now carry the updated content for review.",
    before: ["Before this change, the notes file held the earlier form."],
    now: ["Now the file carries the updated version in place."],
    howItWorks: [
      "Change notes.txt: add the new lines.",
      "Keep the surrounding content as is.",
      "Review the new lines only.",
    ],
    headsUp: [],
    files: paths.map((path) => ({ path, note: `Change ${path}: updated.` })),
    digest: Array.from({ length: 60 }, (_, i) => `token${i}`).join(" "),
  };
}

async function takeSnapshot(input: {
  dataDir: string;
  root: string;
  sessionId: string;
  projectId: string;
  trigger: "baseline" | "final";
  eventId: string;
}): Promise<SnapshotResult> {
  return snapshotWorkingTree({
    shadowDir: join(input.dataDir, "projects", input.projectId, "shadow.git"),
    root: input.root,
    dataDir: input.dataDir,
    sessionId: input.sessionId,
    projectId: input.projectId,
    trigger: input.trigger,
    eventId: input.eventId,
    takenAt: TAKEN_AT,
  });
}

function insertRow(db: EchoDb, sessionId: string, snapshot: SnapshotResult, eventId: string): void {
  insertSnapshot(db, {
    id: snapshot.commitOid,
    sessionId,
    commitOid: snapshot.commitOid,
    parentOid: snapshot.parentOid,
    trigger: snapshot.trigger,
    eventId,
    takenAt: snapshot.takenAt,
    fileCount: snapshot.fileCount,
    totalBytes: snapshot.totalBytes,
    status: snapshot.status,
    diagnostics: snapshot.diagnostics,
    files: snapshot.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      blobOid: file.blobOid,
      size: file.size,
      sha256: file.sha256,
      captured: file.captured,
      reason: file.reason,
    })),
  });
}

async function seedTwoSnapshots(): Promise<{
  db: EchoDb;
  dataDir: string;
  projectId: string;
  sessionId: string;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-changes-narr-"));
  const root = mkdtempSync(join(tmpdir(), "echo-changes-narr-root-"));
  const projectId = "prj_changes_narr";
  const sessionId = "ses_changes_narr";
  writeFileSync(join(root, "notes.txt"), "a\n");
  const baseline = await takeSnapshot({
    dataDir,
    root,
    sessionId,
    projectId,
    trigger: "baseline",
    eventId: "evt_base",
  });
  writeFileSync(join(root, "notes.txt"), "a\nb\nc\nd\n");
  const final = await takeSnapshot({
    dataDir,
    root,
    sessionId,
    projectId,
    trigger: "final",
    eventId: "evt_final",
  });
  const db = openEchoDb(join(dataDir, "echo.sqlite"));
  upsertProject(db, { id: projectId, root, name: "changes-narration" });
  upsertSession(db, {
    id: sessionId,
    projectId,
    agent: "opencode",
    model: null,
    directory: root,
    title: "changes-narration",
    startedAt: TAKEN_AT.toISOString(),
    tapePath: join(dataDir, "tape.jsonl"),
    captureQuality: "partial",
  });
  insertRow(db, sessionId, baseline, "evt_base");
  insertRow(db, sessionId, final, "evt_final");
  return { db, dataDir, projectId, sessionId };
}

describe("changes model narration", () => {
  it("uses skeletons with zero model calls when ECHO_MODEL=off", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwingFetch },
      );
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      expect(first.artifact?.generator).toBe(CHANGES_GENERATOR);
      expect(first.artifact?.diagnostics).not.toContain("changes_model_fallback");
      for (const change of first.artifact?.changes ?? []) {
        expect(ChangeSchema.parse(change)).toEqual(change);
      }
    } finally {
      db.close();
    }
  });

  it("stays silent and offline when keyless", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const service = createChangesService(
        { db, dataDir, log: silentLog },
        { env: KEYLESS_ENV, fetchImpl: throwingFetch },
      );
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      expect(first.artifact?.generator).toBe(CHANGES_GENERATOR);
      expect(first.artifact?.diagnostics).not.toContain("changes_model_fallback");
    } finally {
      db.close();
    }
  });

  it("narrates with the model and stamps server-owned identity", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const draft = validDraft(["notes.txt"]);
      const { fetchImpl, calls, bodies } = stubFetchSequence([draft]);
      const service = createChangesService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      expect(calls()).toBe(1);
      expect(first.artifact?.generator).toBe(CHANGE_MODEL_GENERATOR);
      expect(first.artifact?.diagnostics).not.toContain("changes_model_fallback");
      const change = first.artifact?.changes[0];
      expect(change?.title).toBe(draft.title);
      expect(change?.digest).toBe(draft.digest);
      expect(change?.files).toEqual(draft.files);
      expect(ChangeSchema.parse(change)).toEqual(change);
      // Prompt scoping: diff plus moment prompts plus earlier digests only.
      expect(bodies()[0]).toContain("=== notes.txt ===");
      expect(bodies()[0]).toContain("(no earlier digests yet)");
      expect(bodies()[0]).not.toContain(draft.digest);
      // Summary still comes from digests only.
      expect(first.artifact?.summary).toContain("reviewed change");
    } finally {
      db.close();
    }
  });

  it("retries once with error text then stores the narrated change", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const bad = {
        ...validDraft(["notes.txt"]),
        title: "one two three four five six seven eight nine",
      };
      const good = validDraft(["notes.txt"]);
      const { fetchImpl, calls, bodies } = stubFetchSequence([bad, good]);
      const service = createChangesService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      expect(calls()).toBe(2);
      expect(first.artifact?.generator).toBe(CHANGE_MODEL_GENERATOR);
      expect(first.artifact?.changes[0]?.title).toBe(good.title);
      expect(bodies()[1]).toContain("failed these checks");
      expect(bodies()[1]).toContain("title must be 1-8 words");
    } finally {
      db.close();
    }
  });

  it("falls back to the skeleton after two invalid drafts", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const bad = {
        ...validDraft(["notes.txt"]),
        title: "one two three four five six seven eight nine",
      };
      const { fetchImpl, calls } = stubFetchSequence([bad, bad]);
      const service = createChangesService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      expect(calls()).toBe(2);
      expect(first.artifact?.generator).toBe(CHANGES_GENERATOR);
      expect(first.artifact?.diagnostics).toContain("changes_model_fallback");
      const change = first.artifact?.changes[0];
      expect(ChangeSchema.parse(change)).toEqual(change);
    } finally {
      db.close();
    }
  });

  it("falls back to the skeleton when the model call throws", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const { fetchImpl, calls } = failingFetch();
      const service = createChangesService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      expect(calls()).toBe(1);
      expect(first.artifact?.generator).toBe(CHANGES_GENERATOR);
      expect(first.artifact?.diagnostics).toContain("changes_model_fallback");
    } finally {
      db.close();
    }
  });

  it("closes generation when the redaction gate fails", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const { fetchImpl } = stubFetchSequence([validDraft(["notes.txt"])]);
      const service = createChangesService(
        { db, dataDir, log: silentLog },
        {
          env: MODEL_ENV,
          fetchImpl,
          redactJsonImpl: () => {
            throw new Error("nope");
          },
        },
      );
      const first = await service.maybeGenerateChanges(sessionId);
      expect(first).toEqual({ outcome: "unavailable", artifact: null });
    } finally {
      db.close();
    }
  });

  it("fills skeleton rows with prose in place, progress untouched", async () => {
    const { db, dataDir, sessionId } = await seedTwoSnapshots();
    try {
      const skeletonService = createChangesService(
        { db, dataDir, log: silentLog },
        { env: OFF_ENV, fetchImpl: throwingFetch },
      );
      const first = await skeletonService.maybeGenerateChanges(sessionId);
      expect(first.outcome).toBe("generated");
      const skeleton = first.artifact?.changes[0];
      if (!skeleton) throw new Error("expected a skeleton change");
      expect(skeleton.origin ?? "skeleton").toBe("skeleton");
      const recorded = skeletonService.recordProgress(sessionId, {
        changeId: skeleton.id,
        version: skeleton.version,
        state: "understood",
      });
      expect(recorded.status).toBe(200);

      const draft = validDraft(["notes.txt"]);
      const { fetchImpl, calls } = stubFetchSequence([draft]);
      const modelService = createChangesService(
        { db, dataDir, log: silentLog },
        { env: MODEL_ENV, fetchImpl },
      );
      const second = await modelService.maybeGenerateChanges(sessionId);
      expect(second.outcome).toBe("generated");
      expect(calls()).toBeGreaterThan(0);
      const filled = second.artifact?.changes.find((change) => change.id === skeleton.id);
      expect(filled?.version).toBe(skeleton.version);
      expect(filled?.origin).toBe("model");
      expect(filled?.title).toBe(draft.title);
      expect(second.artifact?.changes.every((change) => ChangeSchema.parse(change))).toBe(true);
      // Same id/version: the understood mark survives the prose upgrade.
      const progress = modelService.recordProgress(sessionId, {
        changeId: skeleton.id,
        version: skeleton.version,
        state: "viewed",
      });
      expect(progress.status).toBe(200);
    } finally {
      db.close();
    }
  });
});
