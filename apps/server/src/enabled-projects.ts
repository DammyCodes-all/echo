import { existsSync } from "node:fs";
import { basename } from "node:path";
import { type EchoDb, upsertProject } from "@echo/db";
import { resolveRepositoryIdentity } from "@echo/snapshots";

type ErrorLog = { error: (obj: unknown, message?: string) => void };

/**
 * Materialize the enabled-repos allowlist as project rows so a repo with no
 * sessions yet still renders its folder (with an empty state) instead of
 * looking broken. Idempotent: `upsertProject` reuses the canonical row per
 * root/remote, so repeats never duplicate or split. Missing roots are
 * skipped silently — a typo must not mint a phantom project.
 */
export async function ensureEnabledProjects(
  db: EchoDb,
  roots: string[],
  log?: ErrorLog,
): Promise<string[]> {
  const ids: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const identity = await resolveRepositoryIdentity(root);
      ids.push(
        upsertProject(db, {
          id: identity.projectId,
          root: identity.canonicalRoot,
          remoteUrl: identity.remoteUrl,
          name: basename(identity.canonicalRoot),
        }),
      );
    } catch (error) {
      log?.error({ err: String(error), root }, "enabled project identity failed");
    }
  }
  return ids;
}
