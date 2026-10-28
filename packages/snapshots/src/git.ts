import { spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type RepositoryIdentity, repositoryIdentityFor } from "@echo/core";
import git from "isomorphic-git";

export interface RepoHandle {
  dir: string;
  gitdir: string;
  sessionRef: string;
  latestRef: string;
}

export type GitMode = "100644" | "100755" | "120000";

export interface BlobLeaf {
  path: string;
  mode: GitMode;
  oid: string;
}

export function normalizeGitMode(mode: string): GitMode {
  return mode === "100755" ? "100755" : mode === "120000" ? "120000" : "100644";
}

export async function openShadowRepo(
  shadowDir: string,
  sessionId: string,
  projectId: string,
): Promise<RepoHandle> {
  if (!existsSync(join(shadowDir, "HEAD"))) {
    mkdirSync(shadowDir, { recursive: true });
    await git.init({ fs, dir: shadowDir, bare: true, defaultBranch: "echo" });
  }
  return {
    dir: shadowDir,
    gitdir: shadowDir,
    sessionRef: `refs/echo/sessions/${sessionId}`,
    latestRef: `refs/echo/projects/${projectId}/latest`,
  };
}

export async function writeBlob(repo: RepoHandle, content: Uint8Array): Promise<string> {
  return git.writeBlob({ fs, dir: repo.dir, gitdir: repo.gitdir, blob: content });
}

interface TreeNode {
  leaf: BlobLeaf | null;
  children: Map<string, TreeNode>;
}

function newNode(): TreeNode {
  return { leaf: null, children: new Map() };
}

function gitTreeCompare(a: TreeEntries[number], b: TreeEntries[number]): number {
  const left = Buffer.from(a.type === "tree" ? `${a.path}/` : a.path);
  const right = Buffer.from(b.type === "tree" ? `${b.path}/` : b.path);
  return Buffer.compare(left, right);
}

type TreeEntries = Parameters<typeof git.writeTree>[0]["tree"];

async function writeNode(repo: RepoHandle, node: TreeNode): Promise<string> {
  const entries: TreeEntries = [];
  for (const [name, child] of node.children) {
    if (child.leaf) {
      entries.push({ mode: child.leaf.mode, path: name, oid: child.leaf.oid, type: "blob" });
    } else {
      entries.push({
        mode: "040000" as TreeEntries[number]["mode"],
        path: name,
        oid: await writeNode(repo, child),
        type: "tree",
      });
    }
  }
  entries.sort(gitTreeCompare);
  return git.writeTree({ fs, dir: repo.dir, gitdir: repo.gitdir, tree: entries });
}

export async function writeTreeFromFiles(repo: RepoHandle, files: BlobLeaf[]): Promise<string> {
  const root = newNode();
  for (const file of files) {
    const segments = file.path.split("/");
    if (segments.some((segment) => segment.length === 0)) {
      throw new Error(`invalid snapshot path: ${file.path}`);
    }
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.children.get(segment);
      if (!child) {
        child = newNode();
        node.children.set(segment, child);
      }
      if (child.leaf) throw new Error(`snapshot path collides with a file: ${file.path}`);
      node = child;
    }
    const name = segments[segments.length - 1] as string;
    if (node.children.has(name)) {
      throw new Error(`snapshot path collides with a directory: ${file.path}`);
    }
    node.children.set(name, { leaf: file, children: new Map() });
  }
  return writeNode(repo, root);
}

export async function resolveSessionHead(repo: RepoHandle): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir: repo.dir, gitdir: repo.gitdir, ref: repo.sessionRef });
  } catch {
    return null;
  }
}

export async function writeCommit(
  repo: RepoHandle,
  input: {
    tree: string;
    parent: string | null;
    message: string;
    takenAt: Date;
  },
): Promise<string> {
  const timestamp = Math.floor(input.takenAt.getTime() / 1000);
  const signature = {
    name: "Echo",
    email: "echo@localhost",
    timestamp,
    timezoneOffset: 0,
  };
  return git.writeCommit({
    fs,
    dir: repo.dir,
    gitdir: repo.gitdir,
    commit: {
      tree: input.tree,
      parent: input.parent ? [input.parent] : [],
      author: signature,
      committer: signature,
      message: input.message,
    },
  });
}

export async function pointRefs(repo: RepoHandle, commitOid: string): Promise<void> {
  await git.writeRef({
    fs,
    dir: repo.dir,
    gitdir: repo.gitdir,
    ref: repo.sessionRef,
    value: commitOid,
    force: true,
  });
  await git.writeRef({
    fs,
    dir: repo.dir,
    gitdir: repo.gitdir,
    ref: repo.latestRef,
    value: commitOid,
    force: true,
  });
}

export function findRepositoryRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function readOriginRemote(root: string): Promise<string | null> {
  try {
    const remote = await git.getConfig({ fs, dir: root, path: "remote.origin.url" });
    return typeof remote === "string" ? remote : null;
  } catch {
    // No registered remote (or an unreadable config) is a normal fallback to
    // root identity, not a capture failure.
    return null;
  }
}

/**
 * Resolve the canonical Echo repository identity for any working directory.
 * Git discovery runs before hashing, so a session started in a subdirectory
 * joins the repository project; the registered remote keeps the same project
 * when its folder moves.
 */
export async function resolveRepositoryIdentity(
  startDir: string,
  remoteOverride?: string | null,
): Promise<RepositoryIdentity> {
  const discovered = findRepositoryRoot(startDir);
  const fallbackRoot = resolve(discovered ?? startDir);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(fallbackRoot);
  } catch {
    canonicalRoot = fallbackRoot;
  }
  const remoteUrl = remoteOverride ?? (discovered ? await readOriginRemote(discovered) : null);
  return repositoryIdentityFor({ directory: startDir, canonicalRoot, remoteUrl });
}

export function resolveSourceGitDir(root: string): string {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit)) throw new Error(`not a git repository: ${root}`);
  if (!statSync(dotGit).isFile()) return dotGit;
  const content = readFileSync(dotGit, "utf8");
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  if (!match?.[1]) throw new Error(`unreadable gitdir pointer in ${dotGit}`);
  return resolve(dirname(dotGit), match[1].trim());
}

export interface SourceBlob {
  path: string;
  mode: string;
  oid: string;
}

export interface SourceTree {
  sourceOid: string;
  blobs: SourceBlob[];
  submodules: string[];
}

export async function readSourceTree(root: string, sourceOid: string): Promise<SourceTree> {
  const gitdir = resolveSourceGitDir(root);
  const blobs: SourceBlob[] = [];
  const submodules: string[] = [];

  const object = await git.readObject({ fs, dir: root, gitdir, oid: sourceOid });
  let rootTreeOid: string;
  if (object.type === "commit") {
    const commit = await git.readCommit({ fs, dir: root, gitdir, oid: sourceOid });
    rootTreeOid = commit.commit.tree;
  } else if (object.type === "tree") {
    rootTreeOid = sourceOid;
  } else {
    throw new Error(`source object ${sourceOid} is a ${object.type}; expected a commit or tree`);
  }

  async function walk(treeOid: string, prefix: string): Promise<void> {
    const { tree } = await git.readTree({
      fs,
      dir: root,
      gitdir,
      oid: treeOid,
    });
    for (const entry of tree) {
      const path = prefix.length === 0 ? entry.path : `${prefix}/${entry.path}`;
      if (entry.type === "tree") {
        await walk(entry.oid, path);
      } else if (entry.type === "commit") {
        submodules.push(path);
      } else {
        blobs.push({ path, mode: entry.mode, oid: entry.oid });
      }
    }
  }

  await walk(rootTreeOid, "");
  return { sourceOid, blobs, submodules };
}

export async function readSourceBlob(root: string, oid: string): Promise<Uint8Array> {
  const gitdir = resolveSourceGitDir(root);
  const { blob } = await git.readBlob({ fs, dir: root, gitdir, oid });
  return blob;
}

export async function readShadowBlob(shadowDir: string, oid: string): Promise<Uint8Array> {
  const { blob } = await git.readBlob({ fs, dir: shadowDir, gitdir: shadowDir, oid });
  return blob;
}

const DIFF_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CEILING_DIRECTORIES: "/",
  GIT_OPTIONAL_LOCKS: "0",
  TZ: "UTC",
  LANG: "C",
  NODE_OPTIONS: "",
};

/**
 * Unified diff between two shadow commits for one path. Git is the
 * line-mapping authority; callers parse the returned diff rather than
 * reimplementing diff alignment.
 */
export function diffShadowCommits(
  shadowDir: string,
  oldOid: string,
  newOid: string,
  path: string,
  context = 3,
): string {
  if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) {
    throw new Error("shadow diff needs two full commit oids");
  }
  if (path.length === 0 || path.length > 1024) throw new Error(`invalid snapshot path: ${path}`);
  const result = spawnSync(
    "git",
    [
      "--git-dir",
      shadowDir,
      "diff",
      "--no-color",
      "--no-ext-diff",
      `--unified=${context}`,
      oldOid,
      newOid,
      "--",
      path,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...DIFF_ENV },
    },
  );
  if (result.error) throw result.error;
  // Git exits 1 when the two commits differ; only other statuses are errors.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`shadow diff failed: ${String(result.stderr).slice(0, 500)}`);
  }
  return result.stdout ?? "";
}
