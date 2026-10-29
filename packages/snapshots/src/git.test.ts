import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffShadowCommits, diffShadowTrees } from "./git";
import { snapshotWorkingTree } from "./snapshot";

const TAKEN_AT = new Date("2026-10-28T10:00:00.000Z");

function shadowCase() {
  const root = mkdtempSync(join(tmpdir(), "echo-shadow-trees-root-"));
  const dataDir = mkdtempSync(join(tmpdir(), "echo-shadow-trees-data-"));
  return { root, dataDir, shadowDir: join(dataDir, "projects", "prj_trees", "shadow.git") };
}

async function takeSnapshot(input: {
  dataDir: string;
  shadowDir: string;
  root: string;
  trigger: "baseline" | "final";
  eventId: string;
}) {
  return snapshotWorkingTree({
    shadowDir: input.shadowDir,
    root: input.root,
    dataDir: input.dataDir,
    sessionId: "ses_trees",
    projectId: "prj_trees",
    trigger: input.trigger,
    eventId: input.eventId,
    takenAt: TAKEN_AT,
  });
}

describe("diffShadowTrees", () => {
  it("matches the per-path diff byte-for-byte for a single-file change", async () => {
    const { root, dataDir, shadowDir } = shadowCase();
    try {
      writeFileSync(join(root, "a.txt"), "one\n");
      const first = await takeSnapshot({
        dataDir,
        shadowDir,
        root,
        trigger: "baseline",
        eventId: "evt_base",
      });
      writeFileSync(join(root, "a.txt"), "two longer\n");
      const second = await takeSnapshot({
        dataDir,
        shadowDir,
        root,
        trigger: "final",
        eventId: "evt_final",
      });

      expect(diffShadowTrees(shadowDir, first.commitOid, second.commitOid)).toBe(
        diffShadowCommits(shadowDir, first.commitOid, second.commitOid, "a.txt"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("covers every changed file in one call", async () => {
    const { root, dataDir, shadowDir } = shadowCase();
    try {
      writeFileSync(join(root, "a.txt"), "one\n");
      writeFileSync(join(root, "b.txt"), "uno\n");
      const first = await takeSnapshot({
        dataDir,
        shadowDir,
        root,
        trigger: "baseline",
        eventId: "evt_base",
      });
      writeFileSync(join(root, "a.txt"), "two\n");
      writeFileSync(join(root, "b.txt"), "dos\n");
      const second = await takeSnapshot({
        dataDir,
        shadowDir,
        root,
        trigger: "final",
        eventId: "evt_final",
      });

      const diff = diffShadowTrees(shadowDir, first.commitOid, second.commitOid);
      expect(diff).toContain("diff --git a/a.txt b/a.txt");
      expect(diff).toContain("diff --git a/b.txt b/b.txt");
      expect(diff).toContain("-one");
      expect(diff).toContain("+two");
      expect(diff).toContain("-uno");
      expect(diff).toContain("+dos");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reads a moved file as delete+add instead of a rename", async () => {
    const { root, dataDir, shadowDir } = shadowCase();
    try {
      writeFileSync(join(root, "old.txt"), "same\n");
      const first = await takeSnapshot({
        dataDir,
        shadowDir,
        root,
        trigger: "baseline",
        eventId: "evt_base",
      });
      rmSync(join(root, "old.txt"));
      writeFileSync(join(root, "new.txt"), "same\n");
      const second = await takeSnapshot({
        dataDir,
        shadowDir,
        root,
        trigger: "final",
        eventId: "evt_final",
      });

      const diff = diffShadowTrees(shadowDir, first.commitOid, second.commitOid);
      expect(diff).not.toContain("rename from");
      expect(diff).not.toContain("rename to");
      expect(diff).toContain("--- a/old.txt");
      expect(diff).toContain("+++ b/new.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects partial oids", async () => {
    const { shadowDir } = shadowCase();
    expect(() => diffShadowTrees(shadowDir, "abc", "0".repeat(40))).toThrow(
      "shadow diff needs two full commit oids",
    );
  });
});
