import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ADAPTER_VERSION, getMuseVersion } from "@echo/capture-muse";
import { listBuildVersions, openEchoDb } from "@echo/db";

export interface DoctorInput {
  dataDir: string;
  projects: string[];
  museBin?: string;
  sessionsDir?: string;
  configFile?: string;
}

export interface DoctorReport {
  lines: string[];
  warnings: string[];
}

// Local copy of the sessions-dir default: the CLI must not import the
// server, and this is the only other place that needs it.
function defaultSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MUSE_SESSIONS_DIR) return env.MUSE_SESSIONS_DIR;
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "muse", "sessions");
}

// Read-only health check: never writes except opening the existing daemon
// DB (WAL readers don't block the writer). Exit stays 0 with warnings;
// only an unreadable config/data dir is a hard failure at the call site.
export function runDoctor(input: DoctorInput): DoctorReport {
  const lines: string[] = [];
  const warnings: string[] = [];
  const sessionsDir = input.sessionsDir ?? defaultSessionsDir();
  lines.push(
    `config: ${input.configFile ?? "(default)"} (${input.projects.length} project${input.projects.length === 1 ? "" : "s"} enabled)`,
  );
  for (const project of input.projects) lines.push(`  project: ${project}`);
  const version = getMuseVersion(input.museBin ?? "muse");
  if (version) {
    lines.push(`muse: ${version}`);
  } else {
    lines.push("muse: not found (native export reconciliation unavailable)");
    warnings.push(
      "muse binary missing or failing: live capture continues, export reconciliation is skipped",
    );
  }
  lines.push(
    `sessions dir: ${sessionsDir}${existsSync(sessionsDir) ? "" : " (missing — no native sessions seen yet)"}`,
  );
  lines.push(`adapter: muse-native ${ADAPTER_VERSION}`);
  const dbPath = join(input.dataDir, "echo.sqlite");
  if (!existsSync(dbPath)) {
    lines.push("database: none yet (daemon never ran)");
    return { lines, warnings };
  }
  const db = openEchoDb(dbPath);
  try {
    const builds = listBuildVersions(db, 5);
    if (builds.length === 0) {
      lines.push("build pins: none recorded yet");
    } else {
      lines.push("build pins:");
      for (const build of builds) {
        lines.push(
          `  ${build.museVersion ?? "(unknown)"}: ${build.sessions} session${build.sessions === 1 ? "" : "s"}, last ${build.lastObserved}`,
        );
      }
      if (version && !builds.some((build) => build.museVersion === version)) {
        warnings.push(
          `build drift: installed "${version}" matches no pinned session build — expect partial quality until re-observed`,
        );
      }
    }
  } finally {
    db.close();
  }
  return { lines, warnings };
}
