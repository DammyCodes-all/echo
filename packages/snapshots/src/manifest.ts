import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ManifestEntry {
  path: string;
  mode: string | null;
  size: number;
  mtimeNs: string;
  sha256: string | null;
  blobOid: string | null;
  captured: boolean;
  reason: string | null;
}

export interface SnapshotManifest {
  version: 1;
  sessionId: string;
  commitOid: string | null;
  takenAt: string;
  files: Record<string, ManifestEntry>;
}

function manifestPath(shadowDir: string, sessionId: string): string {
  return join(dirname(shadowDir), "manifests", `${sessionId}.json`);
}

export function loadManifest(shadowDir: string, sessionId: string): SnapshotManifest | null {
  const path = manifestPath(shadowDir, sessionId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SnapshotManifest;
    return parsed.version === 1 && parsed.sessionId === sessionId ? parsed : null;
  } catch {
    return null;
  }
}

export function saveManifest(shadowDir: string, manifest: SnapshotManifest): void {
  const path = manifestPath(shadowDir, manifest.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(manifest), { mode: 0o600 });
  renameSync(temp, path);
}
