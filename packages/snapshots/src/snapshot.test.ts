import fs, {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { readShadowBlob } from "./git";
import { loadManifest } from "./manifest";
import { snapshotGitTree, snapshotWorkingTree } from "./snapshot";

const TAKE_AT = new Date("2026-10-27T09:00:00.000Z");

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(root: string, path: string, content: string | Buffer, mode?: number): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (mode !== undefined) chmodSync(abs, mode);
}

function projectionDir(): { root: string; dataDir: string; shadowDir: string } {
  const root = tempDir("echo-snap-work-");
  const dataDir = join(root, ".echo-data");
  return { root, dataDir, shadowDir: join(dataDir, "projects", "prj_1", "shadow.git") };
}

describe("snapshotWorkingTree", () => {
  it("captures redacted text, honors ignores, and records exclusions", async () => {
    const { root, dataDir, shadowDir } = projectionDir();
    write(root, "README.md", "hello\n");
    write(root, "src/index.ts", 'export const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz";\n');
    write(root, "script.sh", "#!/bin/sh\necho hi\n", 0o755);
    write(root, "node_modules/pkg/index.js", "ignored\n");
    write(root, "dist/bundle.js", "ignored\n");
    write(root, ".gitignore", "ignored.txt\n.env\n");
    write(root, "ignored.txt", "ignored\n");
    write(root, ".env", "SECRET=value\n");
    write(root, "assets/logo.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    write(root, "big.txt", "x".repeat(100));
    symlinkSync("README.md", join(root, "link.md"));
    write(root, ".echo-data/projects/prj_1/sessions/ses_1/tape.jsonl", "{}\n");

    const result = await snapshotWorkingTree({
      shadowDir,
      root,
      dataDir,
      sessionId: "ses_1",
      projectId: "prj_1",
      trigger: "baseline",
      eventId: "evt_snap_1",
      takenAt: TAKE_AT,
      limits: { maxFileBytes: 80 },
    });

    expect(result.commitOid).toMatch(/^[0-9a-f]{40}$/);
    expect(result.parentOid).toBeNull();
    expect(result.status).toBe("ok");
    expect(result.redactionFindings).toBe(1);

    const byPath = new Map(result.files.map((file) => [file.path, file]));
    expect(byPath.get("README.md")?.captured).toBe(true);
    expect(byPath.get("script.sh")?.mode).toBe("100755");
    expect(byPath.get("link.md")?.mode).toBe("120000");
    expect(byPath.has("node_modules/pkg/index.js")).toBe(false);
    expect(byPath.has("dist/bundle.js")).toBe(false);
    expect(byPath.has(".echo-data/projects/prj_1/sessions/ses_1/tape.jsonl")).toBe(false);
    expect(byPath.get(".env")).toMatchObject({ captured: false, reason: "ignored" });
    expect(byPath.get("ignored.txt")).toMatchObject({ captured: false, reason: "ignored" });
    expect(byPath.get("assets/logo.bin")).toMatchObject({ captured: false, reason: "binary" });
    expect(byPath.get("big.txt")).toMatchObject({ captured: false, reason: "too_large" });

    const sourceEntry = byPath.get("src/index.ts");
    expect(sourceEntry?.captured).toBe(true);
    const { blob } = await git.readBlob({
      fs,
      dir: shadowDir,
      gitdir: shadowDir,
      oid: sourceEntry?.blobOid as string,
    });
    const stored = Buffer.from(blob).toString("utf8");
    expect(stored).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(stored).toContain("[REDACTED:api-key-prefix:");

    const ref = await git.resolveRef({
      fs,
      dir: shadowDir,
      gitdir: shadowDir,
      ref: "refs/echo/sessions/ses_1",
    });
    expect(ref).toBe(result.commitOid);
    expect(loadManifest(shadowDir, "ses_1")?.commitOid).toBe(result.commitOid);
  });

  it("chains snapshots and reuses unchanged blobs", async () => {
    const { root, dataDir, shadowDir } = projectionDir();
    write(root, "a.txt", "one\n");
    write(root, "c.txt", "stable\n");

    const first = await snapshotWorkingTree({
      shadowDir,
      root,
      dataDir,
      sessionId: "ses_1",
      projectId: "prj_1",
      trigger: "baseline",
      eventId: "evt_snap_1",
      takenAt: TAKE_AT,
    });
    write(root, "a.txt", "two longer\n");
    write(root, "b.txt", "new\n");

    const second = await snapshotWorkingTree({
      shadowDir,
      root,
      dataDir,
      sessionId: "ses_1",
      projectId: "prj_1",
      trigger: "final",
      eventId: "evt_snap_2",
      takenAt: new Date("2026-10-27T09:01:00.000Z"),
    });

    expect(second.parentOid).toBe(first.commitOid);
    const firstFiles = new Map(first.files.map((file) => [file.path, file]));
    const secondFiles = new Map(second.files.map((file) => [file.path, file]));
    expect(secondFiles.get("c.txt")?.blobOid).toBe(firstFiles.get("c.txt")?.blobOid);
    expect(secondFiles.get("a.txt")?.blobOid).not.toBe(firstFiles.get("a.txt")?.blobOid);
    expect(secondFiles.get("b.txt")?.captured).toBe(true);

    const commit = await git.readCommit({
      fs,
      dir: shadowDir,
      gitdir: shadowDir,
      oid: second.commitOid,
    });
    expect(commit.commit.parent).toEqual([first.commitOid]);
    expect(commit.commit.message).toContain("echo ses_1 final evt_snap_2");
  });
});

async function makeSourceRepo(): Promise<{ root: string; commitOid: string; treeOid: string }> {
  const root = tempDir("echo-snap-source-");
  await git.init({ fs, dir: root });
  const signature = {
    name: "Tester",
    email: "tester@localhost",
    timestamp: 1793097340,
    timezoneOffset: 0,
  };
  const blob = await git.writeBlob({
    fs,
    dir: root,
    blob: Buffer.from('const key = "sk-abcdefghijklmnopqrstuvwxyz1234";\n'),
  });
  const subTree = await git.writeTree({
    fs,
    dir: root,
    tree: [{ mode: "100644", path: "app.ts", oid: blob, type: "blob" }],
  });
  const tree = await git.writeTree({
    fs,
    dir: root,
    tree: [{ mode: "040000", path: "src", oid: subTree, type: "tree" }],
  });
  const commitOid = await git.writeCommit({
    fs,
    dir: root,
    commit: { tree, parent: [], author: signature, committer: signature, message: "source" },
  });
  await git.writeRef({ fs, dir: root, ref: "refs/heads/main", value: commitOid, force: true });
  return { root, commitOid, treeOid: tree };
}

function listDir(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listDir(abs).map((child) => join(entry.name, child)));
    else out.push(entry.name);
  }
  return out.sort();
}

describe("snapshotGitTree", () => {
  it("reconstructs a source commit into the shadow repo without touching the source", async () => {
    const source = await makeSourceRepo();
    const { shadowDir } = projectionDir();
    const before = listDir(join(source.root, ".git"));
    const refBefore = await git.resolveRef({
      fs,
      dir: source.root,
      ref: "refs/heads/main",
    });

    const result = await snapshotGitTree({
      shadowDir,
      sessionId: "ses_1",
      projectId: "prj_1",
      trigger: "baseline",
      eventId: "evt_baseline",
      takenAt: TAKE_AT,
      sourceRoot: source.root,
      sourceOid: source.commitOid,
    });

    expect(result.fileCount).toBe(1);
    const app = result.files.find((file) => file.path === "src/app.ts");
    expect(app?.captured).toBe(true);
    const { blob } = await git.readBlob({
      fs,
      dir: shadowDir,
      gitdir: shadowDir,
      oid: app?.blobOid as string,
    });
    const stored = Buffer.from(blob).toString("utf8");
    expect(stored).toContain("[REDACTED:api-key-prefix:");
    expect(stored).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234");

    expect(listDir(join(source.root, ".git"))).toEqual(before);
    const refAfter = await git.resolveRef({ fs, dir: source.root, ref: "refs/heads/main" });
    expect(refAfter).toBe(refBefore);
  });

  it("accepts a bare tree oid as the source state", async () => {
    const source = await makeSourceRepo();
    const { shadowDir } = projectionDir();
    const result = await snapshotGitTree({
      shadowDir,
      sessionId: "ses_2",
      projectId: "prj_1",
      trigger: "baseline",
      eventId: "evt_tree",
      takenAt: TAKE_AT,
      sourceRoot: source.root,
      sourceOid: source.treeOid,
    });
    expect(result.fileCount).toBe(1);
    expect(result.files.map((file) => file.path)).toEqual(["src/app.ts"]);
  });

  it("reads captured blobs back out of the shadow repo", async () => {
    const { root, dataDir, shadowDir } = projectionDir();
    write(root, "README.md", "hello\n");

    const result = await snapshotWorkingTree({
      shadowDir,
      root,
      dataDir,
      sessionId: "ses_1",
      projectId: "prj_1",
      trigger: "baseline",
      eventId: "evt_snap_1",
      takenAt: TAKE_AT,
    });
    const entry = result.files.find((file) => file.path === "README.md");
    expect(entry?.blobOid).toMatch(/^[0-9a-f]{40}$/);

    const blob = await readShadowBlob(shadowDir, entry?.blobOid as string);
    expect(Buffer.from(blob).toString("utf8")).toBe("hello\n");
    await expect(readShadowBlob(shadowDir, "0".repeat(40))).rejects.toThrow();
  });

  it("fails loudly when the source commit is gone", async () => {
    const source = await makeSourceRepo();
    const { shadowDir } = projectionDir();
    await expect(
      snapshotGitTree({
        shadowDir,
        sessionId: "ses_1",
        projectId: "prj_1",
        trigger: "baseline",
        eventId: "evt_missing",
        sourceRoot: source.root,
        sourceOid: "0".repeat(40),
      }),
    ).rejects.toThrow();
  });
});
