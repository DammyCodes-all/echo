import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as dotenvConfig } from "dotenv";

/**
 * Dev convenience: pick up a `.env.local` walking up from the launch
 * directory (the daemon runs from `apps/server`, the file lives at the
 * repo root). Real environment variables always win — dotenv never
 * overrides them — and a missing file is fine.
 */
export function loadLocalEnv(
  startDir: string = process.cwd(),
  fileName = ".env.local",
): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 5; depth++) {
    const candidate = join(dir, fileName);
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate });
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
