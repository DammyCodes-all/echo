import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

const DEFAULT_IGNORES = [
  ".git/",
  "node_modules/",
  ".venv/",
  "venv/",
  "target/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  ".output/",
  ".turbo/",
  ".parcel-cache/",
  ".cache/",
  "coverage/",
  ".nyc_output/",
];

export interface WalkFile {
  path: string;
  absPath: string;
  mode: string;
  size: number;
  mtimeNs: string;
  symlink: boolean;
  linkTarget: string | null;
}

export interface WalkMetadata {
  path: string;
  size: number;
  mtimeNs: string;
  reason: string;
}

export interface WalkResult {
  files: WalkFile[];
  metadata: WalkMetadata[];
}

export interface WalkOptions {
  root: string;
  excludeDirs?: string[];
  extraPatterns?: string[];
}

interface IgnoreFrame {
  baseRel: string;
  matcher: Ignore;
}

function isUnder(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + sep);
}

function readGitignore(dir: string): Ignore | null {
  let content: string;
  try {
    content = readFileSync(join(dir, ".gitignore"), "utf8");
  } catch {
    return null;
  }
  const matcher = ignore();
  matcher.add(content);
  return matcher;
}

function ignored(frames: IgnoreFrame[], defaults: Ignore, path: string, isDir: boolean): boolean {
  const probe = isDir ? `${path}/` : path;
  if (defaults.ignores(probe)) return true;
  for (const frame of frames) {
    if (frame.baseRel.length > 0 && !path.startsWith(`${frame.baseRel}/`)) continue;
    const relativePath = frame.baseRel.length === 0 ? path : path.slice(frame.baseRel.length + 1);
    if (relativePath.length === 0) continue;
    if (frame.matcher.ignores(isDir ? `${relativePath}/` : relativePath)) return true;
  }
  return false;
}

export function walkWorkingTree(options: WalkOptions): WalkResult {
  const root = resolve(options.root);
  const excludeDirs = (options.excludeDirs ?? []).map((dir) => resolve(dir));
  const defaults = ignore();
  defaults.add(DEFAULT_IGNORES);
  if (options.extraPatterns && options.extraPatterns.length > 0) {
    defaults.add(options.extraPatterns);
  }

  const files: WalkFile[] = [];
  const metadata: WalkMetadata[] = [];

  function excluded(absPath: string): boolean {
    return excludeDirs.some((dir) => isUnder(absPath, dir));
  }

  function visit(dirAbs: string, baseRel: string, frames: IgnoreFrame[]): void {
    const localIgnore = readGitignore(dirAbs);
    const nextFrames = localIgnore ? [...frames, { baseRel, matcher: localIgnore }] : frames;
    const entries = readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    if (baseRel.length > 0 && entries.some((entry) => entry.name === ".git")) return;

    for (const entry of entries) {
      const absPath = join(dirAbs, entry.name);
      const relativePath = baseRel.length === 0 ? entry.name : `${baseRel}/${entry.name}`;
      if (excluded(absPath)) continue;
      const stat = lstatSync(absPath, { bigint: true });
      const size = Number(stat.size);
      const mtimeNs = stat.mtimeNs.toString();

      if (stat.isDirectory()) {
        if (ignored(nextFrames, defaults, relativePath, true)) continue;
        visit(absPath, relativePath, nextFrames);
        continue;
      }

      if (stat.isSymbolicLink()) {
        const target = readlinkSync(absPath);
        const targetPath = isAbsolute(target) ? resolve(target) : resolve(dirname(absPath), target);
        if (!isUnder(targetPath, root)) {
          metadata.push({ path: relativePath, size, mtimeNs, reason: "symlink_outside" });
          continue;
        }
        files.push({
          path: relativePath,
          absPath,
          mode: "120000",
          size: Buffer.byteLength(target),
          mtimeNs,
          symlink: true,
          linkTarget: target,
        });
        continue;
      }

      if (stat.isFile()) {
        if (ignored(nextFrames, defaults, relativePath, false)) {
          metadata.push({ path: relativePath, size, mtimeNs, reason: "ignored" });
          continue;
        }
        const executable = (stat.mode & 0o111n) !== 0n;
        files.push({
          path: relativePath,
          absPath,
          mode: executable ? "100755" : "100644",
          size,
          mtimeNs,
          symlink: false,
          linkTarget: null,
        });
        continue;
      }

      metadata.push({ path: relativePath, size, mtimeNs, reason: "not_regular_file" });
    }
  }

  visit(root, "", []);
  return { files, metadata };
}
