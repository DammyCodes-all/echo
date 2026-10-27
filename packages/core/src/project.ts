import { createHash } from "node:crypto";

// Canonical Echo project identity: prj_ + first 16 hex chars of the
// sha256 of the directory. Both capture adapters use this so session rows
// join across agents for the same repo. Hash identical inputs identically;
// different inputs (e.g. a subdirectory cwd vs the repo root) intentionally
// yield different ids.
export function projectIdForDirectory(directory: string): string {
  return `prj_${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`;
}
