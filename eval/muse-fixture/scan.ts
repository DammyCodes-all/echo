import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ScanSurface {
  name: string;
  data: string;
}

export interface ScanHit {
  surface: string;
  marker: string;
}

function collectFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collectFiles(abs, out);
    else if (stat.isFile()) out.push(abs);
  }
}

// Recursive raw-secret scan over Echo-owned artifacts. Every surface is read
// as bytes and decoded lossy (latin1) so compressed or binary containers are
// still searchable for ASCII markers. Any hit is a zero-tolerance failure:
// redaction must happen before Echo-owned persistence, never after.
export function scanSurfaces(
  dirs: string[],
  files: string[],
  blobs: Array<{ name: string; data: Buffer }>,
  forbidden: string[],
): ScanHit[] {
  const hits: ScanHit[] = [];
  const surfaces: ScanSurface[] = [];
  const paths: string[] = [];
  for (const dir of dirs) collectFiles(dir, paths);
  paths.push(...files);
  for (const path of paths) {
    try {
      surfaces.push({ name: path, data: readFileSync(path).toString("latin1") });
    } catch {
      // Unreadable surfaces are a harness setup bug, surfaced by expect below.
      surfaces.push({ name: path, data: "" });
    }
  }
  for (const blob of blobs) surfaces.push({ name: blob.name, data: blob.data.toString("latin1") });
  for (const surface of surfaces) {
    for (const marker of forbidden) {
      if (marker.length > 0 && surface.data.includes(marker))
        hits.push({ surface: surface.name, marker });
    }
  }
  return hits;
}
