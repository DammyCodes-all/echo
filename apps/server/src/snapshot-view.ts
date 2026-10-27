import { join } from "node:path";
import type { SnapshotFileContent } from "@echo/contracts";
import { type EchoDb, getSession, getSnapshotByCommit, listSnapshotFiles } from "@echo/db";
import { readShadowBlob } from "@echo/snapshots";

export const MAX_SERVED_BLOB_BYTES = 256 * 1024;

export type SnapshotFileOutcome =
  | { ok: true; content: SnapshotFileContent }
  | { ok: false; code: "invalid_request" | "not_found"; message: string };

function validPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || path.startsWith("./")) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

const strict = new TextDecoder("utf-8", { fatal: true });
const lossy = new TextDecoder("utf-8");

function preview(value: string): string {
  return value.slice(0, 80);
}

export async function readSnapshotFile(
  db: EchoDb,
  dataDir: string,
  sessionId: string,
  commitOid: string,
  path: string,
): Promise<SnapshotFileOutcome> {
  if (!validPath(path)) {
    return { ok: false, code: "invalid_request", message: `invalid path: ${preview(path)}` };
  }
  const session = getSession(db, sessionId);
  if (!session) {
    return { ok: false, code: "not_found", message: `unknown session: ${preview(sessionId)}` };
  }
  const snapshot = getSnapshotByCommit(db, sessionId, commitOid);
  if (!snapshot) {
    return {
      ok: false,
      code: "not_found",
      message: `unknown snapshot: ${preview(commitOid)}`,
    };
  }
  const entry = listSnapshotFiles(db, snapshot.id).find((file) => file.path === path);
  if (!entry) {
    return { ok: false, code: "not_found", message: `path not in snapshot: ${preview(path)}` };
  }
  if (!entry.captured || entry.blobOid === null) {
    return {
      ok: false,
      code: "not_found",
      message: `file not captured: ${entry.reason ?? "unknown"}`,
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readShadowBlob(
      join(dataDir, "projects", session.projectId, "shadow.git"),
      entry.blobOid,
    );
  } catch {
    return { ok: false, code: "not_found", message: "blob missing from shadow repo" };
  }
  if (bytes.byteLength > MAX_SERVED_BLOB_BYTES) {
    return {
      ok: true,
      content: {
        path,
        blobOid: entry.blobOid,
        size: bytes.byteLength,
        truncated: true,
        content: lossy.decode(bytes.subarray(0, MAX_SERVED_BLOB_BYTES)),
      },
    };
  }
  let content: string;
  try {
    content = strict.decode(bytes);
  } catch {
    return { ok: false, code: "not_found", message: "blob is not valid text" };
  }
  return {
    ok: true,
    content: { path, blobOid: entry.blobOid, size: bytes.byteLength, truncated: false, content },
  };
}
